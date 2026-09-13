import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { StateWriteOperationError, connect, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('embeddings checkpoint reconciles a committed write after fragmented Unix reply loss', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-state-recovery-'));
  const socketPath = path.join(directory, 'host.sock');
  const before = `sha256:${'1'.repeat(64)}`;
  const after = `sha256:${'2'.repeat(64)}`;
  let current = { identity: before, contents: [...Buffer.from('{"version":1,"revision":4}')] };
  let accepted = 0;
  let writes = 0;
  const connections = new Set();
  const server = net.createServer((socket) => {
    accepted += 1;
    const connection = accepted;
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        if (frame.payload.call === 'state_write') {
          writes += 1;
          current = { identity: after, contents: frame.payload.with.contents };
          if (connection === 1) {
            socket.destroy();
            continue;
          }
        }
        const payload =
          frame.payload.call === 'state_read'
            ? { reply: 'state', with: current }
            : { reply: 'identity', with: after };
        const bytes = encode({ channel: frame.channel, kind: KIND.response, payload });
        socket.write(bytes.subarray(0, 5));
        socket.write(bytes.subarray(5));
      }
    });
    const greeting = encode({
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: `state-recovery-${connection}`,
        granted: ['state:read', 'state:write'],
      },
    });
    socket.write(greeting.subarray(0, 2));
    socket.write(greeting.subarray(2));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const codec = { decode: (value) => value, encode: (value) => value };
  try {
    const first = await connect({ path: socketPath });
    let failure;
    try {
      await workspace(first).state.writeJson(before, { version: 1, revision: 5 }, codec);
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof StateWriteOperationError);
    assert.equal(failure.observed, before);
    assert(Object.isFrozen(failure.contents));

    const resumed = await connect({ path: socketPath });
    const recovered = await workspace(resumed).state.recoverJsonWrite(failure, codec);
    assert.equal(recovered.identity, after);
    assert.deepEqual(recovered.value, { version: 1, revision: 5 });
    assert.equal(writes, 1, 'an already committed checkpoint is never written twice');
    current = {
      identity: `sha256:${'3'.repeat(64)}`,
      contents: [...Buffer.from('{"version":1,"revision":6}')],
    };
    await assert.rejects(
      workspace(resumed).state.recoverJsonWrite(failure, codec),
      (error) => error?.kind === 'conflict',
    );
    assert.equal(writes, 1, 'an intervening checkpoint is never overwritten');
    await resumed.close();
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
