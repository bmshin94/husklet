import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { connect, PostgresPageProtocolError, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('Postgres page retry preserves its query and cursor receipt over fragmented Unix framing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-postgres-page-'));
  const socketPath = path.join(directory, 'host.sock');
  const peers = new Set();
  const requests = [];
  const firstPage = {
    query: 'query-1',
    cursor: null,
    columns: ['id', 'email'],
    rows: [['1', 'first@example.test']],
    next_cursor: 'page-2',
    bytes: 19,
  };
  const wrongPage = {
    query: 'another-query',
    cursor: 'page-2',
    columns: ['id', 'email'],
    rows: [['2', 'second@example.test']],
    next_cursor: null,
    bytes: 20,
  };
  const server = net.createServer((socket) => {
    peers.add(socket);
    socket.on('close', () => peers.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        requests.push(frame.payload);
        const reply = encode({
          channel: frame.channel,
          kind: KIND.response,
          flags: 1,
          payload: {
            reply: 'postgres_page',
            with: requests.length < 3 ? firstPage : wrongPage,
          },
        });
        if (requests.length === 1) {
          socket.write(reply.subarray(0, reply.length - 3), () => socket.destroy());
          continue;
        }
        for (const byte of reply) socket.write(Uint8Array.of(byte));
      }
    });
    socket.write(
      encode({
        channel: CONTROL,
        kind: KIND.open,
        payload: {
          protocol: 1,
          extension: 'postgres-page-recovery',
          granted: ['credentials:use'],
        },
      }),
    );
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  try {
    const interrupted = await connect({ path: socketPath });
    await assert.rejects(workspace(interrupted).postgres.page('lease-1', 'query-1'));
    await interrupted.close();

    const session = await connect({ path: socketPath });
    const postgres = workspace(session).postgres;
    const first = await postgres.page('lease-1', 'query-1');
    assert.equal(first.cursor, null);
    assert.equal(first.next_cursor, 'page-2');
    await assert.rejects(
      postgres.page('lease-1', 'query-1', first.next_cursor),
      (error) =>
        error instanceof PostgresPageProtocolError &&
        error.query === 'query-1' &&
        error.cursor === 'page-2' &&
        error.receivedQuery === 'another-query',
    );
    assert.deepEqual(requests, [
      {
        call: 'postgres_query_page',
        with: { lease: 'lease-1', query: 'query-1', cursor: null },
      },
      {
        call: 'postgres_query_page',
        with: { lease: 'lease-1', query: 'query-1', cursor: null },
      },
      {
        call: 'postgres_query_page',
        with: { lease: 'lease-1', query: 'query-1', cursor: 'page-2' },
      },
    ]);
    await session.close();
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
