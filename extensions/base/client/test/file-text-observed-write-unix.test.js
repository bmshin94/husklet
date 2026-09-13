import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import { connect, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('path-bearing text observation cannot be redirected before its fragmented CAS write', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-file-text-write-'));
  const socketPath = path.join(directory, 'host.sock');
  const connections = new Set();
  const calls = [];
  const identity = `sha256:${'a'.repeat(64)}`;
  const sendFragmented = (socket, frame) => {
    for (const byte of encode(frame)) socket.write(Uint8Array.of(byte));
  };
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        calls.push(frame.payload);
        const payload =
          frame.payload.call === 'filesystem_read_range'
            ? {
                reply: 'file_range',
                with: {
                  path: 'src/approved.ts',
                  identity,
                  offset: 0,
                  total: 3,
                  contents: [111, 108, 100],
                  eof: true,
                  truncated: false,
                },
              }
            : { reply: 'identity', with: `sha256:${'b'.repeat(64)}` };
        sendFragmented(socket, { channel: frame.channel, kind: KIND.response, payload });
      }
    });
    sendFragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'file-text-write',
        granted: ['filesystem:read', 'filesystem:write'],
        filesystem: {
          read: [{ exact: 'src/approved.ts' }],
          write: [{ exact: 'src/approved.ts' }],
          create: [],
          delete: [],
          rename: [],
        },
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const session = await connect({ path: socketPath });
    const host = workspace(session);
    const observed = await host.files.readText('src/approved.ts', { maxBytes: 16 });
    assert.equal(observed.path, 'src/approved.ts');
    assert(Object.isFrozen(observed));
    assert.throws(() => {
      observed.path = 'src/unapproved.ts';
    }, TypeError);
    const written = await host.files.writeTextObserved(observed, 'new');
    assert.equal(written, `sha256:${'b'.repeat(64)}`);
    assert.deepEqual(calls.at(-1), {
      call: 'filesystem_write_observed',
      with: {
        path: 'src/approved.ts',
        observed: identity,
        contents: [110, 101, 119],
      },
    });
    await session.close();
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
