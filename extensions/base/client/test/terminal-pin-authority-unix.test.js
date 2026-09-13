import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { connect, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('pin denial for an unrelated tab preserves the fragmented Unix session', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-pin-authority-'));
  const socketPath = path.join(directory, 'host.sock');
  const sockets = new Set();
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
        if (frame.payload.call === 'terminal_pin_tab') {
          send(socket, {
            channel: frame.channel,
            kind: KIND.response,
            flags: 3,
            payload: {
              error: 'conflict',
              detail: 'terminal tab is not owned by this extension installation',
            },
          });
        } else if (frame.payload.call === 'terminal_tabs') {
          send(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: {
              reply: 'tabs',
              with: [{ id: 'user-tab', title: 'User', pinned: false, panes: [] }],
            },
          });
        }
      }
    });
    send(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'pin-authority',
        granted: ['terminals:read', 'terminals:layout-control'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const session = await connect({ path: socketPath });
    const terminal = workspace(session).terminal;
    await assert.rejects(terminal.pinTab('user-tab'), /not owned by this extension installation/);
    assert.equal((await terminal.tabs())[0].id, 'user-tab');
    await session.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
