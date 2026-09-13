import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import { connect, ExtensionRemoveOperationError, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('lost removal reply reconciles replacement identity without replay over fragmented Unix frames', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-extension-remove-'));
  const socketPath = path.join(directory, 'host.sock');
  const removedDigest = `sha256:${'a'.repeat(64)}`;
  const replacement = {
    name: 'catalogue-tool',
    image_digest: `sha256:${'b'.repeat(64)}`,
    version: '3',
    status: 'duty',
    enabled: true,
    pane_providers: [],
  };
  const sockets = new Set();
  const calls = [];
  let connection = 0;
  let published = [replacement];
  const fragmented = (socket, frame) => {
    for (const byte of encode(frame)) socket.write(Uint8Array.of(byte));
  };
  const server = net.createServer((socket) => {
    const current = ++connection;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        calls.push({ connection: current, call: frame.payload.call });
        if (frame.payload.call === 'extension_remove') {
          assert.deepEqual(frame.payload.with, {
            name: 'catalogue-tool',
            image_digest: removedDigest,
          });
          socket.destroy();
        } else if (frame.payload.call === 'extension_list') {
          fragmented(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: { reply: 'extensions', with: published },
          });
        } else {
          fragmented(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: { reply: 'done' },
          });
        }
      }
    });
    fragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: `remove-${current}`,
        granted: ['extensions:read', 'extensions:remove'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath });
    let failure;
    await assert.rejects(
      workspace(first).extensions.removeAndWait('catalogue-tool', removedDigest),
      (error) => {
        assert(error instanceof ExtensionRemoveOperationError, `${error?.name}: ${error?.message}`);
        assert.equal(error.extensionName, 'catalogue-tool');
        assert.equal(error.imageDigest, removedDigest);
        failure = error;
        return true;
      },
    );
    await first.close();

    const second = await connect({ path: socketPath });
    assert.deepEqual(await workspace(second).extensions.recoverRemoval(failure), {
      removed: { name: 'catalogue-tool', image_digest: removedDigest },
      replacement,
    });
    assert.equal(
      calls.filter(({ call }) => call === 'extension_remove').length,
      1,
      'recovery never repeats a destructive call',
    );
    await second.close();

    published = [{ ...replacement, image_digest: removedDigest }];
    const third = await connect({ path: socketPath });
    await assert.rejects(
      workspace(third).extensions.recoverRemoval(failure),
      /is still installed; removal outcome is unresolved/,
    );
    assert.equal(calls.filter(({ call }) => call === 'extension_remove').length, 1);
    await third.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
