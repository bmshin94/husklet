import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import { ExecutionOperationError, connect, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('test event pages resume without duplicating a partially failed callback transaction', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-test-json-pages-'));
  const socketPath = path.join(directory, 'host.sock');
  const containerId = 'c'.repeat(64);
  const executionId = 'e'.repeat(32);
  const sockets = new Set();
  let outputReads = 0;
  let starts = 0;
  const bytes = [...Buffer.from('{"test":"one"}\n{"test":"two"}\n')];
  const summary = {
    id: executionId,
    container_id: containerId,
    running: false,
    exit_code: 0,
    result: { kind: 'code', value: 0 },
    created_at_ms: 1,
    started_at_ms: 2,
    finished_at_ms: 3,
    pid: 41,
    command: ['test', '--reporter=jsonl'],
    user: 'runner',
  };
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
        if (frame.payload.call === 'container_exec') {
          starts += 1;
          reply({ reply: 'identity', with: executionId });
        } else if (frame.payload.call === 'execution_output') {
          outputReads += 1;
          assert.equal(frame.payload.with.after, 0, 'failed page was never acknowledged');
          reply({
            reply: 'execution_output',
            with: {
              entries: [
                { sequence: 1, timestamp_ms: 1, stream: 'stdout', bytes },
                {
                  sequence: 2,
                  timestamp_ms: 2,
                  stream: 'stderr',
                  bytes: [...Buffer.from('note\n')],
                },
              ],
              next: 2,
              more: false,
              eof: true,
              gap: false,
            },
          });
        } else if (frame.payload.call === 'execution_inspect') {
          reply({ reply: 'execution', with: summary });
        } else if (frame.payload.call === 'execution_cancel') {
          reply({ reply: 'done' });
        }
      }
    });
    send({
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'test-json-pages',
        granted: ['containers:read', 'containers:execute'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath });
    let failure;
    await assert.rejects(
      workspace(first).containers.execJsonLinePages(
        containerId,
        7,
        { command: summary.command, maxLineBytes: 1024, maxLines: 10 },
        (page) => {
          assert.deepEqual(page.values, [{ test: 'one' }, { test: 'two' }]);
          assert.equal(Buffer.from(page.stderr).toString(), 'note\n');
          throw new Error('database transaction rolled back');
        },
      ),
      (error) => {
        assert(error instanceof ExecutionOperationError);
        assert.equal(error.executionId, executionId);
        assert.equal(error.after, 0);
        assert.equal(error.lines, 0);
        assert.deepEqual(error.partialLine, []);
        failure = error;
        return true;
      },
    );
    await first.close();

    const committed = [];
    const resumed = await connect({ path: socketPath });
    const result = await workspace(resumed).containers.resumeJsonLinePages(
      failure.executionId,
      {
        after: failure.after,
        partialLine: failure.partialLine,
        lines: failure.lines,
        expectedContainerId: containerId,
        maxLineBytes: 1024,
        maxLines: 10,
      },
      async (page) => committed.push(...page.values),
    );
    assert.deepEqual(committed, [{ test: 'one' }, { test: 'two' }]);
    assert.equal(result.complete, true);
    assert.equal(result.execution.id, executionId);
    assert.equal(starts, 1, 'resume never reruns the test process');
    assert.equal(outputReads, 2, 'the rolled-back page is replayed exactly once');
    await resumed.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
