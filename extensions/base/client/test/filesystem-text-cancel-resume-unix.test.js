import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import { FileTextOperationError, connect, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('cancelled in-flight file range preserves an exact prefix for reconnect resume', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-file-cancel-resume-'));
  const socketPath = path.join(directory, 'host.sock');
  const sockets = new Set();
  const offsets = [];
  let connection = 0;
  let stalled;
  const server = net.createServer((socket) => {
    const current = ++connection;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const send = (frame) => {
      const bytes = encode(frame);
      for (const byte of bytes) socket.write(Uint8Array.of(byte));
    };
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request || frame.payload.call !== 'filesystem_read_range') continue;
        const offset = frame.payload.with.offset;
        offsets.push(offset);
        if (current === 1 && offset === 2) {
          stalled?.();
          continue; // Prove AbortSignal interrupts an already-written ordered call.
        }
        const contents = offset === 0 ? [...Buffer.from('ab')] : [...Buffer.from('cd')];
        send({
          channel: frame.channel,
          kind: KIND.response,
          payload: {
            reply: 'file_range',
            with: {
              path: 'docs/large.txt',
              identity: 'file-v1',
              offset,
              total: 4,
              contents,
              eof: offset === 2,
              truncated: offset !== 2,
            },
          },
        });
      }
    });
    send({
      channel: CONTROL,
      kind: KIND.open,
      payload: { protocol: 1, peer: `file-resume-${current}`, granted: ['filesystem:read'] },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath, timeout: 5_000 });
    const cancellation = new AbortController();
    const secondRange = new Promise((resolve) => {
      stalled = resolve;
    });
    const reading = workspace(first).files.readText('docs/large.txt', {
      maxBytes: 4,
      chunkBytes: 2,
      signal: cancellation.signal,
      preservePartialOnAbort: true,
    });
    await secondRange;
    cancellation.abort('indexing checkpoint requested');
    let failure;
    await assert.rejects(reading, (error) => {
      assert(error instanceof FileTextOperationError);
      assert.equal(error.cause?.name, 'AbortError');
      assert.equal(error.identity, 'file-v1');
      assert.deepEqual(error.contents, [...Buffer.from('ab')]);
      failure = error;
      return true;
    });
    await first.close();

    const resumed = await connect({ path: socketPath });
    const document = await workspace(resumed).files.resumeText(failure);
    assert.deepEqual(document, {
      path: 'docs/large.txt',
      text: 'abcd',
      identity: 'file-v1',
      bytes: 4,
    });
    assert.deepEqual(offsets, [0, 2, 2], 'the acknowledged prefix is never fetched twice');
    await resumed.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
