import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import { TerminalNotLiveError, connect, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('fragmented terminal lifecycle prevents input to restored history without emitting a write', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-terminal-lifecycle-'));
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
        calls.push(frame.payload.call);
        const payload =
          frame.payload.call === 'terminal_read_pane'
            ? {
                reply: 'text',
                with: {
                  slot: 'shell',
                  generation: 7,
                  revision: 11,
                  lifecycle: 'starting',
                  columns: 80,
                  rows: 24,
                  lines: ['$ old prompt', 'Restoring this workspace…'],
                  cursor_column: 25,
                  cursor_row: 1,
                  truncated: false,
                },
              }
            : {
                reply: 'workspace',
                with: { name: 'agent', image: 'alpine', architecture: 'amd64' },
              };
        sendFragmented(socket, { channel: frame.channel, kind: KIND.response, payload });
      }
    });
    sendFragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'terminal-lifecycle',
        granted: ['panes:observe', 'terminals:output', 'terminals:input', 'workspaces:read'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const session = await connect({ path: socketPath });
    const host = workspace(session);
    const restored = await host.terminal.read('shell', 80);
    assert.equal(restored.lifecycle, 'starting');
    assert.throws(
      () => host.terminal.writeLiveObservedAndWaitForText(restored, 'dangerous\n'),
      (error) => {
        assert(error instanceof TerminalNotLiveError);
        assert.equal(error.snapshot, restored);
        return true;
      },
    );
    assert.deepEqual(calls, ['terminal_read_pane'], 'rejection occurs before any input frame');
    assert.equal((await host.info()).name, 'agent', 'the ordered Unix session remains reusable');
    assert.deepEqual(calls, ['terminal_read_pane', 'workspace_info']);
    await session.close();
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
