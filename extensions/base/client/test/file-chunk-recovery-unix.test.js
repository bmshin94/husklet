import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { FileChunkOperationError, connect, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('fragmented Unix chunk recovery resumes the exact file without yielding duplicate bytes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-chunk-recovery-'));
  const socketPath = path.join(directory, 'host.sock');
  const sockets = new Set();
  const requests = [];
  let connection = 0;
  const fragmented = (socket, frame) => {
    for (const byte of encode(frame)) socket.write(Uint8Array.of(byte));
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const currentConnection = ++connection;
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        const input = frame.payload.with;
        requests.push(input);
        if (currentConnection === 1 && input.offset === 2) {
          socket.destroy();
          continue;
        }
        const contents = input.offset === 0 ? [65, 66] : [67, 68];
        fragmented(socket, {
          channel: frame.channel,
          kind: KIND.response,
          payload: {
            reply: 'file_range',
            with: {
              path: input.path,
              identity: 'document-v1',
              offset: input.offset,
              total: 4,
              contents,
              eof: input.offset === 2,
              truncated: input.offset === 0,
            },
          },
        });
      }
    });
    fragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: { protocol: 1, peer: `indexer-${currentConnection}`, granted: ['filesystem:read'] },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath });
    const bytes = [];
    let failure;
    try {
      for await (const range of workspace(first).files.readChunks('docs/a.md', {
        chunkBytes: 2,
      })) {
        bytes.push(...range.contents);
      }
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof FileChunkOperationError);
    assert.deepEqual(
      { path: failure.path, identity: failure.identity, offset: failure.offset, total: failure.total },
      { path: 'docs/a.md', identity: 'document-v1', offset: 2, total: 4 },
    );
    await first.close().catch(() => {});

    const resumed = await connect({ path: socketPath });
    for await (const range of workspace(resumed).files.resumeChunks(failure, {
      chunkBytes: 2,
    })) {
      bytes.push(...range.contents);
    }
    assert.deepEqual(bytes, [65, 66, 67, 68]);
    assert.deepEqual(requests, [
      { path: 'docs/a.md', offset: 0, limit: 2, observed: null },
      { path: 'docs/a.md', offset: 2, limit: 2, observed: 'document-v1' },
      { path: 'docs/a.md', offset: 2, limit: 2, observed: 'document-v1' },
    ]);
    await resumed.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
