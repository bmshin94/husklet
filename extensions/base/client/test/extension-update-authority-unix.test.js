import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { connect, ExtensionError } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('install-only authority cannot send an extension update over Unix transport', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-extension-update-authority-'));
  const socketPath = path.join(directory, 'host.sock');
  const requests = [];
  const peers = new Set();
  const server = net.createServer((socket) => {
    peers.add(socket);
    socket.on('close', () => peers.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        requests.push(frame.payload);
        socket.write(
          encode({
            channel: frame.channel,
            kind: KIND.response,
            payload: {
              reply: 'extension',
              with: {
                name: 'replacement',
                image_digest: `sha256:${'a'.repeat(64)}`,
                status: 'duty',
              },
            },
          }),
        );
      }
    });
    socket.write(
      encode({
        channel: CONTROL,
        kind: KIND.open,
        payload: {
          protocol: 1,
          extension: 'installer',
          granted: ['extensions:install'],
        },
      }),
    );
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  try {
    const session = await connect({ path: socketPath });
    await assert.rejects(
      session.call('extension_update', {
        job: 'job-1',
        revision: 7,
        image_digest: `sha256:${'a'.repeat(64)}`,
        granted: [],
        containers: { selectors: [], create: false },
        images: { read: [], use: [], pull: [], remove: [], prune_all_unused: false },
        networks: { selectors: [], create: false },
        volumes: { selectors: [], create: false },
        filesystem: { read: [], write: [], create: [], delete: [], rename: [] },
        workspace_environment: { read: [], write: [] },
        credentials: { read: [], write: [], expose_to_execution: [], use: [] },
      }),
      (error) =>
        error instanceof ExtensionError &&
        error.kind === 'denied' &&
        error.capability === 'extensions:update',
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(requests, [], 'the denied mutation must not reach the Unix socket');
    await session.close();
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
