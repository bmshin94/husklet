import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import {
  connect,
  ExtensionError,
  TerminalCommandInputOperationError,
  TerminalCommandOperationError,
  TerminalCommandStartOperationError,
  TerminalCommandStartProtocolError,
  workspace,
} from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

const id = 'e'.repeat(32);
const owner = 'a'.repeat(32);
const pane = { slot: 'term-1', generation: 3, revision: 9 };
const running = {
  id,
  owner,
  ...pane,
  running: true,
  exit_code: 0,
  pid: 41,
  command: ['sh', '-lc', 'printf ready; exit 17'],
};

function fragmented(socket, frame) {
  const bytes = encode(frame);
  for (let offset = 0; offset < bytes.length; offset += 2) {
    socket.write(bytes.subarray(offset, offset + 2));
  }
}

test('supervised terminal command is authoritative over fragmented real Unix framing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-terminal-command-'));
  const socketPath = path.join(directory, 'host.sock');
  const calls = [];
  let output = 0;
  const server = net.createServer((socket) => {
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.channel !== 2) continue;
        calls.push(frame.payload);
        const call = frame.payload.call;
        let payload;
        if (call === 'terminal_command_start') {
          assert.match(frame.payload.with.operation, /^[0-9a-f]{32}$/);
          assert.deepEqual(frame.payload.with, {
            operation: frame.payload.with.operation,
            ...pane,
            command: running.command,
            stdin: true,
          });
          payload = {
            reply: 'terminal_command_start',
            with: { operation: frame.payload.with.operation, command: running },
          };
        } else if (call === 'terminal_command_write') {
          assert.deepEqual(frame.payload.with, {
            id,
            owner,
            ...pane,
            operation: frame.payload.with.operation,
            offset: 0,
            contents: [113, 10],
          });
          assert.match(frame.payload.with.operation, /^[0-9a-f]{32}$/);
          payload = {
            reply: 'terminal_command_input',
            with: {
              id,
              operation: frame.payload.with.operation,
              offset: 0,
              committed: 2,
              closed: false,
            },
          };
        } else if (call === 'terminal_command_close_input') {
          assert.equal(frame.payload.with.offset, 2);
          payload = {
            reply: 'terminal_command_input',
            with: {
              id,
              operation: frame.payload.with.operation,
              offset: 2,
              committed: 0,
              closed: true,
            },
          };
        } else if (call === 'terminal_command_output') {
          output += 1;
          payload = {
            reply: 'terminal_command_output',
            with: {
              id,
              owner,
              ...pane,
              output: {
                entries:
                  output === 1
                    ? [{ sequence: 1, timestamp_ms: 1, stream: 'stdout', bytes: [114, 101] }]
                    : [
                        {
                          sequence: 2,
                          timestamp_ms: 2,
                          stream: 'stdout',
                          bytes: [97, 100, 121, 10],
                        },
                      ],
                next: output,
                more: false,
                eof: output === 2,
                gap: false,
              },
            },
          };
        } else if (call === 'terminal_command_wait') {
          payload = {
            reply: 'terminal_command',
            with: { ...running, running: false, exit_code: 17, pid: 0 },
          };
        } else {
          throw new Error(`unexpected ${call}`);
        }
        fragmented(socket, { channel: 2, kind: KIND.response, payload });
      }
    });
    fragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'terminal-command-test',
        granted: ['terminals:process-control', 'terminals:output', 'terminals:input'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const session = await connect({ path: socketPath });
    const result = await workspace(session).terminal.commandText(pane, {
      command: running.command,
      input: 'q\n',
      maxBytes: 64,
      pollIntervalMs: 10,
    });
    assert.equal(result.stdout, 'ready\n');
    assert.equal(result.stderr, '');
    assert.equal(result.command.exit_code, 17);
    assert.equal(result.command.running, false);
    assert.deepEqual(
      calls.map(({ call }) => call),
      [
        'terminal_command_start',
        'terminal_command_write',
        'terminal_command_close_input',
        'terminal_command_output',
        'terminal_command_output',
        'terminal_command_wait',
      ],
    );
    await session.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('lost command-start reply recovers one process and rejects a hostile operation receipt', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-terminal-start-retry-'));
  const socketPath = path.join(directory, 'host.sock');
  const received = [];
  let connection = 0;
  const server = net.createServer((socket) => {
    const current = ++connection;
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        assert.equal(frame.payload.call, 'terminal_command_start');
        received.push(frame.payload.with);
        if (current === 1) {
          socket.destroy();
          continue;
        }
        fragmented(socket, {
          channel: frame.channel,
          kind: KIND.response,
          payload: {
            reply: 'terminal_command_start',
            with: {
              operation:
                current === 2 || current === 4 ? frame.payload.with.operation : 'f'.repeat(32),
              command:
                current === 4
                  ? { ...running, command: ['sh', '-lc', 'rm -rf /tmp/data'] }
                  : running,
            },
          },
        });
      }
    });
    fragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'terminal-command-start-retry',
        granted: ['terminals:process-control'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath });
    let ambiguous;
    try {
      await workspace(first).terminal.commandStart(pane, running.command);
      assert.fail('reply loss must retain exact start recovery authority');
    } catch (error) {
      assert(error instanceof TerminalCommandStartOperationError);
      ambiguous = error;
    }

    const second = await connect({ path: socketPath });
    assert.deepEqual(await workspace(second).terminal.recoverCommandStart(ambiguous), running);
    assert.deepEqual(
      received[1],
      received[0],
      'recovery must reuse the exact creation token and request',
    );
    await second.close();

    const third = await connect({ path: socketPath });
    await assert.rejects(
      workspace(third).terminal.commandStart(pane, running.command, {
        operation: 'e'.repeat(32),
      }),
      /different start operation/,
    );
    await third.close();

    const fourth = await connect({ path: socketPath });
    await assert.rejects(
      workspace(fourth).terminal.commandStart(pane, running.command, {
        operation: 'd'.repeat(32),
      }),
      (error) => {
        assert(error instanceof TerminalCommandStartProtocolError);
        assert.deepEqual(error.expected.command, running.command);
        assert.deepEqual(error.received.command, ['sh', '-lc', 'rm -rf /tmp/data']);
        return true;
      },
    );
    await fourth.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('lost supervised input reply carries one exact retry across a fragmented reconnect', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-terminal-input-retry-'));
  const socketPath = path.join(directory, 'host.sock');
  const received = [];
  let connection = 0;
  const server = net.createServer((socket) => {
    const current = ++connection;
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.channel !== 2) continue;
        assert(
          frame.payload.call === 'terminal_command_write' ||
            frame.payload.call === 'terminal_command_close_input',
        );
        received.push(frame.payload.with);
        if (current === 1 || current === 3) {
          socket.destroy();
          continue;
        }
        fragmented(socket, {
          channel: 2,
          kind: KIND.response,
          payload: {
            reply: 'terminal_command_input',
            with: {
              id,
              operation: frame.payload.with.operation,
              offset: frame.payload.with.offset,
              committed: frame.payload.call === 'terminal_command_write' ? 3 : 0,
              closed: frame.payload.call === 'terminal_command_close_input',
            },
          },
        });
      }
    });
    fragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'terminal-command-input-retry',
        granted: ['terminals:input'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath });
    let ambiguous;
    try {
      await workspace(first).terminal.commandWrite(running, [1, 2, 3], { offset: 7 });
      assert.fail('reply loss must remain explicit');
    } catch (error) {
      assert(error instanceof TerminalCommandInputOperationError);
      ambiguous = error;
    }
    assert.deepEqual(ambiguous.input, [1, 2, 3]);
    assert.equal(ambiguous.offset, 7);
    assert.equal(ambiguous.close, false);
    assert.throws(() => {
      ambiguous.offset = 0;
    }, TypeError);
    assert.throws(
      () =>
        workspace(first).terminal.recoverCommandInput(
          new TerminalCommandInputOperationError(
            ambiguous.command,
            ambiguous.operation,
            ambiguous.offset,
            ambiguous.input,
            ambiguous.close,
            new Error('forged'),
          ),
        ),
      /requires its exact input operation error/,
    );

    const second = await connect({ path: socketPath });
    const receipt = await workspace(second).terminal.recoverCommandInput(ambiguous);
    assert.deepEqual(receipt, {
      id,
      operation: ambiguous.operation,
      offset: 7,
      committed: 3,
      closed: false,
    });
    assert.deepEqual(received[1], received[0], 'reconnect must replay only the exact operation');
    second.close();

    const third = await connect({ path: socketPath });
    let ambiguousClose;
    try {
      await workspace(third).terminal.commandCloseInput(running, { offset: 10 });
      assert.fail('EOF reply loss must remain explicit');
    } catch (error) {
      assert(error instanceof TerminalCommandInputOperationError);
      ambiguousClose = error;
    }
    assert.equal(ambiguousClose.close, true);
    assert.equal(ambiguousClose.input, undefined);
    third.close();

    const fourth = await connect({ path: socketPath });
    const closed = await workspace(fourth).terminal.recoverCommandInput(ambiguousClose);
    assert.deepEqual(closed, {
      id,
      operation: ambiguousClose.operation,
      offset: 10,
      committed: 0,
      closed: true,
    });
    assert.deepEqual(
      received[3],
      received[2],
      'reconnect must replay only the exact EOF operation',
    );
    fourth.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('aborting idle command polling immediately cancels the exact supervised command', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-terminal-command-abort-'));
  const socketPath = path.join(directory, 'host.sock');
  const calls = [];
  const server = net.createServer((socket) => {
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        calls.push(frame.payload);
        const call = frame.payload.call;
        const payload =
          call === 'terminal_command_start'
            ? {
                reply: 'terminal_command_start',
                with: { operation: frame.payload.with.operation, command: running },
              }
            : call === 'terminal_command_output'
              ? {
                  reply: 'terminal_command_output',
                  with: {
                    id,
                    owner,
                    ...pane,
                    output: { entries: [], next: 0, more: false, eof: false, gap: false },
                  },
                }
              : call === 'terminal_command_cancel'
                ? {
                    reply: 'terminal_command',
                    with: { ...running, running: false, exit_code: 130, pid: 0 },
                  }
                : (() => {
                    throw new Error(`unexpected ${call}`);
                  })();
        fragmented(socket, { channel: frame.channel, kind: KIND.response, payload });
      }
    });
    fragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'terminal-command-abort',
        granted: ['terminals:process-control', 'terminals:output'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const session = await connect({ path: socketPath });
    const controller = new AbortController();
    const started = Date.now();
    const operation = workspace(session).terminal.commandText(pane, {
      command: running.command,
      maxBytes: 64,
      pollIntervalMs: 60_000,
      signal: controller.signal,
      cancelSignal: 'SIGINT',
      cancelTimeoutMs: 1_000,
    });
    while (!calls.some(({ call }) => call === 'terminal_command_output'))
      await new Promise((resolve) => setImmediate(resolve));
    controller.abort('agent deadline');
    await assert.rejects(operation, TerminalCommandOperationError);
    assert(Date.now() - started < 1_000, 'abort must not wait for the 60 second poll interval');
    assert.deepEqual(calls.at(-1), {
      call: 'terminal_command_cancel',
      with: { id, owner, ...pane, signal: 'SIGINT', timeout_ms: 1_000 },
    });
    await session.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('oversized supervised output is rejected before PostgreSQL-style consumers receive it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-terminal-output-bound-'));
  const socketPath = path.join(directory, 'host.sock');
  let request = 0;
  const server = net.createServer((socket) => {
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        request += 1;
        const response = encode({
          channel: frame.channel,
          kind: KIND.response,
          payload: {
            reply: 'terminal_command_output',
            with: {
              id,
              owner,
              ...pane,
              output: {
                entries: [
                  {
                    sequence: 1,
                    timestamp_ms: 1,
                    stream: 'stdout',
                    bytes: new Array(256 * 1024 + (request === 1 ? 0 : 1)).fill(120),
                  },
                ],
                next: 1,
                more: false,
                eof: false,
                gap: false,
              },
            },
          },
        });
        socket.write(response.subarray(0, 13));
        setImmediate(() => socket.write(response.subarray(13)));
      }
    });
    fragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'terminal-output-bound',
        granted: ['terminals:output'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const session = await connect({ path: socketPath });
    const boundary = await workspace(session).terminal.commandOutput(running, { limit: 1 });
    assert.equal(boundary.output.entries[0].bytes.length, 256 * 1024);
    await assert.rejects(
      workspace(session).terminal.commandOutput(running, { limit: 1 }),
      /exceeding 262144 bytes/,
    );
    await session.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('supervised command output survives reconnect and originating pane replacement', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-terminal-command-resume-'));
  const socketPath = path.join(directory, 'host.sock');
  const requests = [];
  const connections = new Set();
  let accepted = 0;
  const server = net.createServer((socket) => {
    accepted += 1;
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        requests.push(frame.payload);
        const payload =
          frame.payload.call === 'terminal_command_start'
            ? {
                reply: 'terminal_command_start',
                with: { operation: frame.payload.with.operation, command: running },
              }
            : {
                reply: 'terminal_command_output',
                with: {
                  id,
                  owner,
                  ...pane,
                  output: {
                    entries: [
                      {
                        sequence: 8,
                        timestamp_ms: 8,
                        stream: 'stdout',
                        bytes: [100, 111, 110, 101, 10],
                      },
                    ],
                    next: 8,
                    more: false,
                    eof: true,
                    gap: false,
                  },
                },
              };
        fragmented(socket, { channel: frame.channel, kind: KIND.response, payload });
      }
    });
    fragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: `terminal-command-resume-${accepted}`,
        granted: ['terminals:process-control', 'terminals:output'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath });
    const command = await workspace(first).terminal.commandStart(pane, running.command);
    await first.close();

    // The UI may now contain another occupant at term-1. The creation snapshot
    // remains part of the command capability and is intentionally replayed.
    const resumed = await connect({ path: socketPath });
    const page = await workspace(resumed).terminal.commandOutput(command, { after: 7, limit: 1 });
    assert.equal(page.output.next, 8);
    assert.equal(new TextDecoder().decode(Uint8Array.from(page.output.entries[0].bytes)), 'done\n');
    assert.deepEqual(requests[1], {
      call: 'terminal_command_output',
      with: { id, owner, ...pane, after: 7, limit: 1 },
    });
    assert.equal(accepted, 2);
    await resumed.close();
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('a command from a replaced installation is denied over fragmented framing without poisoning the session', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-terminal-command-incarnation-'));
  const socketPath = path.join(directory, 'host.sock');
  const requests = [];
  const server = net.createServer((socket) => {
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        requests.push(frame.payload);
        const payload =
          frame.payload.call === 'terminal_command_output'
            ? {
                error: 'denied',
                capability: 'terminals:output',
                detail: 'terminal command belongs to another extension installation',
              }
            : {
                reply: 'workspace',
                with: { name: 'dev', architecture: 'arm64', image: 'alpine' },
              };
        fragmented(socket, {
          channel: frame.channel,
          kind: KIND.response,
          ...(payload.error ? { flags: 3 } : {}),
          payload,
        });
      }
    });
    fragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'replacement-installation',
        granted: ['terminals:output', 'workspaces:read'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const session = await connect({ path: socketPath });
    await assert.rejects(
      workspace(session).terminal.commandOutput(running, { after: 0, limit: 1 }),
      (error) =>
        error instanceof ExtensionError &&
        error.kind === 'denied' &&
        error.message.includes('another extension installation'),
    );
    assert.equal((await workspace(session).info()).name, 'dev');
    assert.deepEqual(requests[0], {
      call: 'terminal_command_output',
      with: { id, owner, ...pane, after: 0, limit: 1 },
    });
    assert.equal(requests[1].call, 'workspace_info');
    await session.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('large Git review output exposes an exact reconnect cursor after fragmented disconnect', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-git-review-resume-'));
  const socketPath = path.join(directory, 'host.sock');
  const connections = new Set();
  const requests = [];
  let accepted = 0;
  let firstOutput = true;
  const gitCommand = ['git', 'diff', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];
  const server = net.createServer((socket) => {
    accepted += 1;
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    const connection = accepted;
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        requests.push(frame.payload);
        if (frame.payload.call === 'terminal_command_start') {
          fragmented(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: {
              reply: 'terminal_command_start',
              with: {
                operation: frame.payload.with.operation,
                command: { ...running, command: gitCommand },
              },
            },
          });
        } else if (frame.payload.call === 'terminal_command_output' && connection === 1) {
          if (firstOutput) {
            firstOutput = false;
            fragmented(socket, {
              channel: frame.channel,
              kind: KIND.response,
              payload: {
                reply: 'terminal_command_output',
                with: {
                  id,
                  owner,
                  ...pane,
                  output: {
                    entries: [
                      {
                        sequence: 1,
                        timestamp_ms: 1,
                        stream: 'stdout',
                        bytes: Array.from(new TextEncoder().encode('diff --git a/a b/a\n')),
                      },
                    ],
                    next: 1,
                    more: false,
                    eof: false,
                    gap: false,
                  },
                },
              },
            });
          } else {
            socket.destroy();
          }
        } else if (frame.payload.call === 'terminal_command_cancel' && connection === 1) {
          socket.destroy();
        } else if (frame.payload.call === 'terminal_command_output' && connection === 2) {
          fragmented(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: {
              reply: 'terminal_command_output',
              with: {
                id,
                owner,
                ...pane,
                output: {
                  entries: [
                    {
                      sequence: 2,
                      timestamp_ms: 2,
                      stream: 'stderr',
                      bytes: Array.from(new TextEncoder().encode('warning: recovered\n')),
                    },
                  ],
                  next: 2,
                  more: false,
                  eof: true,
                  gap: false,
                },
              },
            },
          });
        } else if (frame.payload.call === 'terminal_command_wait' && connection === 2) {
          fragmented(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: {
              reply: 'terminal_command',
              with: { ...running, command: gitCommand, running: false, exit_code: 0, pid: 0 },
            },
          });
        }
      }
    });
    fragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: `git-review-${connection}`,
        granted: ['terminals:process-control', 'terminals:output'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath });
    let failure;
    try {
      await workspace(first).terminal.commandText(pane, {
        command: gitCommand,
        maxBytes: 1024 * 1024,
        pageLimit: 1,
        pollIntervalMs: 10,
      });
    } catch (error) {
      failure = error;
    }
    assert(
      failure instanceof TerminalCommandOperationError,
      `${failure?.constructor?.name}: ${failure}`,
    );
    assert.equal(failure.phase, 'output');
    assert.equal(failure.after, 1);
    assert.equal(failure.command.id, id);
    assert.deepEqual(failure.command.command, gitCommand);
    assert.deepEqual(failure.stdout, [...new TextEncoder().encode('diff --git a/a b/a\n')]);
    assert.deepEqual(failure.stderr, []);
    assert(Object.isFrozen(failure.stdout));
    assert(Object.isFrozen(failure.stderr));
    assert(Object.isFrozen(failure.command));
    assert(Object.isFrozen(failure.command.command));

    const resumed = await connect({ path: socketPath });
    assert.equal(failure.resume.maxBytes, 1024 * 1024);
    assert(Object.isFrozen(failure.resume));
    const recovered = JSON.parse(JSON.stringify(failure.resume));
    assert.deepEqual(recovered, failure.resume);
    const remainder = await workspace(resumed).terminal.resumeCommandText(recovered, {
      pageLimit: 1,
    });
    assert.equal(remainder.stdout, 'diff --git a/a b/a\n');
    assert.equal(remainder.stderr, 'warning: recovered\n');
    assert.equal(remainder.command.running, false);
    assert.deepEqual(requests.at(-1), {
      call: 'terminal_command_wait',
      with: { id, owner, ...pane, timeout_ms: 30000 },
    });
    await resumed.close();
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('repeated Unix disconnects cannot widen a supervised command output budget', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-command-budget-resume-'));
  const socketPath = path.join(directory, 'host.sock');
  const connections = new Set();
  let accepted = 0;
  const pages = [
    { sequence: 1, bytes: [1, 2, 3] },
    { sequence: 2, bytes: [4, 5] },
    { sequence: 3, bytes: [6, 7] },
  ];
  const server = net.createServer((socket) => {
    const connection = ++accepted;
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    let reads = 0;
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        if (frame.payload.call === 'terminal_command_start') {
          fragmented(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: {
              reply: 'terminal_command_start',
              with: { operation: frame.payload.with.operation, command: running },
            },
          });
        } else if (frame.payload.call === 'terminal_command_output') {
          if (reads++ > 0) {
            socket.destroy();
            continue;
          }
          const entry = pages[connection - 1];
          fragmented(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: {
              reply: 'terminal_command_output',
              with: {
                id,
                owner,
                ...pane,
                output: {
                  entries: [
                    {
                      sequence: entry.sequence,
                      timestamp_ms: entry.sequence,
                      stream: 'stdout',
                      bytes: entry.bytes,
                    },
                  ],
                  next: entry.sequence,
                  more: false,
                  eof: false,
                  gap: false,
                },
              },
            },
          });
        }
      }
    });
    fragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: `bounded-agent-${connection}`,
        granted: ['terminals:process-control', 'terminals:output'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath });
    let failure;
    try {
      await workspace(first).terminal.commandText(pane, {
        command: running.command,
        maxBytes: 6,
        pageLimit: 1,
        pollIntervalMs: 10,
      });
    } catch (error) {
      failure = error;
    }
    assert(
      failure instanceof TerminalCommandOperationError,
      `${failure?.constructor?.name}: ${failure}`,
    );
    assert.equal(failure.resume.maxBytes, 6);
    await first.close();

    const second = await connect({ path: socketPath });
    try {
      await workspace(second).terminal.resumeCommandText(failure.resume, {
        pageLimit: 1,
        pollIntervalMs: 10,
      });
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof TerminalCommandOperationError);
    assert.equal(failure.resume.maxBytes, 6);
    assert.deepEqual(failure.resume.stdout, [1, 2, 3, 4, 5]);
    await second.close();

    const third = await connect({ path: socketPath });
    await assert.rejects(
      workspace(third).terminal.resumeCommandText(failure.resume, {
        pageLimit: 1,
        pollIntervalMs: 10,
      }),
      (error) =>
        error instanceof TerminalCommandOperationError &&
        error.resume.maxBytes === 6 &&
        error.resume.after === 2 &&
        error.resume.stdout.length === 5 &&
        error.cause instanceof RangeError,
    );
    await third.close();
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('an aborted Unix recovery cancels its exact supervised command before returning', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-command-abort-resume-'));
  const socketPath = path.join(directory, 'host.sock');
  const connections = new Set();
  const requests = [];
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        requests.push(frame.payload);
        assert.equal(frame.payload.call, 'terminal_command_cancel');
        assert.deepEqual(frame.payload.with, {
          id,
          owner,
          ...pane,
          signal: 'SIGINT',
          timeout_ms: 321,
        });
        fragmented(socket, {
          channel: frame.channel,
          kind: KIND.response,
          payload: {
            reply: 'terminal_command',
            with: { ...running, running: false, exit_code: 130, pid: 0 },
          },
        });
      }
    });
    fragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'aborted-recovery',
        granted: ['terminals:process-control', 'terminals:output'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const session = await connect({ path: socketPath });
    const cancellation = new AbortController();
    cancellation.abort('agent deadline');
    await assert.rejects(
      workspace(session).terminal.resumeCommandText(
        {
          version: 1,
          command: running,
          after: 0,
          stdout: [],
          stderr: [],
          maxBytes: 1024,
        },
        {
          signal: cancellation.signal,
          cancelSignal: 'SIGINT',
          cancelTimeoutMs: 321,
        },
      ),
      (error) => {
        assert(error instanceof TerminalCommandOperationError);
        assert.equal(error.cause.name, 'AbortError');
        assert.equal(error.cause.cause, 'agent deadline');
        assert.equal(error.command.running, false);
        assert.equal(error.command.exit_code, 130);
        assert.equal(error.after, 0);
        return true;
      },
    );
    assert.equal(requests.length, 1);
    await session.close();
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('empty output pages retain one cross-reconnect budget and cancel at exhaustion over fragmented Unix', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-command-page-budget-'));
  const socketPath = path.join(directory, 'host.sock');
  const connections = new Set();
  const requests = [];
  let incarnation = 0;
  const server = net.createServer((socket) => {
    const current = ++incarnation;
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        requests.push([current, frame.payload.call]);
        if (frame.payload.call === 'terminal_command_start') {
          fragmented(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: {
              reply: 'terminal_command_start',
              with: { operation: frame.payload.with.operation, command: running },
            },
          });
        } else if (frame.payload.call === 'terminal_command_output') {
          fragmented(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: {
              reply: 'terminal_command_output',
              with: {
                id,
                owner,
                ...pane,
                output: {
                  entries: [],
                  next: frame.payload.with.after,
                  more: false,
                  eof: false,
                  gap: false,
                },
              },
            },
          });
          if (current < 3) setImmediate(() => socket.destroy());
        } else if (frame.payload.call === 'terminal_command_cancel') {
          fragmented(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: {
              reply: 'terminal_command',
              with: { ...running, running: false, exit_code: 143, pid: 0 },
            },
          });
        }
      }
    });
    fragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: `page-budget-${current}`,
        granted: ['terminals:process-control', 'terminals:output'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath });
    let failure;
    await assert.rejects(
      workspace(first).terminal.commandText(pane, {
        command: running.command,
        maxBytes: 1_024,
        maxPages: 3,
        pageLimit: 1,
        pollIntervalMs: 10,
      }),
      (error) => {
        failure = error;
        return error instanceof TerminalCommandOperationError && error.resume.pages === 1;
      },
    );
    await first.close().catch(() => {});

    const second = await connect({ path: socketPath });
    await assert.rejects(
      workspace(second).terminal.resumeCommandText(JSON.parse(JSON.stringify(failure.resume)), {
        pollIntervalMs: 10,
      }),
      (error) => {
        failure = error;
        return (
          error instanceof TerminalCommandOperationError &&
          error.resume.pages === 2 &&
          error.resume.maxPages === 3
        );
      },
    );
    await second.close().catch(() => {});

    const third = await connect({ path: socketPath });
    await assert.rejects(
      workspace(third).terminal.resumeCommandText(JSON.parse(JSON.stringify(failure.resume)), {
        pollIntervalMs: 10,
      }),
      (error) =>
        error instanceof TerminalCommandOperationError &&
        error.resume.pages === 3 &&
        error.resume.maxPages === 3 &&
        error.command.running === false &&
        error.cause instanceof RangeError,
    );
    assert.deepEqual(
      requests.map((entry) => entry[1]),
      [
        'terminal_command_start',
        'terminal_command_output',
        'terminal_command_output',
        'terminal_command_output',
        'terminal_command_cancel',
      ],
    );
    await assert.rejects(
      workspace(third).terminal.resumeCommandText({ ...failure.resume, pages: 4, maxPages: 3 }),
      /invalid page budget/,
    );
    await assert.rejects(
      workspace(third).terminal.resumeCommandText(failure.resume, { maxPages: 4 }),
      /maxPages must be between/,
    );
    await third.close();
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
