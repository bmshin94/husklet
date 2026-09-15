import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { connect, PostgresCancelOperationError, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

function fragmented(socket, frame) {
  for (const byte of encode(frame)) socket.write(Uint8Array.of(byte));
}

test('committed Postgres cancellation retains exact recovery authority across fragmented Unix reconnect', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-postgres-cancel-recovery-'));
  const socketPath = path.join(directory, 'host.sock');
  const peers = new Set();
  const requests = [];
  let connections = 0;
  const server = net.createServer((socket) => {
    const connection = ++connections;
    peers.add(socket);
    socket.on('close', () => peers.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        requests.push(frame.payload);
        if (connection === 1) {
          socket.destroy();
          continue;
        }
        fragmented(socket, {
          channel: frame.channel,
          kind: KIND.response,
          payload: {
            reply: 'postgres_state',
            with: { lease: 'lease-7', query: 'query-9', state: 'cancelled' },
          },
        });
      }
    });
    fragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: { protocol: 1, peer: `cancel-recovery-${connection}`, granted: ['postgres:read'] },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  try {
    const first = await connect({ path: socketPath });
    let failure;
    await assert.rejects(
      workspace(first).postgres.cancelRecoverable('lease-7', 'query-9'),
      (error) => {
        failure = error;
        return (
          error instanceof PostgresCancelOperationError &&
          error.recovery.lease === 'lease-7' &&
          error.recovery.query === 'query-9'
        );
      },
    );

    const resumed = await connect({ path: socketPath });
    assert.deepEqual(await workspace(resumed).postgres.recoverCancel(failure), {
      version: 1,
      lease: 'lease-7',
      query: 'query-9',
      state: 'cancelled',
    });
    assert.deepEqual(requests, [
      { call: 'postgres_query_cancel', with: { lease: 'lease-7', query: 'query-9' } },
      { call: 'postgres_query_cancel', with: { lease: 'lease-7', query: 'query-9' } },
    ]);
    await assert.rejects(
      workspace(resumed).postgres.recoverCancel({ version: 2, lease: 'other', query: 'other' }),
      /version 1/,
    );
    assert.equal(requests.length, 2, 'invalid recovery authority never reaches the socket');
    await resumed.close();
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
