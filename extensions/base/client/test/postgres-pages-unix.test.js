import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import {
  connect,
  PostgresPagesOperationError,
  PostgresPageShapeProtocolError,
  workspace,
} from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

const fragmented = (socket, value) => {
  const bytes = encode(value);
  for (const chunk of Array.from(bytes, (byte) => Uint8Array.of(byte))) socket.write(chunk);
};

test('PostgreSQL pages resume exactly after reconnect and reject cross-page drift over fragmented Unix framing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-postgres-pages-'));
  const socketPath = path.join(directory, 'host.sock');
  const peers = new Set();
  const requested = [];
  let connection = 0;
  const server = net.createServer((socket) => {
    const incarnation = ++connection;
    peers.add(socket);
    socket.on('close', () => peers.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        const { call, with: input } = frame.payload;
        if (call === 'postgres_open_once') {
          fragmented(socket, {
            channel: frame.channel,
            kind: KIND.response,
            flags: 1,
            payload: {
              reply: 'postgres_open',
              with: { disposition: 'opened', operation: input.operation, lease: 'lease-1' },
            },
          });
          continue;
        }
        if (call === 'postgres_query_start_once') {
          fragmented(socket, {
            channel: frame.channel,
            kind: KIND.response,
            flags: 1,
            payload: {
              reply: 'postgres_start',
              with: {
                disposition: 'started',
                operation: input.query.operation,
                lease: input.lease,
                query: 'query-1',
                state: 'running',
              },
            },
          });
          continue;
        }
        if (call === 'postgres_query_cancel') {
          fragmented(socket, {
            channel: frame.channel,
            kind: KIND.response,
            flags: 1,
            payload: {
              reply: 'postgres_state',
              with: { lease: input.lease, query: input.query, state: 'cancelled' },
            },
          });
          continue;
        }
        if (call === 'postgres_query_page') {
          requested.push(input.cursor);
          if (incarnation === 1 && input.cursor === 'page-2') {
            socket.destroy();
            continue;
          }
          const cycle = input.query === 'query-cycle';
          const ordinal = input.cursor === null ? '1' : input.cursor === 'page-2' ? '2' : '3';
          const next = cycle
            ? input.cursor === null
              ? 'page-2'
              : input.cursor === 'page-2'
                ? 'page-3'
                : 'page-2'
            : ordinal === '1'
              ? 'page-2'
              : ordinal === '2'
                ? 'page-3'
                : null;
          fragmented(socket, {
            channel: frame.channel,
            kind: KIND.response,
            flags: 1,
            payload: {
              reply: 'postgres_page',
              with: {
                lease: 'lease-1',
                query: input.query,
                cursor: input.cursor,
                columns: input.query === 'query-schema' && ordinal === '2' ? ['changed'] : ['id'],
                rows: [[ordinal]],
                next_cursor: next,
                bytes: 1,
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
        extension: 'postgres-pages',
        granted: ['postgres:read', 'postgres:write'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  try {
    const first = await connect({ path: socketPath });
    const firstPostgres = workspace(first).postgres;
    const opened = await firstPostgres.openOnce('1'.repeat(32), {
      container_id: 'a'.repeat(64),
      container_generation: 1,
      network: 'private',
      port: 5432,
      database: 'app',
      user: 'reader',
      credential_keys: [],
    });
    const started = await firstPostgres.startOnce(opened.lease, {
      operation: '2'.repeat(32),
      statement: 'select id from events order by id',
      page_rows: 250,
      page_bytes: 512 * 1024,
    });
    const iterator = firstPostgres.pages(opened.lease, started.query);
    assert.deepEqual((await iterator.next()).value.rows, [['1']]);
    let failure;
    await assert.rejects(iterator.next(), (error) => {
      failure = error;
      return (
        error instanceof PostgresPagesOperationError &&
        error.resume.cursor === 'page-2' &&
        Object.isFrozen(error.resume) &&
        Object.isFrozen(error.resume.cursors)
      );
    });
    const recovery = JSON.parse(JSON.stringify(failure.resume));
    await first.close().catch(() => {});

    const second = await connect({ path: socketPath });
    const resumed = workspace(second).postgres.resumePages(recovery);
    assert.deepEqual((await resumed.next()).value.rows, [['2']]);
    assert.deepEqual((await resumed.next()).value.rows, [['3']]);
    assert.equal((await resumed.next()).done, true);
    assert.deepEqual(requested, [null, 'page-2', 'page-2', 'page-3']);

    const cyclic = workspace(second).postgres.pages('lease-1', 'query-cycle');
    assert.deepEqual((await cyclic.next()).value.rows, [['1']]);
    assert.deepEqual((await cyclic.next()).value.rows, [['2']]);
    await assert.rejects(
      cyclic.next(),
      (error) => error instanceof PostgresPageShapeProtocolError && /cycles/.test(error.reason),
    );

    assert.throws(() => workspace(second).postgres.resumePages({ version: 2 }), TypeError);

    const schema = workspace(second).postgres.pages('lease-1', 'query-schema');
    await schema.next();
    await assert.rejects(
      schema.next(),
      (error) =>
        error instanceof PostgresPageShapeProtocolError && /columns changed/.test(error.reason),
    );

    const cancellable = workspace(second).postgres.pages('lease-1', 'query-cancel');
    assert.deepEqual((await cancellable.next()).value.rows, [['1']]);
    await cancellable.return();
    assert.equal(
      (await workspace(second).postgres.cancelRecoverable('lease-1', 'query-cancel')).state,
      'cancelled',
    );
    const bounded = workspace(second).postgres.pages('lease-1', 'query-bounded', { maxPages: 1 });
    await bounded.next();
    await assert.rejects(bounded.next(), /exceeded its 1 page limit/);
    await second.close();
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
