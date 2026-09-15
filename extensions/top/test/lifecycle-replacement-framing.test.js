import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createElement as h } from 'react';
import { connect } from '../../../extensions/base/react/dist/index.js';
import { KIND, Reader, encode } from '../../../extensions/base/react/dist/wire.js';
import { Extensions } from '../dist/app.js';
import { host } from './host.js';

test('replacement ignores a fragmented lifecycle reply and never reloads retired inventory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'husklet-lifecycle-replacement-'));
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
        payload: { protocol: 1, peer: 'old', granted: ['extensions:control'] },
      }),
    );
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.payload?.call !== 'extension_disable') continue;
        requested();
        void mayReply.then(() => {
          const response = encode({
            channel: frame.channel,
            kind: KIND.response,
            payload: { reply: 'done' },
          });
          socket.write(response.subarray(0, 1));
          setImmediate(() => {
            socket.write(response.subarray(1, 8));
            setImmediate(() => socket.write(response.subarray(8)));
          });
        });
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  let session;
  let stage;
  try {
    session = await connect({ path: socketPath });
    let oldLists = 0;
    const old = extension('old-tool');
    const oldApi = {
      extensions: {
        list: async () => {
          oldLists += 1;
          return [old];
        },
        disableAndWait: async (name, imageDigest) => {
          await session.call('extension_disable', {
            name,
            image_digest: imageDigest,
          });
          return { changed: true, extension: { ...old, enabled: false, status: 'standby' } };
        },
      },
      watchExtensions: async () => () => {},
    };
    stage = host();
    stage.render(h(Extensions, { api: oldApi }));
    await until(() => labelled(stage, 'Disable'));
    await new Promise((resolve) => setImmediate(resolve));
    invoke(stage, 'Disable');
    await sawRequest;

    const newCalls = [];
    const current = extension('current-tool');
    const replacementApi = {
      extensions: {
        list: async () => [current],
        disableAndWait: async (...args) => {
          newCalls.push(args);
          return {
            changed: true,
            extension: { ...current, enabled: false, status: 'standby' },
          };
        },
      },
      watchExtensions: async () => () => {},
    };
    stage.render(h(Extensions, { api: replacementApi }));
    await until(() => labelled(stage, 'current-tool'));
    release();
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(oldLists, 1, 'a retired lifecycle completion cannot reload old inventory');
    assert.equal(labelled(stage, 'old-tool disabled and verified.'), undefined);
    invoke(stage, 'Disable');
    await until(() => labelled(stage, 'current-tool disabled and verified.'));
    assert.equal(newCalls.length, 1, 'the replacement lifecycle queue is immediately available');
  } finally {
    stage?.render(null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await session?.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

function extension(name) {
  return {
    name,
    version: '1.0.0',
    image_digest: `sha256:${name === 'old-tool' ? 'a' : 'b'}`.padEnd(
      71,
      name === 'old-tool' ? 'a' : 'b',
    ),
    enabled: true,
    status: 'duty',
    pane_providers: [],
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
    if (Date.now() >= deadline) throw new Error('lifecycle replacement did not settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
