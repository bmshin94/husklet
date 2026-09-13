import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import { ExecutionStartOperationError, connect, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('credential execution reply loss exposes bounded exact-container cleanup candidates', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-credential-exec-recovery-'));
  const socketPath = path.join(directory, 'host.sock');
  const containerId = 'c'.repeat(64);
  const oldId = '1'.repeat(32);
  const committedId = '2'.repeat(32);
  const foreignId = '3'.repeat(32);
  const otherId = '4'.repeat(32);
  const sockets = new Set();
  let connection = 0;
  let starts = 0;
  const execution = (id, container_id, command) => ({
    id,
    container_id,
    running: true,
    exit_code: 0,
    result: null,
    created_at_ms: 1,
    started_at_ms: 2,
    finished_at_ms: null,
    pid: 77,
    command,
    user: 'postgres',
  });
  const server = net.createServer((socket) => {
    const current = ++connection;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const send = (frame) => {
      const bytes = encode(frame);
      for (const byte of bytes) socket.write(Uint8Array.of(byte));
    };
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        const reply = (payload) => send({ channel: frame.channel, kind: KIND.response, payload });
        if (frame.payload.call === 'execution_list') {
          reply({
            reply: 'executions',
            with: {
              executions:
                current === 1
                  ? [execution(oldId, containerId, ['psql', '--no-password'])]
                  : [
                      execution(oldId, containerId, ['psql', '--no-password']),
                      execution(committedId, containerId, ['psql', '--no-password']),
                      execution(foreignId, 'd'.repeat(64), ['psql', '--no-password']),
                      execution(otherId, containerId, ['vacuumdb']),
                    ],
              truncated: false,
            },
          });
        } else if (frame.payload.call === 'container_exec_credential') {
          starts += 1;
          assert.deepEqual(frame.payload.with.credentials, [['PGPASSWORD', 'postgres.password']]);
          assert.equal(JSON.stringify(frame.payload).includes('sentinel-secret'), false);
          socket.destroy(); // The process exists, but its identity reply is wholly lost.
        }
      }
    });
    send({
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: `credential-recovery-${current}`,
        granted: ['containers:read', 'containers:execute', 'credentials:inject'],
        credentials: { read: [], write: [], inject: ['postgres.password'] },
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath });
    let failure;
    await assert.rejects(
      workspace(first).containers.execWithCredentialsObserved(containerId, 8, {
        command: ['psql', '--no-password'],
        credentials: [['PGPASSWORD', 'postgres.password']],
      }),
      (error) => {
        assert(error instanceof ExecutionStartOperationError);
        assert.deepEqual(error.credentialKeys, ['postgres.password']);
        assert.deepEqual(error.before, { ids: [oldId], complete: true });
        failure = error;
        return true;
      },
    );
    await first.close();

    const resumed = await connect({ path: socketPath });
    const recovery = await workspace(resumed).containers.reconcileExecutionStart(failure);
    assert.deepEqual(
      recovery.candidates.map(({ id }) => id),
      [committedId],
    );
    assert.equal(recovery.complete, true);
    assert.equal(recovery.retrySafe, false);
    assert.equal(starts, 1, 'reconciliation never repeats secret-bearing execution');
    await resumed.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
