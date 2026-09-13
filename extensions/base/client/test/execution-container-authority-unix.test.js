import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ExecutionContainerMismatchError,
  ExecutionOperationError,
  connect,
  workspace,
} from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

function fragmented(socket, frame) {
  const bytes = encode(frame);
  let written = Promise.resolve();
  for (const byte of bytes) {
    written = written.then(
      () =>
        new Promise((resolve, reject) => {
          socket.write(Uint8Array.of(byte), (error) => (error ? reject(error) : resolve()));
        }),
    );
  }
  return written;
}

test('credential-backed SQL never reaches an execution owned by another container', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-execution-authority-'));
  const socketPath = path.join(directory, 'host.sock');
  const selected = 'c'.repeat(64);
  const foreign = 'd'.repeat(64);
  const executionId = 'e'.repeat(32);
  const requests = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        requests.push(frame.payload.call);
        const payload =
          frame.payload.call === 'container_exec_credential'
            ? { reply: 'identity', with: executionId }
            : {
                reply: 'execution',
                with: {
                  id: executionId,
                  container_id: foreign,
                  running: true,
                  exit_code: 0,
                  pid: 73,
                  command: ['psql'],
                  user: 'postgres',
                  created_at_ms: 1,
                  started_at_ms: 2,
                  finished_at_ms: null,
                  result: null,
                },
              };
        void fragmented(socket, { channel: frame.channel, kind: KIND.response, payload });
      }
    });
    void fragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'postgres-authority-fixture',
        granted: ['containers:read', 'containers:execute', 'containers:input', 'credentials:expose-to-execution'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const session = await connect({ path: socketPath });
    const containers = workspace(session).containers;
    await assert.rejects(
      containers.execJsonLines(
        selected,
        9,
        {
          command: ['psql', '--file', '-'],
          credentials: [['PGPASSWORD', 'postgres.password']],
          input: ['select row_to_json(row) from rows row;\n'],
          maxLineBytes: 1024,
        },
        () => assert.fail('foreign output must not be delivered'),
      ),
      (error) =>
        error instanceof ExecutionOperationError &&
        error.phase === 'verify' &&
        error.cause instanceof ExecutionContainerMismatchError &&
        error.cause.expectedContainerId === selected &&
        error.cause.actualContainerId === foreign,
    );
    assert.deepEqual(requests, ['container_exec_credential', 'execution_inspect']);

    await assert.rejects(
      containers.resumeExecutionStreaming(
        executionId,
        { after: 12, expectedContainerId: selected },
        () => assert.fail('foreign resumed output must not be delivered'),
      ),
      (error) =>
        error instanceof ExecutionOperationError &&
        error.phase === 'output' &&
        error.after === 12 &&
        error.cause instanceof ExecutionContainerMismatchError,
    );
    assert.deepEqual(requests, [
      'container_exec_credential',
      'execution_inspect',
      'execution_inspect',
    ]);
    await session.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('cancel after create verifies exact container before stopping the stranded Postgres query', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-execution-abort-authority-'));
  const socketPath = path.join(directory, 'host.sock');
  const containerId = 'c'.repeat(64);
  const executionId = 'e'.repeat(32);
  const controller = new AbortController();
  const requests = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        requests.push(frame.payload.call);
        let payload;
        if (frame.payload.call === 'container_exec_credential') {
          payload = { reply: 'identity', with: executionId };
          controller.abort('query view closed during creation');
        } else if (frame.payload.call === 'execution_inspect') {
          payload = {
            reply: 'execution',
            with: {
              id: executionId,
              container_id: containerId,
              running: true,
              exit_code: 0,
              pid: 91,
              command: ['psql'],
              user: 'postgres',
              created_at_ms: 1,
              started_at_ms: 2,
              finished_at_ms: null,
              result: null,
            },
          };
        } else {
          payload = { reply: 'done' };
        }
        void fragmented(socket, { channel: frame.channel, kind: KIND.response, payload });
      }
    });
    void fragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'postgres-abort-authority-fixture',
        granted: ['containers:read', 'containers:execute', 'containers:input', 'credentials:expose-to-execution'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const session = await connect({ path: socketPath });
    await assert.rejects(
      workspace(session).containers.execJsonLines(
        containerId,
        11,
        {
          command: ['psql', '--file', '-'],
          credentials: [['PGPASSWORD', 'postgres.password']],
          input: ['select * from million_rows;\n'],
          maxLineBytes: 1024,
          signal: controller.signal,
        },
        () => assert.fail('cancelled query must not deliver rows'),
      ),
      (error) =>
        error instanceof ExecutionOperationError &&
        error.phase === 'verify' &&
        error.cause?.name === 'AbortError',
    );
    assert.deepEqual(requests, [
      'container_exec_credential',
      'execution_inspect',
      'execution_cancel',
    ]);
    await session.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
