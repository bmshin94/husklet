import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import { connect, ExtensionCommitOperationError, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('lost install reply recovers exact reviewed authority without replay over fragmented Unix frames', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-extension-commit-'));
  const socketPath = path.join(directory, 'host.sock');
  const digest = `sha256:${'a'.repeat(64)}`;
  const defaults = {
    containers: { selectors: [], create: false },
    images: { read: [], use: [], pull: [], remove: [], prune_all_unused: false },
    networks: { selectors: [], create: false },
    volumes: { selectors: [], create: false },
    filesystem: { read: [], write: [], create: [], delete: [], rename: [] },
    workspace_environment: { read: [], write: [] },
    credentials: { read: [], write: [], expose_to_execution: [] },
  };
  const candidate = {
    name: 'reviewed',
    version: '2',
    image_digest: digest,
    requested: ['extensions:read'],
    required: [],
    installed_image_digest: null,
  };
  const summary = {
    name: candidate.name,
    version: candidate.version,
    image_digest: digest,
    status: 'duty',
    enabled: true,
    pane_providers: [],
    granted: ['extensions:read'],
    ...defaults,
  };
  const sockets = new Set();
  const calls = [];
  let connection = 0;
  let committed = false;
  let published = summary;
  const fragmented = (socket, frame) => {
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
        calls.push({ connection: current, call: frame.payload.call });
        if (frame.payload.call === 'extension_acquisition_status') {
          fragmented(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: {
              reply: 'extension_acquisition',
              with: {
                job: 'job-install',
                reference: 'registry/reviewed:2',
                revision: committed ? 6 : 5,
                state: committed ? 'installed' : 'ready',
                progress: null,
                candidate: committed ? null : candidate,
                error: null,
              },
            },
          });
        } else if (frame.payload.call === 'event_subscribe') {
          fragmented(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: { reply: 'done' },
          });
        } else if (frame.payload.call === 'extension_install') {
          committed = true;
          socket.destroy();
        } else if (frame.payload.call === 'extension_list') {
          fragmented(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: { reply: 'extensions', with: [published] },
          });
        } else {
          fragmented(socket, {
            channel: frame.channel,
            kind: KIND.response,
            payload: { reply: 'done' },
          });
        }
      }
    });
    fragmented(socket, {
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: `commit-${current}`,
        granted: ['extensions:read', 'extensions:install'],
      },
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const first = await connect({ path: socketPath });
    let failure;
    await assert.rejects(
      workspace(first).extensions.installAndWait('job-install', 5, {
        capabilities: ['extensions:read'],
      }),
      (error) => {
        assert(error instanceof ExtensionCommitOperationError, `${error?.name}: ${error?.message}`);
        assert(Object.isFrozen(error.candidate));
        assert(Object.isFrozen(error.review.filesystem.read));
        failure = error;
        return true;
      },
    );
    await first.close();

    const second = await connect({ path: socketPath });
    const recovered = await workspace(second).extensions.recoverCommit(failure);
    assert.deepEqual(recovered, summary);
    assert.equal(
      calls.filter(({ call }) => call === 'extension_install').length,
      1,
      'recovery never replays an ambiguous commit',
    );
    await second.close();

    published = { ...summary, granted: ['extensions:read', 'extensions:install'] };
    const third = await connect({ path: socketPath });
    await assert.rejects(
      workspace(third).extensions.recoverCommit(failure),
      /no longer matches the committed candidate and reviewed authority/,
    );
    assert.equal(calls.filter(({ call }) => call === 'extension_install').length, 1);
    await third.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('malformed acquisition authority never reaches a fragmented Unix socket', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-extension-authority-'));
  const socketPath = path.join(directory, 'host.sock');
  const calls = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        calls.push(frame.payload.call);
        const bytes = encode({
          channel: frame.channel,
          kind: KIND.response,
          payload: {
            reply: 'extension_acquisition',
            with: {
              job: 'job-valid',
              reference: 'registry/tool:1',
              revision: -1,
              state: 'inspecting',
              progress: null,
              candidate: null,
              error: null,
            },
          },
        });
        socket.write(bytes.subarray(0, 2));
        socket.write(bytes.subarray(2, 7));
        socket.write(bytes.subarray(7));
      }
    });
    const greeting = encode({
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'acquisition-authority',
        granted: ['extensions:install'],
      },
    });
    socket.write(greeting.subarray(0, 3));
    socket.write(greeting.subarray(3));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const session = await connect({ path: socketPath });
    const extensions = workspace(session).extensions;
    const digest = `sha256:${'a'.repeat(64)}`;
    await assert.rejects(extensions.install('', 1, digest, []), /job identity/);
    await assert.rejects(
      extensions.update('job-valid', Number.MAX_SAFE_INTEGER + 1, digest, []),
      /revision/,
    );
    assert.throws(() => extensions.cancelAcquisition('job-valid', -1), /revision/);
    assert.deepEqual(calls, [], 'invalid mutating authority is rejected before framing');
    await assert.rejects(extensions.acquisition('job-valid'), /revision/);
    assert.deepEqual(calls, ['extension_acquisition_status']);
    await session.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
