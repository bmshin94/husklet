import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { connect, TerminalPinOperationError, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('lost pin reply recovers only the exact tab without replay over fragmented Unix frames', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-pin-recovery-'));
  const socketPath = path.join(directory, 'host.sock');
  const sockets = new Set();
  const calls = [];
  let tabs = [
    { id: 'agent-tab', title: 'Agent', pinned: true, panes: [] },
    { id: 'user-tab', title: 'User', pinned: true, panes: [] },
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
        if (frame.payload.call === 'terminal_pin_tab') {
          assert.deepEqual(frame.payload.with, { tab: 'agent-tab', pinned: true });
          socket.destroy();
        } else if (frame.payload.call === 'terminal_tabs') {
          send(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: { reply: 'tabs', with: tabs },
          });
        } else {
          send(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: { reply: 'done' },
          });
        }
      }
    });
    send(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'pin-recovery',
        granted: ['panes:observe', 'terminals:read', 'terminals:layout-control'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath });
    let failure;
    await assert.rejects(workspace(first).terminal.pinTabAndWait('agent-tab', true), (error) => {
      assert(error instanceof TerminalPinOperationError, `${error?.name}: ${error?.message}`);
      failure = error;
      return true;
    });
    await first.close();
    const second = await connect({ path: socketPath });
    assert.equal((await workspace(second).terminal.recoverPinTab(failure)).id, 'agent-tab');
    await second.close();
    tabs = tabs.filter(({ id }) => id !== 'agent-tab');
    const third = await connect({ path: socketPath });
    await assert.rejects(workspace(third).terminal.recoverPinTab(failure), /disappeared/);
    assert.equal(calls.filter((call) => call === 'terminal_pin_tab').length, 1);
    await third.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
