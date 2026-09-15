import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import {
  StateWriteOperationError,
  StateWriteProtocolError,
  connect,
  workspace,
} from '../dist/index.js';
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
            : {
                reply: 'state_write',
                with: { observed: `sha256:${'9'.repeat(64)}`, identity: after },
              };
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
    await assert.rejects(workspace(resumed).state.write(current.identity, [1, 2, 3]), (error) => {
      assert(error instanceof StateWriteProtocolError);
      assert.equal(error.expectedObserved, `sha256:${'3'.repeat(64)}`);
      assert.equal(error.received.observed, `sha256:${'9'.repeat(64)}`);
      return true;
    });
    await resumed.close();
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('aborted in-flight checkpoint CAS recovers the committed value without rerunning the updater', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-state-abort-recovery-'));
  const socketPath = path.join(directory, 'host.sock');
  const before = `sha256:${'4'.repeat(64)}`;
  const after = `sha256:${'5'.repeat(64)}`;
  let current = { identity: before, contents: [...Buffer.from('{"revision":8}')] };
  let accepted = 0;
  let writes = 0;
  const calls = [];
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
        calls.push({ connection, ...frame.payload });
        if (frame.payload.call === 'state_read') {
          const response = encode({
            channel: frame.channel,
            kind: KIND.response,
            payload: { reply: 'state', with: current },
          });
          socket.write(response.subarray(0, 3));
          socket.write(response.subarray(3));
        } else if (frame.payload.call === 'state_write') {
          writes += 1;
          current = { identity: after, contents: frame.payload.with.contents };
          // The write is durable, but its fragmented reply is lost indefinitely.
          if (connection !== 1) throw new Error('recovery must not repeat a committed CAS');
        } else {
          throw new Error(`unexpected ${frame.payload.call}`);
        }
      }
    });
    const greeting = encode({
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: `state-abort-recovery-${connection}`,
        granted: ['state:read', 'state:write'],
      },
    });
    socket.write(greeting.subarray(0, 1));
    socket.write(greeting.subarray(1));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const codec = { decode: (value) => value, encode: (value) => value };
  try {
    const first = await connect({ path: socketPath, timeout: 2_000 });
    const cancellation = new AbortController();
    let updates = 0;
    const updating = workspace(first).state.updateJson(
      codec,
      (value) => {
        updates += 1;
        return { revision: value.revision + 1 };
      },
      { signal: cancellation.signal },
    );
    while (!calls.some(({ call }) => call === 'state_write'))
      await new Promise((resolve) => setImmediate(resolve));
    const started = Date.now();
    cancellation.abort('indexer shutdown');
    let failure;
    await assert.rejects(updating, (error) => {
      assert(error instanceof StateWriteOperationError);
      assert.equal(error.observed, before);
      assert.equal(error.cause.name, 'AbortError');
      failure = error;
      return true;
    });
    assert(Date.now() - started < 1_000, 'abort must interrupt the withheld CAS reply');
    assert.equal(updates, 1, 'cancellation never reruns the checkpoint transform');

    const resumed = await connect({ path: socketPath });
    const recovered = await workspace(resumed).state.recoverJsonWrite(failure, codec);
    assert.deepEqual(recovered, { identity: after, value: { revision: 9 } });
    assert.equal(writes, 1, 'recovery recognizes the durable checkpoint without another CAS');
    assert.deepEqual(await workspace(resumed).state.readJson(codec), recovered);
    await resumed.close();
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
