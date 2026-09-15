import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import {
  connect,
  DirectoryIdentityChangedError,
  FileWalkOperationError,
  workspace,
} from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

const entry = (path, directory = false) => ({
  path,
  directory,
  size: directory ? 0 : 3,
  identity: `${path}-v1`,
});

test('recursive walk resumes after Unix replacement without duplicates and rejects a changed directory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-walk-resume-'));
  const socketPath = path.join(directory, 'host.sock');
  const connections = new Set();
  const calls = [];
  let connectionNumber = 0;
  const server = net.createServer((socket) => {
    const connection = ++connectionNumber;
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request || frame.payload.call !== 'filesystem_list_page') continue;
        calls.push({ connection, with: frame.payload.with });
        const { path: requested, after } = frame.payload.with;
        if (connection === 1 && requested === 'root' && after === 'root/dir') {
          socket.destroy();
          continue;
        }
        const payload =
          requested === 'root/dir'
            ? {
                reply: 'directory_page',
                with: {
                  entries: [entry('root/dir/a.md')],
                  identity: 'dir-v1',
                  next: 'root/dir/a.md',
                  more: false,
                },
              }
            : after === null
              ? {
                  reply: 'directory_page',
                  with: {
                    entries: [entry('root/dir', true)],
                    identity: 'root-v1',
                    next: 'root/dir',
                    more: true,
                  },
                }
              : {
                  reply: 'directory_page',
                  with: {
                    entries: [entry('root/z.md')],
                    identity: connection === 3 ? 'root-v2' : 'root-v1',
                    next: 'root/z.md',
                    more: false,
                  },
                };
        const reply = encode({ channel: frame.channel, kind: KIND.response, payload });
        for (const byte of reply) socket.write(Uint8Array.of(byte));
      }
    });
    socket.write(
      encode({
        channel: CONTROL,
        kind: KIND.open,
        payload: { protocol: 1, peer: `walk-${connection}`, granted: ['filesystem:read'] },
      }),
    );
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath });
    const yielded = [];
    let failure;
    try {
      for await (const value of workspace(first).files.walk('root', { pageSize: 1 })) {
        yielded.push(value.path);
      }
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof FileWalkOperationError);
    assert.deepEqual(yielded, ['root/dir', 'root/dir/a.md']);
    const persisted = JSON.parse(JSON.stringify(failure.resume));
    assert.deepEqual(persisted, {
      version: 1,
      root: 'root',
      pageSize: 1,
      stack: [{ path: 'root', identity: 'root-v1', after: 'root/dir' }],
    });

    const resumed = await connect({ path: socketPath });
    const remaining = [];
    for await (const value of workspace(resumed).files.resumeWalk(persisted)) {
      remaining.push(value.path);
    }
    assert.deepEqual(remaining, ['root/z.md']);
    await resumed.close();

    const replaced = await connect({ path: socketPath });
    await assert.rejects(
      async () => {
        for await (const _value of workspace(replaced).files.resumeWalk(persisted)) {
          // A changed directory must fail before any entry from its replacement is yielded.
        }
      },
      (error) =>
        error instanceof DirectoryIdentityChangedError &&
        error.expected === 'root-v1' &&
        error.actual === 'root-v2' &&
        error.after === 'root/dir',
    );
    await replaced.close();
    assert.deepEqual(
      calls.map(({ connection, with: value }) => [
        connection,
        value.path,
        value.after,
        value.observed,
      ]),
      [
        [1, 'root', null, null],
        [1, 'root/dir', null, null],
        [1, 'root', 'root/dir', 'root-v1'],
        [2, 'root', 'root/dir', 'root-v1'],
        [3, 'root', 'root/dir', 'root-v1'],
      ],
    );
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
