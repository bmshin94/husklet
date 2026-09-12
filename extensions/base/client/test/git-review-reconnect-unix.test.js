import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { ExecutionOperationError, connect, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('Git review retains only acknowledged bounded text across fragmented socket loss', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-git-review-text-'));
  const socketPath = path.join(directory, 'host.sock');
  const executionId = 'e'.repeat(32);
  const diff = Buffer.from('diff --git a/src/a.ts b/src/a.ts\n');
  const connections = new Set();
  const calls = [];
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        calls.push(frame.payload);
        if (frame.payload.call === 'execution_output' && frame.payload.with.after === 1) {
          socket.destroy();
          continue;
        }
        const payload =
          frame.payload.call === 'container_exec'
            ? { reply: 'identity', with: executionId }
            : frame.payload.call === 'execution_output'
              ? {
                  reply: 'execution_output',
                  with: {
                    entries: [
                      {
                        sequence: 1,
                        timestamp_ms: 1,
                        stream: 'stdout',
                        bytes: [...diff],
                      },
                    ],
                    next: 1,
                    more: true,
                    eof: false,
                    gap: false,
                  },
                }
              : { reply: 'done' };
        const bytes = encode({ channel: frame.channel, kind: KIND.response, payload });
        socket.write(bytes.subarray(0, 3));
        socket.write(bytes.subarray(3));
      }
    });
    const greeting = encode({
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'git-review-text',
        granted: ['containers:execute', 'containers:read'],
      },
    });
    socket.write(greeting.subarray(0, 5));
    socket.write(greeting.subarray(5));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const session = await connect({ path: socketPath });
    await assert.rejects(
      workspace(session).containers.execText('c'.repeat(64), 4, {
        command: ['git', 'diff'],
        maxBytes: 0,
      }),
      /maxBytes must be between/,
    );
    assert.equal(calls.length, 0, 'an unbounded text request never reaches the socket');
    await assert.rejects(
      workspace(session).containers.execText('c'.repeat(64), 4, {
        command: ['git', 'diff'],
        maxBytes: 256 * 1024,
        pageLimit: 1,
        pollIntervalMs: 10,
      }),
      (error) => {
        assert(error instanceof ExecutionOperationError);
        assert.equal(error.after, 1);
        assert.deepEqual(error.stdout, [...diff]);
        assert.deepEqual(error.stderr, []);
        assert(Object.isFrozen(error.stdout));
        assert(Object.isFrozen(error.stderr));
        return true;
      },
    );
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
