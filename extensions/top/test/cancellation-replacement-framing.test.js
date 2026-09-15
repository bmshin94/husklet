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

test('replacement ignores a fragmented cancellation reply from the retired job', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'husklet-cancel-replacement-'));
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
        payload: { protocol: 1, peer: 'old', granted: ['extensions:acquire'] },
      }),
    );
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.payload?.call !== 'extension_acquisition_cancel') continue;
        requested();
        void mayReply.then(() => {
          const response = encode({
            channel: frame.channel,
            kind: KIND.response,
            payload: { reply: 'done' },
          });
          socket.write(response.subarray(0, 2));
          setImmediate(() => {
            socket.write(response.subarray(2, 10));
            setImmediate(() => socket.write(response.subarray(10)));
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
    let oldStatusReads = 0;
    const oldStatus = status('old-job', 'old-tool', 'inspecting');
    const oldApi = {
      extensions: {
        list: async () => [],
        startAcquisition: async () => ({ job: 'old-job' }),
        acquisition: async () => {
          oldStatusReads += 1;
          return oldStatus;
        },
        waitForAcquisition: async () => new Promise(() => {}),
        cancelAcquisition: async (job, revision) => {
          await session.call('extension_acquisition_cancel', { job, revision });
        },
      },
      watchExtensions: async () => () => {},
    };
    stage = host();
    stage.render(h(Extensions, { api: oldApi, initialReference: 'registry.example/old-tool:1' }));
    await until(() => labelled(stage, 'Inspect'));
    await new Promise((resolve) => setImmediate(resolve));
    invoke(stage, 'Inspect');
    await until(() => labelled(stage, 'Cancel inspection'));
    invoke(stage, 'Cancel inspection');
    await sawRequest;

    const replacementApi = {
      extensions: {
        list: async () => [],
        startAcquisition: async () => ({ job: 'new-job' }),
        acquisition: async () => status('new-job', 'new-tool', 'ready'),
        waitForAcquisition: async () => new Promise(() => {}),
      },
      watchExtensions: async () => () => {},
    };
    stage.render(
      h(Extensions, {
        api: replacementApi,
        initialReference: 'registry.example/new-tool:1',
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(oldStatusReads, 1, 'the retired cancellation cannot reconcile its old job');
    assert.equal(labelled(stage, 'Inspection cancelled'), undefined);
    invoke(stage, 'Inspect');
    await until(() => labelled(stage, 'Review new-tool'));
  } finally {
    stage?.render(null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await session?.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

function status(job, name, state) {
  return {
    job,
    reference: `registry.example/${name}:1`,
    revision: 1,
    state,
    progress: null,
    candidate:
      state === 'ready'
        ? {
            name,
            version: '1.0.0',
            image_digest: `sha256:${'b'.repeat(64)}`,
            installed_image_digest: null,
            requested: [],
            required: [],
          }
        : null,
    error: null,
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
    if (Date.now() >= deadline) throw new Error('cancellation replacement did not settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
