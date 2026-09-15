import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { connect, PostgresPageShapeProtocolError, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('Postgres pages reject malformed table shape and a non-advancing cursor over fragmented Unix framing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-postgres-page-shape-'));
  const socketPath = path.join(directory, 'host.sock');
  const peers = new Set();
  let request = 0;
  const pages = [
    {
      lease: 'lease-1', query: 'query-1', cursor: null, columns: ['id', 'email'],
      rows: [['1']], next_cursor: 'page-2', bytes: 1,
    },
    {
      lease: 'lease-1', query: 'query-1', cursor: 'page-2', columns: ['id'],
      rows: [['2']], next_cursor: 'page-2', bytes: 1,
    },
  ];
  const server = net.createServer((socket) => {
    peers.add(socket);
    socket.on('close', () => peers.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        const reply = encode({
          channel: frame.channel,
          kind: KIND.response,
          flags: 1,
          payload: { reply: 'postgres_page', with: pages[request++] },
        });
        for (const byte of reply) socket.write(Uint8Array.of(byte));
      }
    });
    const greeting = encode({
      channel: CONTROL,
      kind: KIND.open,
      payload: { protocol: 1, extension: 'postgres-page-shape', granted: ['postgres:read'] },
    });
    for (const byte of greeting) socket.write(Uint8Array.of(byte));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  try {
    const session = await connect({ path: socketPath });
    const postgres = workspace(session).postgres;
    await assert.rejects(
      postgres.page('lease-1', 'query-1'),
      (error) => error instanceof PostgresPageShapeProtocolError && /row/.test(error.reason),
    );
    await assert.rejects(
      postgres.page('lease-1', 'query-1', 'page-2'),
      (error) => error instanceof PostgresPageShapeProtocolError && /cursor/.test(error.reason),
    );
    assert.equal(request, 2);
    await session.close();
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
