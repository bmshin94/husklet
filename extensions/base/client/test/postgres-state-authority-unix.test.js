import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { connect, PostgresStateProtocolError, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

function fragmented(socket, frame) {
  for (const byte of encode(frame)) socket.write(Uint8Array.of(byte));
}

test('Postgres state receipts reject stale lease and query authority over fragmented Unix framing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-postgres-state-'));
  const socketPath = path.join(directory, 'host.sock');
  const peers = new Set();
  const requests = [];
  const server = net.createServer((socket) => {
    peers.add(socket);
    socket.on('close', () => peers.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        requests.push(frame.payload);
        const correct = frame.payload.call === 'postgres_query_status';
        fragmented(socket, {
          channel: frame.channel,
          kind: KIND.response,
          payload: {
            reply: 'postgres_state',
            with: {
              lease: correct ? 'lease-current' : 'lease-retired',
              query: correct ? 'query-current' : 'query-retired',
              state: correct ? 'running' : 'cancelled',
            },
          },
        });
      }
    });
    fragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        extension: 'postgres-state-authority',
        granted: ['credentials:use'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  try {
    const session = await connect({ path: socketPath });
    const postgres = workspace(session).postgres;
    assert.equal(await postgres.status('lease-current', 'query-current'), 'running');
    await assert.rejects(
      postgres.cancel('lease-current', 'query-current'),
      (error) =>
        error instanceof PostgresStateProtocolError &&
        error.expectedLease === 'lease-current' &&
        error.expectedQuery === 'query-current' &&
        error.receivedLease === 'lease-retired' &&
        error.receivedQuery === 'query-retired',
    );
    assert.deepEqual(requests, [
      {
        call: 'postgres_query_status',
        with: { lease: 'lease-current', query: 'query-current' },
      },
      {
        call: 'postgres_query_cancel',
        with: { lease: 'lease-current', query: 'query-current' },
      },
    ]);
    await session.close();
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
