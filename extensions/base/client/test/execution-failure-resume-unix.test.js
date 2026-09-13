import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import {
  ExecutionContainerMismatchError,
  ExecutionOperationError,
  connect,
  workspace,
} from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

const executionId = 'e'.repeat(32);
const originalContainer = 'a'.repeat(64);
const replacementContainer = 'b'.repeat(64);

test('failure-bound execution resume rejects container replacement before reading output', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-execution-recovery-'));
  const socketPath = path.join(directory, 'host.sock');
  const connections = new Set();
  const calls = [];
  const sendFragmented = (socket, frame) => {
    for (const byte of encode(frame)) socket.write(Uint8Array.of(byte));
  };
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        calls.push(frame.payload);
        assert.equal(frame.payload.call, 'execution_inspect');
        sendFragmented(socket, {
          channel: frame.channel,
          kind: KIND.response,
          payload: {
            reply: 'execution',
            with: {
              id: executionId,
              container_id: replacementContainer,
              running: true,
              exit_code: -1,
              created_at_ms: 1,
              started_at_ms: 2,
              finished_at_ms: null,
              pid: 42,
              command: ['npm', 'test'],
              user: 'developer',
            },
          },
        });
      }
    });
    sendFragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'failure-resume',
        granted: ['containers:read'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const session = await connect({ path: socketPath });
    const failure = new ExecutionOperationError(
      executionId,
      'output',
      new Error('socket lost'),
      undefined,
      17,
      { containerId: originalContainer },
    );
    await assert.rejects(
      workspace(session).containers.resumeExecutionFailureStreaming(failure, {}, () => {}),
      (error) => {
        assert(error instanceof ExecutionOperationError);
        assert(error.cause instanceof ExecutionContainerMismatchError);
        assert.equal(error.after, 17);
        assert.equal(error.containerId, originalContainer);
        return true;
      },
    );
    assert.deepEqual(calls, [{ call: 'execution_inspect', with: { id: executionId } }]);
    await session.close();
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
