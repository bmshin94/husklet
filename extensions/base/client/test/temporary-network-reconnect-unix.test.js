import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { TemporaryNetworkConnectionError, connect, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('temporary Postgres attachment exposes exact cleanup authority after fragmented disconnect', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-network-recovery-'));
  const socketPath = path.join(directory, 'host.sock');
  const networkId = 'a'.repeat(32);
  const containerId = 'c'.repeat(64);
  const connections = new Set();
  const calls = [];
  let accepted = 0;
  const server = net.createServer((socket) => {
    accepted += 1;
    const connection = accepted;
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        calls.push({ connection, ...frame.payload });
        if (frame.payload.call === 'workspace_info' && connection === 1) {
          socket.destroy();
          continue;
        }
        const payload =
          frame.payload.call === 'network_inspect'
            ? {
                reply: 'network',
                with: {
                  id: networkId,
                  name: 'database',
                  driver: 'bridge',
                  scope: 'local',
                  kind: 'custom',
                  endpoints: { containers: [], truncated: false },
                },
              }
            : { reply: 'done' };
        const bytes = encode({ channel: frame.channel, kind: KIND.response, payload });
        socket.write(bytes.subarray(0, 4));
        socket.write(bytes.subarray(4));
      }
    });
    const greeting = encode({
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: `network-recovery-${connection}`,
        granted: ['networks:read', 'networks:connect', 'networks:disconnect', 'workspaces:read'],
      },
    });
    socket.write(greeting.subarray(0, 3));
    socket.write(greeting.subarray(3));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath });
    let failure;
    try {
      await workspace(first).networks.withTemporaryConnection(
        networkId,
        containerId,
        () => first.call('workspace_info'),
        { aliases: ['postgres-browser'] },
      );
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof TemporaryNetworkConnectionError);
    assert.equal(failure.networkId, networkId);
    assert.equal(failure.containerId, containerId);
    assert(failure.operation instanceof Error);
    assert(failure.cleanup instanceof Error);

    const resumed = await connect({ path: socketPath });
    await workspace(resumed).networks.disconnect(failure.networkId, failure.containerId);
    await resumed.close();
    assert.deepEqual(
      calls.map(({ connection, call }) => [connection, call]),
      [
        [1, 'network_inspect'],
        [1, 'network_connect'],
        [1, 'workspace_info'],
        [2, 'network_disconnect'],
      ],
    );
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
