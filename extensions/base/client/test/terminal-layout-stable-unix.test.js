import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import { connect, TerminalLayoutChangedError, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('stable layout retries a tab-only change over fragmented Unix frames', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-terminal-layout-'));
  const socketPath = path.join(directory, 'host.sock');
  const calls = [];
  const connections = new Set();
  let topologyReads = 0;
  let churning = false;
  const pane = {
    slot: 'shell',
    generation: 4,
    revision: 9,
    kind: 'terminal',
    provider: null,
    tab: 'agent',
    title: 'Shell',
    focused: true,
  };
  const reviewPane = {
    slot: 'review',
    generation: 2,
    revision: 5,
    kind: 'surface',
    provider: { extension: 'review', provider: 'diff' },
    tab: 'agent',
    title: 'Review',
    focused: false,
  };
  const topology = (ratio) => ({
    active_tab: 'agent',
    tabs: [
      {
        id: 'agent',
        title: 'Agent',
        pinned: true,
        root: {
          kind: 'split',
          division: 'beside',
          ratio_per_mille: ratio,
          first: {
            kind: 'pane',
            pane: {
              slot: 'shell',
              working_directory: '/workspace',
              command: 'sh',
              occupant: 'terminal',
              provider: null,
            },
            grid: { columns: 80, rows: 24 },
            focused: true,
          },
          second: {
            kind: 'pane',
            pane: {
              slot: 'review',
              working_directory: null,
              command: null,
              occupant: 'surface',
              provider: { extension: 'review', provider: 'diff' },
            },
            grid: null,
            focused: false,
          },
        },
      },
    ],
  });

  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        calls.push(frame.payload.call);
        let payload;
        if (frame.payload.call === 'terminal_topology') {
          topologyReads += 1;
          payload = {
            reply: 'topology',
            with: topology(topologyReads === 1 ? 400 : churning ? 600 + topologyReads : 600),
          };
        } else if (frame.payload.call === 'pane_list') {
          payload = { reply: 'panes', with: { panes: [pane, reviewPane], truncated: false } };
        } else if (frame.payload.call === 'terminal_read_pane') {
          payload = {
            reply: 'text',
            with: {
              slot: 'shell',
              generation: 4,
              revision: 9,
              lifecycle: 'live',
              columns: 80,
              rows: 24,
              lines: ['$ ready'],
              cursor_column: 7,
              cursor_row: 0,
              truncated: false,
            },
          };
        } else if (frame.payload.call === 'pane_semantic_read') {
          payload = {
            reply: 'semantics',
            with: {
              slot: 'review',
              generation: 2,
              revision: 5,
              root: {
                id: 1,
                role: 'document',
                label: 'Review',
                value: null,
                redacted: false,
                disabled: false,
                destructive: false,
                actions: [],
                children: [],
              },
              truncated: false,
            },
          };
        }
        const reply = encode({ channel: frame.channel, kind: KIND.response, payload });
        for (const byte of reply) socket.write(Uint8Array.of(byte));
      }
    });
    const greeting = encode({
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'terminal-layout-agent',
        granted: ['terminals:read', 'terminals:output', 'panes:observe', 'panes:semantic-read'],
      },
    });
    socket.write(greeting.subarray(0, 3));
    socket.write(greeting.subarray(3));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const session = await connect({ path: socketPath });
    const layout = await workspace(session).terminal.readLayoutStable({ lines: 80, attempts: 2 });
    assert.equal(layout.topology.tabs[0].root.ratio_per_mille, 600);
    assert.equal(layout.topology.tabs[0].pinned, true);
    assert.deepEqual(
      layout.panes.map(({ pane: current, readable }) => [current.slot, readable.text]),
      [
        ['shell', '$ ready'],
        [
          'review',
          '<pane slot="review" generation="2" revision="5" truncated="false"><node id="1" role="document" disabled="false" destructive="false" actions=""><label>Review</label></node></pane>',
        ],
      ],
    );
    assert.equal(layout.complete, true);
    assert.deepEqual(calls, [
      'terminal_topology',
      'pane_list',
      'terminal_read_pane',
      'pane_semantic_read',
      'pane_list',
      'terminal_topology',
      'terminal_topology',
      'pane_list',
      'terminal_read_pane',
      'pane_semantic_read',
      'pane_list',
      'terminal_topology',
    ]);
    churning = true;
    await assert.rejects(workspace(session).terminal.readLayoutStable({ attempts: 2 }), (error) => {
      assert(error instanceof TerminalLayoutChangedError);
      assert.equal(error.attempts, 2);
      assert.equal(Object.isFrozen(error.before), true);
      assert.equal(Object.isFrozen(error.after), true);
      assert.notDeepEqual(error.before, error.after);
      return true;
    });
    assert.equal((await workspace(session).terminal.topology()).tabs[0].id, 'agent');
    await session.close();
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
