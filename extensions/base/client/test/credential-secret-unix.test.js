import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import { connect, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('fragmented credential rotation failure never echoes secret bytes and reconnect stays explicit', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-credential-'));
  const socketPath = path.join(directory, 'host.sock');
  const secret = new TextEncoder().encode('database-password-sentinel');
  let connection = 0;
  const server = net.createServer((socket) => {
    connection += 1;
    const current = connection;
    const greeting = encode({
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'database',
        granted: ['credentials:read', 'credentials:write'],
        credentials:
          current === 1
            ? { read: [], write: ['postgres.password', 'retired.password'], inject: [] }
            : { read: ['postgres.password'], write: [], inject: [] },
      },
    });
    for (const byte of greeting) socket.write(Uint8Array.of(byte));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        if (current === 1) {
          assert.equal(frame.payload.call, 'credential_set');
          assert.deepEqual(frame.payload.with.value, [...secret]);
          socket.destroy();
          continue;
        }
        assert.deepEqual(frame.payload, {
          call: 'credential_read',
          with: { key: 'postgres.password' },
        });
        const reply = encode({
          channel: frame.channel,
          kind: KIND.response,
          payload: {
            reply: 'credential',
            with: { key: 'postgres.password', revision: 8, value: [...secret] },
          },
        });
        for (let offset = 0; offset < reply.length; offset += 2)
          socket.write(reply.subarray(offset, offset + 2));
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath, timeout: 1_000 });
    assert.equal(workspace(first).credentials.keyGrant('write', 'retired.password'), true);
    const failed = await workspace(first)
      .credentials.set(7, 'postgres.password', secret)
      .catch((error) => error);
    assert(failed instanceof Error);
    assert(!failed.message.includes('database-password-sentinel'));

    const reconnected = await connect({ path: socketPath, timeout: 1_000 });
    assert.equal(workspace(reconnected).credentials.keyGrant('write', 'retired.password'), false);
    assert.equal(workspace(reconnected).credentials.keyGrant('write', 'postgres.password'), false);
    assert.equal(workspace(reconnected).credentials.keyGrant('read', 'postgres.password'), true);
    const observed = await workspace(reconnected).credentials.read('postgres.password');
    assert.equal(observed.revision, 8);
    assert.deepEqual(observed.value, [...secret]);
    await reconnected.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
