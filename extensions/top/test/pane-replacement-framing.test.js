import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createElement as h } from 'react';
import { connect } from '../../../extensions/base/react/dist/index.js';
import { KIND, Reader, encode } from '../../../extensions/base/react/dist/wire.js';
import { Terminals } from '../dist/app.js';
import { host } from './host.js';

test('replacement ignores a fragmented split reply from a retired pane layout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'husklet-pane-replacement-'));
  const socketPath = join(directory, 'old.sock');
  let release;
  const mayReply = new Promise((resolve) => (release = resolve));
  let requested;
  const sawRequest = new Promise((resolve) => (requested = resolve));
  const server = net.createServer((socket) => {
    const reader = new Reader();
    socket.write(
      encode({
        channel: 0,
        kind: KIND.open,
        payload: { protocol: 1, peer: 'old', granted: ['terminals:layout-control'] },
      }),
    );
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.payload?.call !== 'terminal_split_observed') continue;
        requested();
        void mayReply.then(() => {
          const response = encode({
            channel: frame.channel,
            kind: KIND.response,
            payload: { reply: 'done' },
          });
          socket.write(response.subarray(0, 2));
          socket.write(response.subarray(2, 9));
          socket.write(response.subarray(9));
        });
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  let session;
  let stage;
  try {
    session = await connect({ path: socketPath });
    let oldReloads = 0;
    const oldApi = terminalApi(async (slot, generation, revision, division) => {
      await session.call('terminal_split_observed', { slot, generation, revision, division });
      return { changed: true };
    });
    stage = host();
    stage.render(h(Terminals, { api: oldApi, resource: resource(() => oldReloads++) }));
    await until(() => labelled(stage, 'Split right'));
    await new Promise((resolve) => setImmediate(resolve));
    invoke(stage, 'Split right');
    await sawRequest;

    const replacement = terminalApi(
      async () => ({ changed: true }),
      async () => new Promise(() => {}),
    );
    stage.render(h(Terminals, { api: replacement, resource: resource(() => {}) }));
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(oldReloads, 0, 'the retired split cannot reload its old layout');
    assert.equal(enabled(stage, 'Split right'), false, 'the old pane cursor is revoked');
  } finally {
    stage?.render(null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await session?.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

function terminalApi(
  splitAndWait,
  toText = async () => ({
    kind: 'terminal',
    text: '$',
    snapshot: {
      slot: 'pane-1',
      generation: 1,
      revision: 1,
      columns: 80,
      rows: 24,
      lines: ['$'],
    },
  }),
) {
  return {
    terminal: {
      toText,
      splitAndWait,
    },
  };
}

function resource(
  reload,
  data = [{ id: 'tab-1', title: 'Shell', pinned: false, panes: [{ slot: 'pane-1' }] }],
) {
  return {
    data,
    loading: false,
    error: null,
    reload: async () => reload(),
  };
}

function enabled(stage, label) {
  const id = labelled(stage, label)?.SetProp.id;
  return stage.frames
    .flatMap((frame) => frame.patches)
    .filter((patch) => patch.SetProp?.id === id && patch.SetProp.prop === 'Enabled')
    .at(-1)?.SetProp.value?.Flag;
}

function labelled(stage, label) {
  return stage.frames
    .flatMap((frame) => frame.patches)
    .findLast((patch) => patch.SetProp?.prop === 'Label' && patch.SetProp.value?.Text === label);
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
    if (Date.now() >= deadline) throw new Error('pane replacement did not settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
