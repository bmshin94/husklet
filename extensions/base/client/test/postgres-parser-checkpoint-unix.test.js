import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import { ExecutionOperationError, connect, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('Postgres page callback checkpoints a split row atomically with its raw cursor', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-postgres-parser-checkpoint-'));
  const socketPath = path.join(directory, 'host.sock');
  const executionId = 'e'.repeat(32);
  const containerId = 'c'.repeat(64);
  const sockets = new Set();
  const requested = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const send = (frame) => {
      const encoded = encode(frame);
      for (const byte of encoded) socket.write(Uint8Array.of(byte));
    };
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        const reply = (payload) => send({ channel: frame.channel, kind: KIND.response, payload });
        if (frame.payload.call === 'execution_output') {
          const after = frame.payload.with.after;
          requested.push(after);
          reply({
            reply: 'execution_output',
            with:
              after === 0
                ? {
                    entries: [
                      {
                        sequence: 1,
                        timestamp_ms: 1,
                        stream: 'stdout',
                        bytes: [...Buffer.from('{"id":')],
                      },
                    ],
                    next: 1,
                    more: true,
                    eof: false,
                    gap: false,
                  }
                : {
                    entries: [
                      {
                        sequence: 2,
                        timestamp_ms: 2,
                        stream: 'stdout',
                        bytes: [...Buffer.from('1}\n')],
                      },
                    ],
                    next: 2,
                    more: false,
                    eof: true,
                    gap: false,
                  },
          });
        } else if (frame.payload.call === 'execution_inspect') {
          reply({
            reply: 'execution',
            with: {
              id: executionId,
              container_id: containerId,
              running: false,
              exit_code: 0,
              result: { kind: 'code', value: 0 },
              created_at_ms: 1,
              started_at_ms: 2,
              finished_at_ms: 3,
              pid: 91,
              command: ['psql'],
              user: 'postgres',
            },
          });
        }
      }
    });
    send({
      channel: CONTROL,
      kind: KIND.open,
      payload: { protocol: 1, peer: 'postgres-parser-checkpoint', granted: ['containers:read'] },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath });
    let checkpoint;
    await assert.rejects(
      workspace(first).containers.resumeJsonLinePages(
        executionId,
        { after: 0, maxLineBytes: 1024, maxLines: 10 },
        (page) => {
          checkpoint = {
            after: page.next,
            lines: page.lines,
            partialLine: [...page.partialLine],
          };
          throw new Error('UI state committed, then extension process crashed');
        },
      ),
      (error) => error instanceof ExecutionOperationError && error.after === 0,
    );
    await first.close();
    assert.deepEqual(checkpoint, {
      after: 1,
      lines: 0,
      partialLine: [...Buffer.from('{"id":')],
    });

    const rows = [];
    const resumed = await connect({ path: socketPath });
    const result = await workspace(resumed).containers.resumeJsonLinePages(
      executionId,
      { ...checkpoint, maxLineBytes: 1024, maxLines: 10 },
      (page) => rows.push(...page.values),
    );
    assert.deepEqual(rows, [{ id: 1 }]);
    assert.equal(result.lines, 1);
    assert.deepEqual(result.partialLine, []);
    assert.deepEqual(requested, [0, 1], 'reconnect continues after the atomically stored prefix');
    await resumed.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
