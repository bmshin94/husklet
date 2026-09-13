import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import {
  connect,
  FileExtentChangedError,
  FileIdentityChangedError,
  FileTextDecodeError,
  FileTextLimitError,
  FileTextOperationError,
  workspace,
} from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('readText decodes split UTF-8 over fragmented real Unix frames and enforces its bound', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-file-text-'));
  const socketPath = path.join(directory, 'host.sock');
  const connections = new Set();
  const requests = [];
  const documents = new Map([
    ['docs/good.txt', { identity: 'good-v1', bytes: [0x41, 0xe2, 0x82, 0xac, 0x42] }],
    ['docs/large.txt', { identity: 'large-v1', bytes: [0x61, 0x62, 0x63] }],
    ['docs/bad.txt', { identity: 'bad-v1', bytes: [0x61, 0xc3, 0x28] }],
    ['docs/churn.txt', { identity: 'churn-v1', bytes: [0x61, 0x62] }],
    ['docs/extent.txt', { identity: 'extent-v1', bytes: [0x61, 0x62] }],
  ]);
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    const reader = new Reader();
    socket.on('data', async (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        const input = frame.payload.with;
        requests.push(input);
        const document = documents.get(input.path);
        const contents = document.bytes.slice(input.offset, input.offset + input.limit);
        const identity =
          input.path === 'docs/churn.txt' && input.offset > 0 ? 'churn-v2' : document.identity;
        const total =
          input.path === 'docs/extent.txt' && input.offset === 0 ? 3 : document.bytes.length;
        const eof = input.offset + contents.length >= total;
        const reply = encode({
          channel: frame.channel,
          kind: KIND.response,
          payload: {
            reply: 'file_range',
            with: {
              path: input.path,
              identity,
              offset: input.offset,
              total,
              contents,
              eof,
              truncated: !eof,
            },
          },
        });
        // Exercise header, multibyte JSON, and payload boundaries rather than
        // relying on the kernel to happen to fragment a local write.
        for (const byte of reply) socket.write(Uint8Array.of(byte));
      }
    });
    const greeting = encode({
      channel: CONTROL,
      kind: KIND.open,
      payload: { protocol: 1, peer: 'file-text', granted: ['filesystem:read'] },
    });
    socket.write(greeting.subarray(0, 5));
    socket.write(greeting.subarray(5));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const session = await connect({ path: socketPath });
    const files = workspace(session).files;
    assert.deepEqual(
      await files.readText('docs/good.txt', {
        maxBytes: 5,
        chunkBytes: 2,
        observed: 'good-v1',
      }),
      { text: 'A€B', identity: 'good-v1', bytes: 5 },
    );
    assert.deepEqual(
      requests.slice(0, 3).map(({ offset, limit, observed }) => ({ offset, limit, observed })),
      [
        { offset: 0, limit: 2, observed: 'good-v1' },
        { offset: 2, limit: 2, observed: 'good-v1' },
        { offset: 4, limit: 2, observed: 'good-v1' },
      ],
    );

    const beforeLarge = requests.length;
    await assert.rejects(
      files.readText('docs/large.txt', { maxBytes: 2, chunkBytes: 1 }),
      (error) => {
        assert(error instanceof FileTextLimitError);
        assert.equal(error.path, 'docs/large.txt');
        assert.equal(error.identity, 'large-v1');
        assert.equal(error.total, 3);
        assert.equal(error.limit, 2);
        return true;
      },
    );
    assert.equal(requests.length, beforeLarge + 1, 'reported total stops the read after one page');

    await assert.rejects(
      files.readText('docs/churn.txt', { maxBytes: 2, chunkBytes: 1 }),
      (error) => {
        assert(error instanceof FileIdentityChangedError);
        assert.equal(error.path, 'docs/churn.txt');
        assert.equal(error.expected, 'churn-v1');
        assert.equal(error.actual, 'churn-v2');
        assert.equal(error.offset, 1);
        return true;
      },
    );

    await assert.rejects(
      files.readText('docs/extent.txt', { maxBytes: 3, chunkBytes: 1 }),
      (error) => {
        assert(error instanceof FileExtentChangedError);
        assert.equal(error.path, 'docs/extent.txt');
        assert.equal(error.identity, 'extent-v1');
        assert.equal(error.expectedTotal, 3);
        assert.equal(error.actualTotal, 2);
        assert.equal(error.offset, 1);
        return true;
      },
    );

    await assert.rejects(
      files.readText('docs/bad.txt', { maxBytes: 3, chunkBytes: 1 }),
      (error) => {
        assert(error instanceof FileTextDecodeError);
        assert.equal(error.path, 'docs/bad.txt');
        assert.equal(error.identity, 'bad-v1');
        assert.equal(error.bytes, 3);
        assert(error.cause instanceof TypeError);
        return true;
      },
    );
    assert.equal(
      (await files.readText('docs/good.txt', { maxBytes: 5, chunkBytes: 5 })).identity,
      'good-v1',
      'the ordered session remains reusable after a decode failure',
    );
    await session.close();
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('readText resumes an exact UTF-8 prefix after fragmented Unix loss and rejects replacement', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-file-text-resume-'));
  const socketPath = path.join(directory, 'host.sock');
  const bytes = [0x41, 0xe2, 0x82, 0xac, 0x42];
  const requests = [];
  const sockets = new Set();
  let connection = 0;
  let replaced = false;
  const server = net.createServer((socket) => {
    connection += 1;
    const currentConnection = connection;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        const input = frame.payload.with;
        requests.push({ connection: currentConnection, ...input });
        if (currentConnection === 1 && input.offset === 2) {
          socket.destroy();
          continue;
        }
        const contents = bytes.slice(input.offset, input.offset + input.limit);
        const eof = input.offset + contents.length >= bytes.length;
        const reply = encode({
          channel: frame.channel,
          kind: KIND.response,
          payload: {
            reply: 'file_range',
            with: {
              path: input.path,
              identity: replaced ? 'document-v2' : 'document-v1',
              offset: input.offset,
              total: bytes.length,
              contents,
              eof,
              truncated: !eof,
            },
          },
        });
        for (const byte of reply) socket.write(Uint8Array.of(byte));
      }
    });
    const greeting = encode({
      channel: CONTROL,
      kind: KIND.open,
      payload: { protocol: 1, peer: 'file-text-resume', granted: ['filesystem:read'] },
    });
    for (const byte of greeting) socket.write(Uint8Array.of(byte));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath });
    let failure;
    await assert.rejects(
      workspace(first).files.readText('docs/model.txt', { maxBytes: 5, chunkBytes: 2 }),
      (error) => {
        failure = error;
        assert(error instanceof FileTextOperationError);
        assert.equal(error.identity, 'document-v1');
        assert.deepEqual(error.contents, [0x41, 0xe2]);
        assert(Object.isFrozen(error.contents));
        return true;
      },
    );
    const second = await connect({ path: socketPath });
    assert.deepEqual(await workspace(second).files.resumeText(failure), {
      text: 'A€B',
      identity: 'document-v1',
      bytes: 5,
    });
    assert.deepEqual(
      requests.filter(({ connection: value }) => value === 2).map(({ offset }) => offset),
      [2],
      'reconnect resumes at the acknowledged byte cursor instead of rereading the prefix',
    );
    await second.close();

    replaced = true;
    const third = await connect({ path: socketPath });
    await assert.rejects(workspace(third).files.resumeText(failure), FileIdentityChangedError);
    await third.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('readText rejects invalid bounds before writing to the transport', async () => {
  const calls = [];
  const files = workspace({
    granted: [],
    onEvent() {
      return () => false;
    },
    async call(name, argument) {
      calls.push({ name, argument });
      throw new Error('must not be called');
    },
  }).files;

  for (const maxBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 64 * 1024 * 1024 + 1]) {
    await assert.rejects(files.readText('docs/a.txt', { maxBytes }), /maxBytes/);
  }
  await assert.rejects(
    files.readText('docs/a.txt', { maxBytes: 4, chunkBytes: 65_537 }),
    /filesystem range limit/,
  );
  assert.deepEqual(calls, []);
});
