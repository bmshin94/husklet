import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import { connect, workspace } from '../dist/index.js';
import { CONTROL, KIND, Reader, encode } from '../dist/wire.js';

test('fragmented greeting exposes only the caller filesystem grant as immutable selectors', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'husklet-grant-'));
  const socketPath = path.join(directory, 'host.sock');
  const sockets = new Set();
  const requests = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const reader = new Reader();
    socket.on('data', (chunk) => {
      for (const frame of reader.take(chunk)) {
        if (frame.kind !== KIND.request) continue;
        requests.push(frame.payload);
        const subscribing = frame.payload.call === 'event_subscribe';
        const reply = encode({
          channel: frame.channel,
          kind: KIND.response,
          payload: subscribing
            ? { reply: 'done' }
            : {
                reply: 'entry',
                with: {
                  path: frame.payload.with.path,
                  directory: false,
                  size: 12,
                  identity: 'readme-v1',
                },
              },
        });
        for (let offset = 0; offset < reply.length; offset += 2)
          socket.write(reply.subarray(offset, offset + 2));
        if (subscribing) {
          const leaked = encode({
            channel: 19,
            kind: KIND.event,
            payload: {
              snapshot: 'filesystem',
              of: {
                entries: [
                  {
                    path: 'private/token',
                    directory: false,
                    size: 6,
                    identity: 'secret-v1',
                  },
                ],
                complete: true,
                coalesced: 0,
                journal: 'b'.repeat(32),
                revision: 1,
              },
            },
          });
          for (const byte of leaked) socket.write(Uint8Array.of(byte));
        }
      }
    });
    const greeting = encode({
      channel: CONTROL,
      kind: KIND.open,
      payload: {
        protocol: 1,
        peer: 'indexer',
        granted: [
          'filesystem:read',
          'filesystem:write',
          'containers:read',
          'images:read',
          'networks:read',
          'volumes:read',
          'workspace-environment:read',
          'credentials:read',
          'credentials:write',
          'credentials:expose-to-execution',
        ],
        filesystem: {
          read: [{ subtree: 'src' }, { exact: 'README.md' }],
          write: [{ exact: 'state/index.json' }],
          create: [{ subtree: 'review-notes' }],
          delete: [{ exact: 'review-notes/stale.md' }],
          rename: [{ subtree: 'review-notes/drafts' }],
        },
        containers: { selectors: [{ name: 'postgres' }], create: false },
        images: {
          read: [{ reference: 'postgres:17' }],
          use: [],
          pull: [],
          remove: [],
          prune_all_unused: false,
        },
        networks: { selectors: [{ name: 'backend' }], create: false },
        volumes: { selectors: [{ name: 'pgdata' }], create: false },
        workspace_environment: { read: [{ workspace: 'dev', name: 'DATABASE_URL' }], write: [] },
        credentials: {
          read: ['database.password'],
          write: ['database.password'],
          expose_to_execution: ['database.password'],
        },
      },
    });
    for (const byte of greeting) socket.write(Uint8Array.of(byte));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const session = await connect({ path: socketPath });
    assert.deepEqual(session.grantedFilesystem, {
      read: [{ subtree: 'src' }, { exact: 'README.md' }],
      write: [{ exact: 'state/index.json' }],
      create: [{ subtree: 'review-notes' }],
      delete: [{ exact: 'review-notes/stale.md' }],
      rename: [{ subtree: 'review-notes/drafts' }],
    });
    assert(Object.isFrozen(session.grantedFilesystem));
    assert(Object.isFrozen(session.grantedFilesystem.read));
    assert(Object.isFrozen(session.grantedFilesystem.read[0]));
    assert.throws(() => session.grantedFilesystem.read.push({ subtree: 'secret' }), TypeError);
    assert.deepEqual(session.grantedCredentials, {
      read: ['database.password'],
      write: ['database.password'],
      expose_to_execution: ['database.password'],
    });
    assert(Object.isFrozen(session.grantedCredentials));
    assert(Object.isFrozen(session.grantedCredentials.read));
    assert.throws(() => session.grantedCredentials.read.push('other.password'), TypeError);
    const credentialApi = workspace(session).credentials;
    assert.equal(credentialApi.keyGrant('read', 'database.password'), true);
    assert.equal(credentialApi.keyGrant('read', 'other.password'), false);
    assert.equal(credentialApi.keyGrant('expose_to_execution', 'database.password'), true);
    const files = workspace(session).files;
    assert.equal(files.pathGrant('read', 'src/index.ts'), 'subtree');
    assert.equal(files.pathGrant('read', 'src\\./nested//index.ts'), 'subtree');
    assert.equal(files.pathGrant('read', 'src2/index.ts'), null);
    assert.equal(files.pathGrant('read', 'README.md'), 'exact');
    assert.equal(files.pathGrant('read', './README.md'), null, 'exact selectors stay exact');
    assert.equal(files.pathGrant('write', 'state/index.json'), 'exact');
    assert.equal(files.pathGrant('write', 'state/index.json.tmp'), null);
    assert.equal(files.pathGrant('create', 'review-notes/new.md'), 'subtree');
    assert.equal(files.pathGrant('delete', 'review-notes/new.md'), null);
    assert.equal(files.pathGrant('delete', 'review-notes/stale.md'), 'exact');
    assert.equal(files.pathGrant('rename', 'review-notes/drafts/one.md'), 'subtree');
    assert.equal(files.pathGrant('rename', 'review-notes/published/one.md'), null);
    assert.throws(() => files.pathGrant('read', '../secret'), /parent traversal/);
    const scoped = files.scopeChanges(
      {
        journal: 'a'.repeat(32),
        changes: [
          {
            cursor: { journal: 'a'.repeat(32), revision: 8 },
            kind: 'modify',
            path: 'src/app.ts',
            entry: null,
          },
          {
            cursor: { journal: 'a'.repeat(32), revision: 9 },
            kind: 'modify',
            path: 'src2/private.ts',
            entry: null,
          },
          {
            cursor: { journal: 'a'.repeat(32), revision: 10 },
            kind: 'modify',
            path: 'README.md',
            entry: null,
          },
          {
            cursor: { journal: 'a'.repeat(32), revision: 11 },
            kind: 'modify',
            path: 'README.md.bak',
            entry: null,
          },
        ],
        next: 11,
        current: 11,
        more: false,
        truncated: false,
      },
      [
        { path: 'src', grant: 'subtree' },
        { path: 'README.md', grant: 'exact' },
      ],
    );
    assert.deepEqual(
      scoped.changes.map(({ path }) => path),
      ['src/app.ts', 'README.md'],
    );
    assert.equal(scoped.next, 11, 'filtering preserves the global journal cursor');
    assert.deepEqual(
      files.reconcilePathRecords(
        {
          'src/current.md': 'old',
          'src/deleted.md': 'stale',
          'README.md': 'old exact',
          'notes/retained.md': 'outside',
        },
        { 'src/current.md': 'new', 'README.md': 'new exact' },
        [
          { path: 'src', grant: 'subtree' },
          { path: 'README.md', grant: 'exact' },
        ],
      ),
      {
        'notes/retained.md': 'outside',
        'src/current.md': 'new',
        'README.md': 'new exact',
      },
    );
    assert.throws(
      () =>
        files.reconcilePathRecords({}, { 'src2/private.md': 'leak' }, [
          { path: 'src', grant: 'subtree' },
        ]),
      /outside its reconciliation roots/,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 0, 'grant planning never probes the host');
    assert.equal((await files.stat('README.md')).identity, 'readme-v1');
    assert.equal(requests.length, 1, 'the fragmented session remains reusable');
    assert.deepEqual(session.grantedContainers.selectors, [{ name: 'postgres' }]);
    assert.deepEqual(session.grantedImages.read, [{ reference: 'postgres:17' }]);
    assert.deepEqual(session.grantedNetworks.selectors, [{ name: 'backend' }]);
    assert.deepEqual(session.grantedVolumes.selectors, [{ name: 'pgdata' }]);
    assert.deepEqual(session.grantedWorkspaceEnvironment.read, [
      { workspace: 'dev', name: 'DATABASE_URL' },
    ]);
    for (const grant of [
      session.grantedContainers,
      session.grantedImages,
      session.grantedNetworks,
      session.grantedVolumes,
      session.grantedWorkspaceEnvironment,
    ]) {
      assert(Object.isFrozen(grant));
      assert(Object.isFrozen(grant.selectors ?? grant.read));
      assert(Object.isFrozen((grant.selectors ?? grant.read)[0]));
    }
    await session.call('event_subscribe', { topic: 'filesystem' });
    assert.match(
      (await session.closed).message,
      /filesystem snapshot path "private\/token" is outside the connected read grant/,
    );
    session.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
