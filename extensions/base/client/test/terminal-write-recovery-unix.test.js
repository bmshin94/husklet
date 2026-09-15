import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import {
  TerminalInputReconciliationProtocolError,
  TerminalOperationError,
  connect,
  workspace,
} from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('persisted raw-input recovery survives repeated reply loss without typing twice', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-terminal-recovery-'));
  const socketPath = path.join(directory, 'host.sock');
  const connections = new Set();
  let accepted = 0;
  let connectionNumber = 0;
  const writer = '0123456789abcdef0123456789abcdef';
  const screen = (revision, line) => ({
    slot: 'agent',
    generation: 9,
    revision,
    lifecycle: 'live',
    columns: 80,
    rows: 24,
    lines: [line],
    cursor_column: 0,
    cursor_row: 0,
    truncated: false,
  });
  const sendFragmented = (socket, frame) => {
    const bytes = encode(frame);
    for (const byte of bytes) socket.write(Uint8Array.of(byte));
  };
  const server = net.createServer((socket) => {
    const number = ++connectionNumber;
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        const reply = (payload) =>
          sendFragmented(socket, { channel: frame.channel, kind: KIND.response, payload });
        if (
          frame.payload.call === 'event_subscribe' ||
          frame.payload.call === 'event_unsubscribe'
        ) {
          reply({ reply: 'done' });
        } else if (frame.payload.call === 'terminal_read_pane') {
          reply({
            reply: 'text',
            with: screen(number === 1 ? 4 : 5, number === 1 ? '$ ' : 'timer tick'),
          });
        } else if (frame.payload.call === 'pane_list') {
          reply({
            reply: 'panes',
            with: {
              panes: [
                {
                  slot: 'agent',
                  generation: 9,
                  revision: 5,
                  kind: 'terminal',
                  provider: null,
                  tab: null,
                  title: 'Agent',
                  focused: true,
                },
              ],
              truncated: false,
            },
          });
        } else if (frame.payload.call === 'terminal_input_open') {
          reply({ reply: 'terminal_input_writer', with: { writer, next_sequence: 0 } });
        } else if (frame.payload.call === 'terminal_write_pane') {
          assert.deepEqual(frame.payload.with.contents, [0x03]);
          assert.equal(frame.payload.with.writer, writer);
          assert.equal(frame.payload.with.sequence, 0);
          if (accepted === 0) {
            accepted += 1;
            socket.destroy(); // The PTY accepted the byte; every reply byte is lost.
          } else if (number === 2) {
            socket.destroy(); // The replay was recognized, but its receipt was lost again.
          } else {
            reply({
              reply: 'terminal_pane_input',
              with: {
                slot: 'agent',
                generation: 9,
                revision: 4,
                writer,
                sequence: 0,
                committed: 1,
              },
            });
          }
        }
      }
    });
    sendFragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: `terminal-recovery-${number}`,
        granted: ['panes:observe', 'terminals:output', 'terminals:input'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath });
    await assert.rejects(
      workspace(first).terminal.reconcileWriteFailure({
        version: 2,
        slot: 'agent',
        generation: 9,
        revision: 4,
        writer,
        sequence: 0,
        input: [0x03],
      }),
      /recovery token/,
    );
    assert.equal(accepted, 0, 'an unknown token version fails before terminal authority is framed');
    let failure;
    await assert.rejects(
      workspace(first).terminal.writeObservedAndWait(screen(4, '$ '), [0x03], { timeoutMs: 1_000 }),
      (error) => {
        assert(error instanceof TerminalOperationError);
        assert.equal(error.result.written, 'unknown');
        failure = error;
        return true;
      },
    );
    await first.close();
    const recoveryToken = JSON.parse(JSON.stringify(failure.result.recovery));
    assert.deepEqual(recoveryToken, {
      version: 1,
      slot: 'agent',
      generation: 9,
      revision: 4,
      writer,
      sequence: 0,
      input: [0x03],
    });

    const interrupted = await connect({ path: socketPath });
    await assert.rejects(
      workspace(interrupted).terminal.reconcileWriteFailure(recoveryToken),
      /closed|ended|reset/i,
    );
    await interrupted.close();

    const resumed = await connect({ path: socketPath });
    const recovery = await workspace(resumed).terminal.reconcileWriteFailure(recoveryToken);
    assert.equal(recovery.outcome, 'advanced');
    assert.equal(recovery.current.text, 'timer tick');
    assert.deepEqual(recovery.receipt, {
      slot: 'agent',
      generation: 9,
      revision: 4,
      writer,
      sequence: 0,
      committed: 1,
    });
    assert.equal(accepted, 1, 'the host receipt prevents a second PTY write');
    await resumed.close();
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('raw-input recovery rejects a backward same-generation pane cursor over fragmented Unix', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-terminal-backward-'));
  const socketPath = path.join(directory, 'host.sock');
  const writer = 'fedcba9876543210fedcba9876543210';
  const server = net.createServer((socket) => {
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        const reply = (payload) => {
          const bytes = encode({ channel: frame.channel, kind: KIND.response, payload });
          for (const byte of bytes) socket.write(Uint8Array.of(byte));
        };
        if (frame.payload.call === 'terminal_write_pane') {
          reply({
            reply: 'terminal_pane_input',
            with: {
              slot: 'agent',
              generation: 9,
              revision: 4,
              writer,
              sequence: 0,
              committed: 1,
            },
          });
        } else if (frame.payload.call === 'pane_list') {
          reply({
            reply: 'panes',
            with: {
              panes: [
                {
                  slot: 'agent',
                  generation: 9,
                  revision: 3,
                  kind: 'terminal',
                  provider: null,
                  tab: null,
                  title: 'Agent',
                  focused: true,
                },
              ],
              truncated: false,
            },
          });
        } else if (frame.payload.call === 'terminal_read_pane') {
          reply({
            reply: 'text',
            with: {
              slot: 'agent',
              generation: 9,
              revision: 3,
              lifecycle: 'live',
              columns: 80,
              rows: 24,
              lines: ['stale'],
              cursor_column: 0,
              cursor_row: 0,
              truncated: false,
            },
          });
        }
      }
    });
    const greeting = encode({
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'terminal-backward',
        granted: ['panes:observe', 'terminals:output', 'terminals:input'],
      },
    });
    for (const byte of greeting) socket.write(Uint8Array.of(byte));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const session = await connect({ path: socketPath });
    await assert.rejects(
      workspace(session).terminal.reconcileWriteFailure({
        version: 1,
        slot: 'agent',
        generation: 9,
        revision: 4,
        writer,
        sequence: 0,
        input: [3],
      }),
      (error) =>
        error instanceof TerminalInputReconciliationProtocolError && error.current.text === 'stale',
    );
    await session.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
