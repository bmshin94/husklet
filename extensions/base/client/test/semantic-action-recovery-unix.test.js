import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import { SemanticActionOperationError, connect, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('semantic UI action recovery replays one operation token after reply loss', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-semantic-recovery-'));
  const socketPath = path.join(directory, 'host.sock');
  const connections = new Set();
  const operations = [];
  let connectionNumber = 0;
  const tree = (revision) => ({
    slot: 'settings',
    generation: 3,
    revision,
    truncated: false,
    root: {
      id: 0,
      role: 'page',
      label: 'Settings',
      value: null,
      redacted: false,
      disabled: false,
      destructive: false,
      actions: [],
      children: [
        {
          id: 7,
          role: 'button',
          label: 'Apply',
          value: null,
          redacted: false,
          disabled: false,
          destructive: true,
          actions: ['invoke'],
          children: [],
        },
      ],
    },
  });
  const server = net.createServer((socket) => {
    const number = ++connectionNumber;
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        const reply = (payload) =>
          socket.write(encode({ channel: frame.channel, kind: KIND.response, payload }));
        if (
          frame.payload.call === 'event_subscribe' ||
          frame.payload.call === 'event_unsubscribe'
        ) {
          reply({ reply: 'done' });
        } else if (frame.payload.call === 'pane_semantic_action_once') {
          operations.push(frame.payload.with.operation);
          if (number === 1) socket.destroy();
          else reply({ reply: 'done' });
        } else if (frame.payload.call === 'pane_semantic_read') {
          reply({ reply: 'semantics', with: tree(number === 1 ? 4 : 5) });
        }
      }
    });
    socket.write(
      encode({
        channel: CONTROL,
        kind: KIND.open,
        payload: {
          protocol: 1,
          peer: `semantic-recovery-${number}`,
          granted: ['panes:observe', 'panes:semantic-read', 'panes:semantic-control'],
        },
      }),
    );
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const before = {
      snapshot: tree(4),
      text: '<button node="7">Apply</button>',
      complete: true,
      sourceTruncated: false,
      projectionTruncated: false,
    };
    const first = await connect({ path: socketPath });
    let failure;
    await assert.rejects(
      workspace(first).terminal.actObservedAndWait(before, { node: 7, action: 'invoke' }),
      (error) => {
        assert(error instanceof SemanticActionOperationError);
        assert.match(error.operation, /^[0-9a-f]{32}$/);
        failure = error;
        return true;
      },
    );
    await first.close();
    const recovery = JSON.parse(JSON.stringify(failure.recovery));
    const resumed = await connect({ path: socketPath });
    const recovered = await workspace(resumed).terminal.recoverSemanticAction(recovery);
    assert.equal(recovered.committed, true);
    assert.equal(recovered.operation, recovery.operation);
    assert.equal(recovered.slot, 'settings');
    assert.deepEqual(operations, [failure.operation, recovery.operation]);
    await resumed.close();
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
