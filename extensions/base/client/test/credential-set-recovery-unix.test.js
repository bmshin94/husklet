import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { connect, CredentialSetOperationError, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';
test('credential CAS recovery never replays and rejects concurrent rotation over fragmented Unix', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-credential-recovery-'));
  const socketPath = path.join(directory, 'host.sock');
  const sockets = new Set();
  const calls = [];
  const replacement = [115, 101, 99, 114, 101, 116];
  let revision = 8;
  let value = [...replacement];
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
        if (frame.payload.call === 'credential_set') {
          assert.deepEqual(frame.payload.with, {
            observed: 7,
            key: 'database.password',
            value: replacement,
          });
          socket.destroy();
        } else if (frame.payload.call === 'credential_read')
          send(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: {
              reply: 'credential',
              with: { key: 'database.password', revision, value: [...value] },
            },
          });
      }
    });
    send(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'rotation',
        granted: ['credentials:read', 'credentials:write'],
        credentials: { read: ['database.password'], write: ['database.password'], expose_to_execution: [] },
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath });
    let failure;
    await assert.rejects(
      workspace(first).credentials.setObserved(7, 'database.password', replacement),
      (error) => {
        assert(error instanceof CredentialSetOperationError);
        assert(Object.isFrozen(error.value));
        failure = error;
        return true;
      },
    );
    await first.close();
    const second = await connect({ path: socketPath });
    assert.equal(await workspace(second).credentials.recoverSet(failure), 8);
    await second.close();
    revision = 9;
    value = [...replacement];
    const third = await connect({ path: socketPath });
    await assert.rejects(workspace(third).credentials.recoverSet(failure), /no longer matches/);
    assert.equal(calls.filter((call) => call === 'credential_set').length, 1);
    await third.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
