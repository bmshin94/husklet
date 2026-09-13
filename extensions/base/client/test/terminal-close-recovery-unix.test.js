import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { connect, TerminalCloseOperationError, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';
test('lost pane close reply reports replacement and never replays over fragmented Unix', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-close-recovery-'));
  const socketPath = path.join(directory, 'host.sock');
  const sockets = new Set();
  const calls = [];
  let panes = [
    {
      slot: 'agent',
      generation: 8,
      revision: 1,
      kind: 'surface',
      provider: { extension: 'database', provider: 'browser' },
      tab: 'replacement',
      title: 'Database',
      focused: true,
    },
    {
      slot: 'user',
      generation: 2,
      revision: 4,
      kind: 'terminal',
      provider: null,
      tab: 'user-tab',
      title: 'User',
      focused: false,
    },
  ];
  const send = (socket, frame) => {
    for (const byte of encode(frame)) socket.write(Uint8Array.of(byte));
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        calls.push(frame.payload.call);
        if (frame.payload.call === 'terminal_close_pane_observed') {
          assert.deepEqual(frame.payload.with, { slot: 'agent', generation: 7, revision: 9 });
          socket.destroy();
        } else if (frame.payload.call === 'pane_list')
          send(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: { reply: 'panes', with: { panes, truncated: false } },
          });
      }
    });
    send(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'close-recovery',
        granted: ['panes:observe', 'terminals:layout-control'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath });
    let failure;
    await assert.rejects(
      workspace(first).terminal.closeObservedRecoverable('agent', 7, 9),
      (error) => {
        assert(error instanceof TerminalCloseOperationError);
        failure = error;
        return true;
      },
    );
    await first.close();
    const second = await connect({ path: socketPath });
    const recovered = await workspace(second).terminal.recoverClose(failure);
    assert.equal(recovered.replacement.generation, 8);
    assert.equal(recovered.replacement.tab, 'replacement');
    await second.close();
    panes = [{ ...panes[0], generation: 7 }];
    const third = await connect({ path: socketPath });
    await assert.rejects(
      workspace(third).terminal.recoverClose(failure),
      /exact pane generation remains/,
    );
    assert.equal(calls.filter((call) => call === 'terminal_close_pane_observed').length, 1);
    await third.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
