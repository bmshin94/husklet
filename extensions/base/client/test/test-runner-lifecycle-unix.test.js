import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import {
  ExecutionOperationError,
  ExecutionOutputEndedEarlyError,
  connect,
  workspace,
} from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('test runner refuses output EOF from a live execution, cancels it, and reuses the session', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-test-runner-eof-'));
  const socketPath = path.join(directory, 'host.sock');
  const containerId = 'c'.repeat(64);
  const executionId = 'e'.repeat(32);
  const calls = [];
  const connections = new Set();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        calls.push(frame.payload.call);
        const payload =
          frame.payload.call === 'container_exec'
            ? { reply: 'identity', with: executionId }
            : frame.payload.call === 'execution_output'
              ? {
                  reply: 'execution_output',
                  with: { entries: [], next: 0, more: false, eof: true, gap: false },
                }
              : frame.payload.call === 'execution_inspect'
                ? {
                    reply: 'execution',
                    with: {
                      id: executionId,
                      container_id: containerId,
                      running: true,
                      exit_code: -1,
                      pid: 42,
                      command: ['npm', 'test', '--', '--reporter=jsonl'],
                      user: 'runner',
                      created_at_ms: 1,
                      started_at_ms: 2,
                      finished_at_ms: null,
                      result: null,
                    },
                  }
                : frame.payload.call === 'execution_cancel'
                  ? { reply: 'done' }
                  : {
                      reply: 'workspace',
                      with: { name: 'tests', image: 'toolbox', architecture: 'amd64' },
                    };
        const response = encode({ channel: frame.channel, kind: KIND.response, payload });
        for (const byte of response) socket.write(Buffer.of(byte));
      }
    });
    const greeting = encode({
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'test-runner',
        granted: ['containers:execute', 'containers:read', 'workspaces:read'],
      },
    });
    socket.write(greeting.subarray(0, 3));
    socket.write(greeting.subarray(3));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  try {
    const session = await connect({ path: socketPath });
    const host = workspace(session);
    let pages = 0;
    await assert.rejects(
      host.containers.execStreaming(
        containerId,
        9,
        { command: ['npm', 'test', '--', '--reporter=jsonl'], pageLimit: 1 },
        () => {
          pages += 1;
        },
      ),
      (error) => {
        assert(error instanceof ExecutionOperationError);
        assert.equal(error.phase, 'inspect');
        assert(
          error.cause instanceof ExecutionOutputEndedEarlyError,
          `unexpected inspect cause: ${error.cause?.stack ?? error.cause}`,
        );
        assert.equal(error.cause.executionId, executionId);
        return true;
      },
    );
    assert.equal(pages, 1, 'the bounded EOF page was delivered exactly once');
    assert.deepEqual(calls.slice(0, 4), [
      'container_exec',
      'execution_output',
      'execution_inspect',
      'execution_cancel',
    ]);
    assert.equal((await host.info()).name, 'tests', 'typed refusal keeps ordered session reusable');
    await session.close();
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('line runner retains only acknowledged partial stdout across fragmented socket loss', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-test-runner-partial-'));
  const socketPath = path.join(directory, 'host.sock');
  const executionId = 'e'.repeat(32);
  const server = net.createServer((socket) => {
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
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
                        bytes: [...Buffer.from('{"case":1')],
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
        socket.write(bytes.subarray(0, 5));
        socket.write(bytes.subarray(5));
      }
    });
    socket.write(
      encode({
        channel: CONTROL,
        kind: KIND.open,
        payload: {
          protocol: 1,
          peer: 'partial-runner',
          granted: ['containers:execute', 'containers:read'],
        },
      }),
    );
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const session = await connect({ path: socketPath });
    await assert.rejects(
      workspace(session).containers.execLines(
        'c'.repeat(64),
        2,
        { command: ['tests', '--jsonl'], maxLineBytes: 1024, pageLimit: 1, pollIntervalMs: 10 },
        () => assert.fail('unterminated record must not be delivered'),
      ),
      (error) => {
        assert(error instanceof ExecutionOperationError);
        assert.equal(error.after, 1);
        assert.deepEqual(error.partialLine, [...Buffer.from('{"case":1')]);
        assert.equal(error.lines, 0);
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('test runner failure preserves only its acknowledged output cursor over fragmented Unix framing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-test-runner-cursor-'));
  const socketPath = path.join(directory, 'host.sock');
  const containerId = 'c'.repeat(64);
  const executionId = 'e'.repeat(32);
  const calls = [];
  const connections = new Set();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        calls.push(frame.payload);
        const after = frame.payload.with?.after;
        const payload =
          frame.payload.call === 'container_exec'
            ? { reply: 'identity', with: executionId }
            : frame.payload.call === 'execution_output'
              ? {
                  reply: 'execution_output',
                  with: {
                    entries: [
                      {
                        sequence: after + 1,
                        timestamp_ms: after + 1,
                        stream: 'stdout',
                        bytes: [...Buffer.from(`{"case":${after + 1}}\n`)],
                      },
                    ],
                    next: after + 1,
                    more: after === 0,
                    eof: after !== 0,
                    gap: false,
                  },
                }
              : frame.payload.call === 'execution_cancel'
                ? { reply: 'done' }
                : {
                    reply: 'workspace',
                    with: { name: 'tests', image: 'toolbox', architecture: 'amd64' },
                  };
        const response = encode({ channel: frame.channel, kind: KIND.response, payload });
        for (const byte of response) socket.write(Buffer.of(byte));
      }
    });
    const greeting = encode({
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'test-runner-cursor',
        granted: ['containers:execute', 'containers:read', 'workspaces:read'],
      },
    });
    socket.write(greeting.subarray(0, 3));
    socket.write(greeting.subarray(3));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  try {
    const session = await connect({ path: socketPath });
    const host = workspace(session);
    const committed = [];
    await assert.rejects(
      host.containers.execStreaming(
        containerId,
        4,
        { command: ['tests', '--jsonl'], pageLimit: 1, pollIntervalMs: 10 },
        async (page) => {
          if (page.next === 2) throw new Error('result database unavailable');
          committed.push(page.next);
        },
      ),
      (error) => {
        assert(error instanceof ExecutionOperationError);
        assert.equal(error.executionId, executionId);
        assert.equal(error.phase, 'output');
        assert.equal(error.after, 1);
        return true;
      },
    );
    assert.deepEqual(committed, [1]);
    assert.deepEqual(
      calls.filter(({ call }) => call === 'execution_output').map(({ with: value }) => value.after),
      [0, 1],
    );
    assert.equal(calls.filter(({ call }) => call === 'execution_cancel').length, 1);
    assert.equal((await host.info()).name, 'tests');
    await session.close();
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('resumed test output cannot report completion before the exact execution exits', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-test-runner-resume-exit-'));
  const socketPath = path.join(directory, 'host.sock');
  const executionId = 'f'.repeat(32);
  const containerId = 'a'.repeat(64);
  const connections = new Set();
  const calls = [];
  let accepted = 0;
  const server = net.createServer((socket) => {
    const connection = ++accepted;
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        calls.push({ connection, ...frame.payload });
        const after = frame.payload.with?.after;
        let payload;
        if (frame.payload.call === 'execution_output') {
          payload = {
            reply: 'execution_output',
            with:
              connection === 1
                ? {
                    entries: [
                      {
                        sequence: 18,
                        timestamp_ms: 18,
                        stream: 'stdout',
                        bytes: [...Buffer.from('ok 1000000\n')],
                      },
                      {
                        sequence: 19,
                        timestamp_ms: 19,
                        stream: 'stderr',
                        bytes: [...Buffer.from('finishing workers\n')],
                      },
                    ],
                    next: 19,
                    more: false,
                    eof: true,
                    gap: false,
                  }
                : {
                    entries: [],
                    next: after,
                    more: false,
                    eof: true,
                    gap: false,
                  },
          };
        } else if (frame.payload.call === 'execution_inspect') {
          payload = {
            reply: 'execution',
            with: {
              id: executionId,
              container_id: containerId,
              running: connection === 1,
              exit_code: 0,
              pid: connection === 1 ? 73 : 0,
              command: ['tests', '--all'],
              user: '',
              created_at_ms: 1,
              started_at_ms: 2,
              finished_at_ms: connection === 1 ? null : 3,
              result: connection === 1 ? null : { kind: 'code', value: 0 },
            },
          };
        }
        const reply = encode({ channel: frame.channel, kind: KIND.response, payload });
        for (const byte of reply) socket.write(Buffer.of(byte));
      }
    });
    const greeting = encode({
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: `test-runner-resume-${connection}`,
        granted: ['containers:read'],
      },
    });
    socket.write(greeting.subarray(0, 2));
    socket.write(greeting.subarray(2));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath });
    const committed = [];
    let failure;
    try {
      await workspace(first).containers.resumeExecutionStreaming(
        executionId,
        { after: 17, pageLimit: 2 },
        (page) => committed.push(page.next),
      );
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof ExecutionOperationError);
    assert.equal(failure.phase, 'inspect');
    assert.equal(failure.after, 19);
    assert.equal(failure.cause?.name, 'ExecutionOutputEndedEarlyError');
    assert.deepEqual(committed, [19], 'mixed output page is acknowledged exactly once');
    await first.close();

    const resumed = await connect({ path: socketPath });
    const replayed = [];
    const finished = await workspace(resumed).containers.resumeExecutionStreaming(
      failure.executionId,
      { after: failure.after, pageLimit: 2 },
      (page) => replayed.push(...page.entries),
    );
    assert.deepEqual(replayed, [], 'the acknowledged million-row transcript must not be replayed');
    assert.equal(finished.complete, true);
    assert.equal(finished.next, 19);
    assert.equal(finished.execution.id, executionId);
    assert.equal(finished.execution.running, false);
    assert.equal(finished.execution.exit_code, 0);
    await resumed.close();
    assert.deepEqual(
      calls.map(({ connection, call, with: value }) => [connection, call, value?.after]),
      [
        [1, 'execution_output', 17],
        [1, 'execution_inspect', undefined],
        [2, 'execution_output', 19],
        [2, 'execution_inspect', undefined],
      ],
    );
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
