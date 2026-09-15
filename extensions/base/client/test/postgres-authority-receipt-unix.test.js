import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { connect, PostgresOperationProtocolError, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

const openOperation = 'open-operation';
const queryOperation = 'query-operation';
const lease = 'lease-authorized';
const queryId = 'query-authorized';
const connection = {
  container_id: 'a'.repeat(64),
  container_generation: 7,
  network: 'database',
  port: 5432,
  database: 'app',
  user: 'reader',
  credential_keys: ['postgres.password'],
};
const query = {
  operation: queryOperation,
  statement: 'select * from events order by id',
  page_rows: 250,
  page_bytes: 512 * 1024,
};

function fragmented(socket, payload) {
  const bytes = encode(payload);
  for (const byte of bytes) socket.write(Uint8Array.of(byte));
}

test('Postgres authority receipts recover lost replies and reject a stale target over fragmented Unix', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-postgres-authority-'));
  const socketPath = path.join(directory, 'host.sock');
  const peers = new Set();
  const requests = [];
  let openCalls = 0;
  let startCalls = 0;
  const server = net.createServer((socket) => {
    peers.add(socket);
    socket.on('close', () => peers.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        requests.push(frame.payload);
        if (frame.payload.call === 'postgres_open_once') {
          openCalls += 1;
          if (openCalls === 1) {
            socket.destroy();
            continue;
          }
          fragmented(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: {
              reply: 'postgres_open',
              with: {
                disposition: openCalls === 2 ? 'reconciled' : 'opened',
                operation: openCalls === 2 ? openOperation : 'stale-operation',
                lease,
              },
            },
          });
        } else if (frame.payload.call === 'postgres_query_start_once') {
          startCalls += 1;
          if (startCalls === 1) {
            socket.destroy();
            continue;
          }
          fragmented(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: {
              reply: 'postgres_start',
              with: {
                disposition: 'reconciled',
                operation: queryOperation,
                lease,
                query: queryId,
                state: 'running',
              },
            },
          });
        }
      }
    });
    fragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        extension: 'postgres-authority-recovery',
        granted: ['credentials:use', 'postgres:read', 'postgres:write'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  try {
    const first = await connect({ path: socketPath });
    await assert.rejects(workspace(first).postgres.openOnce(openOperation, connection));
    await first.close();

    const second = await connect({ path: socketPath });
    const opened = await workspace(second).postgres.openOnce(openOperation, connection);
    assert.equal(opened.lease, lease);
    await assert.rejects(workspace(second).postgres.startOnce(lease, query));
    await second.close();

    const third = await connect({ path: socketPath });
    const started = await workspace(third).postgres.startOnce(lease, query);
    assert.equal(started.query, queryId);
    await assert.rejects(
      workspace(third).postgres.openOnce('fresh-operation', connection),
      (error) =>
        error instanceof PostgresOperationProtocolError &&
        error.phase === 'open' &&
        error.expectedOperation === 'fresh-operation' &&
        error.receivedOperation === 'stale-operation',
    );
    await third.close();

    assert.deepEqual(
      requests[1],
      requests[0],
      'open recovery must replay the exact bounded intent',
    );
    assert.deepEqual(
      requests[3],
      requests[2],
      'query recovery must replay the exact SQL and bounds',
    );
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
