import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { connect, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

const JOURNAL = 'a'.repeat(32);
const changes = [
  {
    cursor: { journal: JOURNAL, revision: 1 },
    kind: 'remove',
    path: 'documents/old.md',
    entry: null,
  },
  {
    cursor: { journal: JOURNAL, revision: 2 },
    kind: 'create',
    path: 'documents/new.md',
    entry: { path: 'documents/new.md', directory: false, size: 4, identity: 'file-v2' },
  },
];

test('embeddings restart resumes after the exact applied rename half over fragmented Unix framing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-embeddings-incremental-'));
  const socketPath = path.join(directory, 'host.sock');
  const sockets = new Set();
  const asked = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request || frame.payload.call !== 'filesystem_changes') continue;
        const after = frame.payload.with.after;
        asked.push(after);
        const remaining = changes.filter((change) => change.cursor.revision > after);
        const bytes = encode({
          channel: frame.channel,
          kind: KIND.response,
          payload: {
            reply: 'file_changes',
            with: {
              changes: remaining,
              journal: JOURNAL,
              after,
              next: 2,
              current: 2,
              more: false,
              truncated: false,
            },
          },
        });
        for (const byte of bytes) socket.write(Uint8Array.of(byte));
      }
    });
    const greeting = encode({
      channel: CONTROL,
      kind: KIND.open,
      payload: { protocol: 1, peer: 'embeddings-indexer', granted: ['filesystem:read'] },
    });
    socket.write(greeting.subarray(0, 3));
    socket.write(greeting.subarray(3));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  let durable = { journal: JOURNAL, revision: 0 };
  const applied = [];
  try {
    const first = await connect({ path: socketPath });
    const firstFiles = workspace(first).files;
    const page = await firstFiles.changes(durable);
    await assert.rejects(
      firstFiles.applyChangePage(page, durable, async (change, cursor) => {
        applied.push(change.path);
        durable = { ...cursor };
        throw new Error('process lost immediately after the first durable checkpoint');
      }),
      /process lost/,
    );
    await first.close();

    const resumed = await connect({ path: socketPath });
    const resumedFiles = workspace(resumed).files;
    const remainder = await resumedFiles.changes(durable);
    const result = await resumedFiles.applyChangePage(remainder, durable, (change, cursor) => {
      applied.push(change.path);
      durable = { ...cursor };
    });
    assert.deepEqual(applied, ['documents/old.md', 'documents/new.md']);
    assert.deepEqual(asked, [0, 1]);
    assert.deepEqual(result, { cursor: { journal: JOURNAL, revision: 2 }, complete: true });
    await resumed.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
