import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import {
  FileChunkLimitError,
  FileChunkOperationError,
  connect,
  workspace,
} from '../dist/index.js';
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
        if (
          (currentConnection === 1 && input.offset === 2) ||
          (currentConnection === 2 && input.offset === 4) ||
          (currentConnection === 3 && input.offset === 6)
        ) {
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
              total: 8,
              contents,
              eof: false,
              truncated: true,
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
        maxBytes: 8,
        maxChunks: 3,
      })) {
        bytes.push(...range.contents);
      }
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof FileChunkOperationError);
    assert.deepEqual(
      { path: failure.path, identity: failure.identity, offset: failure.offset, total: failure.total },
      { path: 'docs/a.md', identity: 'document-v1', offset: 2, total: 8 },
    );
    assert.deepEqual(JSON.parse(JSON.stringify(failure.resume)), {
      version: 1,
      path: 'docs/a.md',
      identity: 'document-v1',
      offset: 2,
      total: 8,
      deliveredBytes: 2,
      deliveredChunks: 1,
      maxBytes: 8,
      maxChunks: 3,
    });
    await first.close().catch(() => {});

    const resumed = await connect({ path: socketPath });
    let secondFailure;
    try {
      for await (const range of workspace(resumed).files.resumeChunks(failure.resume, {
        chunkBytes: 2,
      })) {
        bytes.push(...range.contents);
      }
    } catch (error) {
      secondFailure = error;
    }
    assert(secondFailure instanceof FileChunkOperationError);
    assert.deepEqual(
      [secondFailure.offset, secondFailure.deliveredBytes, secondFailure.deliveredChunks],
      [4, 4, 2],
    );
    assert.deepEqual(bytes, [65, 66, 67, 68]);
    await resumed.close().catch(() => {});

    const exhausted = await connect({ path: socketPath });
    await assert.rejects(
      Array.fromAsync(
        workspace(exhausted).files.resumeChunks(secondFailure.resume, { maxChunks: 2 }),
      ),
      /cannot widen/,
    );
    await assert.rejects(
      Array.fromAsync(
        workspace(exhausted).files.resumeChunks({
          ...secondFailure.resume,
          deliveredBytes: 8,
          deliveredChunks: 3,
        }),
      ),
      FileChunkLimitError,
    );
    await exhausted.close();
    assert.deepEqual(requests, [
      { path: 'docs/a.md', offset: 0, limit: 2, observed: null },
      { path: 'docs/a.md', offset: 2, limit: 2, observed: 'document-v1' },
      { path: 'docs/a.md', offset: 2, limit: 2, observed: 'document-v1' },
      { path: 'docs/a.md', offset: 4, limit: 2, observed: 'document-v1' },
    ]);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
