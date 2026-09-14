import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import {
  CredentialRemoveOperationError,
  CredentialWriteProtocolError,
  connect,
  workspace,
} from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('credential removal reconciles reply loss and rejects cross-key authority over fragmented Unix', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-credential-remove-'));
  const socketPath = path.join(directory, 'host.sock');
  const sockets = new Set();
  let connection = 0;
  let removed = false;
  let removes = 0;
  const send = (socket, frame) => {
    for (const byte of encode(frame)) socket.write(Uint8Array.of(byte));
  };
  const server = net.createServer((socket) => {
    const current = ++connection;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        if (frame.payload.call === 'credential_remove') {
          removes += 1;
          removed = true;
          if (current === 1) {
            socket.destroy();
            continue;
          }
          send(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: {
              reply: 'credential_write',
              with: { key: 'other.password', observed: 99, revision: 9 },
            },
          });
        } else {
          send(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: {
              reply: 'credential',
              with: { key: 'database.password', revision: removed ? 8 : 7, value: null },
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
        peer: 'credential-remove',
        granted: ['credentials:read', 'credentials:write'],
        credentials: {
          read: ['database.password'],
          write: ['database.password'],
          expose_to_execution: [],
        },
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath });
    let failure;
    await assert.rejects(
      workspace(first).credentials.removeObserved(7, 'database.password'),
      (error) => ((failure = error), error instanceof CredentialRemoveOperationError),
    );
    const resumed = await connect({ path: socketPath });
    assert.equal(await workspace(resumed).credentials.recoverRemove(failure), 8);
    assert.equal(removes, 1, 'recovery never repeats a destructive removal');
    await assert.rejects(
      workspace(resumed).credentials.remove(8, 'database.password'),
      (error) => error instanceof CredentialWriteProtocolError,
    );
    assert.equal(JSON.stringify(failure).includes('password-sentinel'), false);
    await resumed.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
