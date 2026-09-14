import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import { TerminalOperationError, connect, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('lost raw-input reply retries one idempotent operation without typing twice', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-terminal-recovery-'));
  const socketPath = path.join(directory, 'host.sock');
  const connections = new Set();
  let accepted = 0;
  let connectionNumber = 0;
  let committedOperation;
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
        } else if (frame.payload.call === 'terminal_write_pane') {
          assert.deepEqual(frame.payload.with.contents, [0x03]);
          assert.match(frame.payload.with.operation, /^[0-9a-f]{32}$/);
          if (committedOperation === undefined) {
            committedOperation = frame.payload.with.operation;
            accepted += 1;
            socket.destroy(); // The PTY accepted the byte; every reply byte is lost.
          } else {
            assert.equal(frame.payload.with.operation, committedOperation);
            reply({
              reply: 'terminal_pane_input',
              with: {
                slot: 'agent',
                generation: 9,
                revision: 4,
                operation: committedOperation,
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

    const resumed = await connect({ path: socketPath });
    const recovery = await workspace(resumed).terminal.reconcileWriteFailure(failure);
    assert.equal(recovery.outcome, 'advanced');
    assert.equal(recovery.current.text, 'timer tick');
    assert.deepEqual(recovery.receipt, {
      slot: 'agent',
      generation: 9,
      revision: 4,
      operation: committedOperation,
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
