import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import { PostgresCloseOperationError, connect, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('PostgreSQL cleanup tokens survive fragmented reply loss and reconnect', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-postgres-close-'));
  const socketPath = path.join(directory, 'host.sock');
  const connections = new Set();
  const accepted = new Set();
  const seen = [];
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        const call = frame.payload.call;
        if (call !== 'postgres_query_close_once' && call !== 'postgres_lease_close_once') continue;
        const operation = frame.payload.with.operation;
        seen.push({ call, operation });
        if (!accepted.has(operation)) {
          accepted.add(operation);
          socket.destroy(); // Cleanup committed; every acknowledgement byte was lost.
          continue;
        }
        const bytes = encode({
          channel: frame.channel,
          kind: KIND.response,
          payload: { reply: 'done' },
        });
        for (const byte of bytes) socket.write(Uint8Array.of(byte));
      }
    });
    socket.write(
      encode({
        channel: CONTROL,
        kind: KIND.open,
        payload: { protocol: 1, peer: 'postgres-close-recovery', granted: ['postgres:read'] },
      }),
    );
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  let session;
  const reconnect = async () => {
    await session?.close().catch(() => {});
    session = await connect({ path: socketPath });
    return workspace(session);
  };
  try {
    let host = await reconnect();
    let queryFailure;
    await assert.rejects(host.postgres.closeQueryRecoverable('lease-a', 'query-a'), (error) => {
      assert(error instanceof PostgresCloseOperationError);
      queryFailure = JSON.parse(JSON.stringify(error.recovery));
      return true;
    });
    host = await reconnect();
    assert.equal((await host.postgres.recoverClose(queryFailure)).closed, true);

    let leaseFailure;
    await assert.rejects(host.postgres.closeLeaseRecoverable('lease-a'), (error) => {
      assert(error instanceof PostgresCloseOperationError);
      leaseFailure = JSON.parse(JSON.stringify(error.recovery));
      return true;
    });
    host = await reconnect();
    assert.equal((await host.postgres.recoverClose(leaseFailure)).closed, true);

    assert.equal(accepted.size, 2);
    assert.deepEqual(seen, [
      { call: 'postgres_query_close_once', operation: queryFailure.operation },
      { call: 'postgres_query_close_once', operation: queryFailure.operation },
      { call: 'postgres_lease_close_once', operation: leaseFailure.operation },
      { call: 'postgres_lease_close_once', operation: leaseFailure.operation },
    ]);
  } finally {
    await session?.close().catch(() => {});
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
