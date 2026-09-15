import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createElement as h } from 'react';
import { connect, workspace } from '../../../extensions/base/react/dist/index.js';
import { KIND, Reader, encode } from '../../../extensions/base/react/dist/wire.js';
import { Extensions } from '../dist/app.js';
import { host } from './host.js';

test('workspace replacement stops a fragmented old tab reply before occupant switching', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'husklet-provider-replacement-'));
  const socketPath = join(directory, 'old-workspace.sock');
  const calls = [];
  let releaseOpen;
  const mayOpen = new Promise((resolve) => {
    releaseOpen = resolve;
  });
  let sawOpen;
  const opened = new Promise((resolve) => {
    sawOpen = resolve;
  });
  const connections = new Set();
  const pane = {
    slot: 'old-pane',
    generation: 4,
    revision: 8,
    kind: 'terminal',
    provider: null,
    tab: 'old-tab',
    title: 'Old tools',
    focused: false,
  };
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    const reader = new Reader();
    socket.write(
      encode({
        channel: 0,
        kind: KIND.open,
        payload: {
          protocol: 1,
          peer: 'old-workspace',
          granted: ['panes:observe', 'terminals:layout-control', 'terminals:process-control'],
        },
      }),
    );
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        const call = frame.payload?.call;
        if (!call) continue;
        calls.push(call);
        if (call === 'event_subscribe' || call === 'event_unsubscribe') {
          socket.write(
            encode({ channel: frame.channel, kind: KIND.response, payload: { reply: 'done' } }),
          );
        } else if (call === 'terminal_open_tab') {
          sawOpen();
          void mayOpen.then(() => {
            socket.write(
              encode({
                channel: 130,
                kind: KIND.event,
                payload: {
                  snapshot: 'pane_changes',
                  of: {
                    slot: pane.slot,
                    kind: pane.kind,
                    generation: pane.generation,
                    revision: pane.revision,
                    coalesced: 0,
                  },
                },
              }),
            );
            const response = encode({
              channel: frame.channel,
              kind: KIND.response,
              payload: { reply: 'identity', with: pane.tab },
            });
            socket.write(response.subarray(0, 2));
            setImmediate(() => {
              socket.write(response.subarray(2, 9));
              setImmediate(() => socket.write(response.subarray(9)));
            });
          });
        } else if (call === 'pane_list') {
          socket.write(
            encode({
              channel: frame.channel,
              kind: KIND.response,
              payload: { reply: 'panes', with: { panes: [pane], truncated: false } },
            }),
          );
        } else if (call.includes('switch') && call.includes('occupant')) {
          assert.fail('the retired workspace must not receive occupant switching');
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  let session;
  let stage;
  try {
    session = await connect({ path: socketPath });
    const oldTerminal = workspace(session).terminal;
    const oldApi = api('old-tools', oldTerminal);
    stage = host();
    stage.render(h(Extensions, { api: oldApi }));
    await until(() => labelled(stage, 'Open'));
    await new Promise((resolve) => setImmediate(resolve));
    invoke(stage, 'Open');
    await sawOpen;

    const replacementCalls = [];
    const replacementApi = api('new-tools', {
      openTabAndWait: async () => ({
        changed: true,
        tab: 'new-tab',
        pane: { slot: 'new-pane', generation: 1, revision: 1 },
      }),
      switchOccupantAndWait: async (...args) => {
        replacementCalls.push(['switch', ...args]);
        return { changed: true, pane: { slot: 'new-pane', generation: 1, revision: 2 } };
      },
      focus: async (...args) => replacementCalls.push(['focus', ...args]),
    });
    stage.render(h(Extensions, { api: replacementApi }));
    await new Promise((resolve) => setImmediate(resolve));
    releaseOpen();
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.deepEqual(
      calls.filter((call) => call.includes('switch') && call.includes('occupant')),
      [],
    );
    assert.equal(labelled(stage, 'Old tools opened in a new tab.'), undefined);
    invoke(stage, 'Open');
    await until(() => labelled(stage, 'New tools opened in a new tab.'));
    assert.deepEqual(replacementCalls, [
      ['switch', 'new-pane', 1, 1, { kind: 'surface', extension: 'new-tools', provider: 'main' }],
      ['focus', 'new-pane'],
    ]);
  } finally {
    stage?.render(null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await session?.close();
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

function api(name, terminal) {
  return {
    extensions: {
      list: async () => [
        {
          name,
          version: '1.0.0',
          image_digest: `sha256:${name === 'old-tools' ? 'a' : 'b'}`.padEnd(
            71,
            name === 'old-tools' ? 'a' : 'b',
          ),
          enabled: true,
          status: 'duty',
          pane_providers: [
            { id: 'main', title: name === 'old-tools' ? 'Old tools' : 'New tools', icon: null },
          ],
        },
      ],
    },
    terminal,
    watchExtensions: async () => () => {},
  };
}

function labelled(stage, label) {
  return stage.frames
    .flatMap((frame) => frame.patches)
    .filter((patch) => patch.SetProp?.prop === 'Label' && patch.SetProp.value?.Text === label)
    .at(-1);
}

function invoke(stage, label) {
  const nodes = stage.frames
    .flatMap((frame) => frame.patches)
    .filter((patch) => patch.SetProp?.prop === 'Label' && patch.SetProp.value?.Text === label)
    .map((patch) => patch.SetProp.id)
    .reverse();
  assert.ok(
    nodes.some((node) =>
      stage.surface.dispatch({ trigger: 'Invoke', node, id: `${node}:Invoke`, value: null }),
    ),
  );
}

async function until(done) {
  const deadline = Date.now() + 2_000;
  while (!done()) {
    if (Date.now() >= deadline) throw new Error('provider replacement flow did not settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
