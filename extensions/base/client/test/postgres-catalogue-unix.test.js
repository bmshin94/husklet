import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { connect, PostgresOperationProtocolError, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

function fragmented(socket, frame) {
  for (const byte of encode(frame)) socket.write(Uint8Array.of(byte));
}

test('read-only catalogue recovery keeps exact bounded intent and rejects replacement authority', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-postgres-catalogue-'));
  const socketPath = path.join(directory, 'host.sock');
  const requests = [];
  const peers = new Set();
  let calls = 0;
  const catalogue = {
    operation: 'catalogue-columns-1',
    resource: { resource: 'columns', schema: 'public', relation: 'events' },
    page_rows: 200,
    page_bytes: 128 * 1024,
  };
  const server = net.createServer((socket) => {
    peers.add(socket);
    socket.on('close', () => peers.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        requests.push(frame.payload);
        assert.equal(frame.payload.call, 'postgres_catalogue_start_once');
        assert.equal('statement' in frame.payload.with.query, false, 'catalogue wire intent cannot carry SQL');
        calls += 1;
        if (calls === 1) {
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
              operation: catalogue.operation,
              lease: calls === 2 ? 'lease-from-replaced-container' : 'lease-current',
              query: 'catalogue-query-1',
              state: 'running',
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
        extension: 'postgres-catalogue',
        granted: ['postgres:read'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  try {
    const interrupted = await connect({ path: socketPath });
    assert.equal(interrupted.granted.includes('postgres:write'), false);
    await assert.rejects(workspace(interrupted).postgres.catalogueStartOnce('lease-current', catalogue));
    await interrupted.close();

    const replaced = await connect({ path: socketPath });
    await assert.rejects(
      workspace(replaced).postgres.catalogueStartOnce('lease-current', catalogue),
      (error) =>
        error instanceof PostgresOperationProtocolError &&
        error.phase === 'catalogue' &&
        error.expectedLease === 'lease-current' &&
        error.receivedLease === 'lease-from-replaced-container',
    );
    await replaced.close();

    const recovered = await connect({ path: socketPath });
    const result = await workspace(recovered).postgres.catalogueStartOnce('lease-current', catalogue);
    assert.equal(result.query, 'catalogue-query-1');
    await recovered.close();

    assert.deepEqual(requests[1], requests[0]);
    assert.deepEqual(requests[2], requests[0]);
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
