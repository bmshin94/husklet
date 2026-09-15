import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h } from 'react';
import { Containers, Executions, Images, Networks, Volumes } from '../dist/app.js';
import { host } from './host.js';

const resource = (data) => ({ data, loading: false, error: null, reload: async () => {} });

test('image inventory keeps destruction compact until a full-width confirmation is requested', async () => {
  const stage = host();
  const frame = stage.render(
    h(Images, {
      api: {
        images: {
          inspect: async () => {
            throw new Error('manifest disappeared');
          },
        },
      },
      resource: resource([{ id: 'sha256:image', reference: 'alpine:3.20', size: 1024 }]),
    }),
  );

  assert.ok(labelled(stage, 'Image reference'));
  assert.ok(labelled(stage, 'Image maintenance'));
  assert.ok(labelled(stage, 'Remove image…'));
  assert.equal(labelled(stage, 'Danger zone'), undefined);
  const card = frame.patches.find((patch) => patch.Create?.tag === 'Card')?.Create.id;
  assert.ok(card, 'the image inventory renders a resource card');
  assert.ok(
    frame.patches.some(
      (patch) =>
        patch.SetProp?.id === card &&
        patch.SetProp.prop === 'Width' &&
        patch.SetProp.value?.Length === 'Fill',
    ),
    'the resource card consumes the readable page width',
  );
  assert.equal(
    ancestorTags(stage, 'Inspect').includes('CardContent'),
    true,
    'the trailing action group stays inside the compact summary rather than becoming a footer',
  );
  const inspect = frame.patches.find(
    (patch) => patch.SetProp?.prop === 'Label' && patch.SetProp.value?.Text === 'Inspect',
  )?.SetProp.id;
  assert.ok(
    frame.patches.some(
      (patch) => patch.Create?.id === inspect && patch.Create.tag === 'InlineButton',
    ),
  );
  assert.ok(
    frame.patches.some(
      (patch) =>
        patch.SetProp?.id === inspect &&
        patch.SetProp.prop === 'Variant' &&
        patch.SetProp.value?.Variant === 'Outline',
    ),
    'inspection remains a secondary action rather than competing with image pull',
  );
  assert.deepEqual(ancestorTags(stage, 'Inspect').slice(0, 4), [
    'CardActions',
    'Row',
    'Responsive',
    'CardContent',
  ]);
  assert.deepEqual(ancestorTags(stage, 'Remove image…').slice(0, 4), [
    'CardActions',
    'Row',
    'Responsive',
    'CardContent',
  ]);
  assert.deepEqual(ancestorProperty(stage, 'Inspect', 0, 'Justify'), { Align: 'Center' });
  assert.equal(
    frame.patches.some(
      (patch) =>
        patch.Create?.tag === 'Spacer' &&
        frame.patches.some(
          (propertyPatch) =>
            propertyPatch.SetProp?.id === patch.Create.id &&
            propertyPatch.SetProp.prop === 'Width' &&
            propertyPatch.SetProp.value?.Length === 'Fill',
        ),
    ),
    true,
    'a horizontal-only spacer separates identity and status from the trailing action cluster',
  );
  assert.deepEqual(property(stage, 'Inspect', 'Variant'), { Variant: 'Outline' });
  assert.deepEqual(property(stage, 'Remove image…', 'Variant'), { Variant: 'Ghost' });
  assert.deepEqual(property(stage, 'Remove image…', 'Tone'), { Tone: 'Danger' });
  assert.deepEqual(property(stage, 'Remove image…', 'Tooltip'), {
    Text: 'Remove this image from the workspace image store',
  });
  invoke(stage, 'Remove image…');
  assert.ok(labelled(stage, 'Removing alpine:3.20 (sha256:image) cannot be undone.'));
  assert.deepEqual(ancestorTags(stage, 'Remove image').slice(0, 3), [
    'Row',
    'Column',
    'CardContent',
  ]);
  assert.deepEqual(property(stage, 'Remove image', 'Size'), { ControlSize: 'Small' });
  assert.deepEqual(property(stage, 'Remove image', 'Destructive'), { Flag: true });
  invoke(stage, 'Inspect');
  await settled();
  assert.ok(
    labelled(
      stage,
      'Verify that the image still exists and that this extension has access to it, then retry inspection.',
    ),
  );
});

test('network inventory keeps a compact trigger and gives confirmation the card width', () => {
  const stage = host();
  stage.render(
    h(Networks, {
      api: { networks: {} },
      resource: resource([
        {
          id: 'a'.repeat(32),
          name: 'development',
          driver: 'bridge',
          scope: 'local',
          kind: 'custom',
          endpoints: { containers: [], truncated: false },
        },
      ]),
      containers: resource([]),
      onOpenExtensions: () => {},
    }),
  );

  assert.deepEqual(ancestorTags(stage, 'Manage network').slice(0, 4), [
    'CardActions',
    'Row',
    'Responsive',
    'CardContent',
  ]);
  assert.equal(tag(stage, 'Manage network'), 'InlineButton');
  assert.deepEqual(ancestorTags(stage, 'Remove network…').slice(0, 4), [
    'CardActions',
    'Row',
    'Responsive',
    'CardContent',
  ]);
  assert.deepEqual(property(stage, 'Remove network…', 'Tooltip'), {
    Text: 'Remove this network from the workspace',
  });
  invoke(stage, 'Remove network…');
  assert.ok(
    labelled(
      stage,
      'Removing network development disconnects it from the workspace and cannot be undone.',
    ),
  );
  assert.deepEqual(ancestorTags(stage, 'Remove network').slice(0, 3), [
    'Row',
    'Column',
    'CardContent',
  ]);
  assert.deepEqual(property(stage, 'Remove network', 'Size'), { ControlSize: 'Small' });
});

test('volume authority refusal gives one recovery path and withholds removal', async () => {
  const denied = Object.assign(new Error('outside the consented resource scope'), {
    kind: 'denied',
  });
  const stage = host();
  let openedExtensions = 0;
  stage.render(
    h(Volumes, {
      api: {
        volumes: {
          inspect: async () => {
            throw denied;
          },
        },
      },
      resource: resource([{ name: 'private-data', driver: 'local', generation: '7' }]),
      onOpenExtensions: () => {
        openedExtensions += 1;
      },
    }),
  );

  assert.ok(labelled(stage, 'Volume name'));
  invoke(stage, 'Inspect');
  await settled();
  assert.ok(
    labelled(stage, 'Volume access is denied. Review access in Extensions, then inspect again.'),
  );
  assert.equal(labelled(stage, 'Access required'), undefined);
  assert.equal(currentLabels(stage).includes('Remove'), false);
  assert.deepEqual(property(stage, 'Review access', 'Size'), { ControlSize: 'Small' });
  invoke(stage, 'Review access');
  assert.equal(openedExtensions, 1);
});

test('volume inventory keeps inspection compact and expands danger below the summary', () => {
  const stage = host();
  stage.render(
    h(Volumes, {
      api: { volumes: {} },
      resource: resource([{ name: 'workspace-cache', driver: 'local', generation: '7' }]),
      onOpenExtensions: () => {},
    }),
  );

  assert.equal(tag(stage, 'Inspect'), 'InlineButton');
  assert.deepEqual(property(stage, 'Inspect', 'Variant'), { Variant: 'Outline' });
  assert.deepEqual(ancestorTags(stage, 'Inspect').slice(0, 4), [
    'CardActions',
    'Row',
    'Responsive',
    'CardContent',
  ]);
  assert.deepEqual(ancestorTags(stage, 'Delete volume…').slice(0, 4), [
    'CardActions',
    'Row',
    'Responsive',
    'CardContent',
  ]);
  assert.deepEqual(property(stage, 'Delete volume…', 'Tooltip'), {
    Text: 'Remove this volume and permanently delete its stored data',
  });
  invoke(stage, 'Delete volume…');
  assert.ok(
    labelled(stage, 'Removing volume workspace-cache permanently deletes its stored data.'),
  );
  assert.deepEqual(ancestorTags(stage, 'Remove volume').slice(0, 3), [
    'Row',
    'Column',
    'CardContent',
  ]);
  assert.deepEqual(property(stage, 'Remove volume', 'Size'), { ControlSize: 'Small' });
});

test('resource inspection actions become explicit compact close actions', async () => {
  const imageStage = host();
  imageStage.render(
    h(Images, {
      api: {
        images: {
          inspect: async () => ({
            id: 'sha256:image',
            references: ['alpine:3.20'],
            created: '2026-09-12T12:00:00Z',
            size: 1024,
            os: 'linux',
            architecture: 'amd64',
            entrypoint: [],
            command: [],
            working_directory: '/',
            user: '',
          }),
        },
      },
      resource: resource([{ id: 'sha256:image', reference: 'alpine:3.20', size: 1024 }]),
    }),
  );
  invoke(imageStage, 'Inspect');
  await settled();
  assert.ok(labelled(imageStage, 'Image summary'));
  assert.deepEqual(property(imageStage, 'Hide details', 'Variant'), { Variant: 'Outline' });
  assert.deepEqual(property(imageStage, 'Hide details', 'Tone'), { Tone: 'Neutral' });
  assert.equal(tag(imageStage, 'Hide details'), 'InlineButton');
  invoke(imageStage, 'Hide details');
  await settled();
  assert.equal(currentLabels(imageStage).includes('Image summary'), false);
  assert.ok(currentLabels(imageStage).includes('Inspect'));

  const volumeStage = host();
  volumeStage.render(
    h(Volumes, {
      api: {
        volumes: {
          inspect: async (name) => ({ name, driver: 'local', generation: '7' }),
        },
      },
      resource: resource([{ name: 'workspace-cache', driver: 'local', generation: '7' }]),
      onOpenExtensions: () => {},
    }),
  );
  invoke(volumeStage, 'Inspect');
  await settled();
  assert.ok(labelled(volumeStage, 'Volume details'));
  assert.deepEqual(property(volumeStage, 'Hide details', 'Variant'), { Variant: 'Outline' });
  assert.deepEqual(property(volumeStage, 'Hide details', 'Tone'), { Tone: 'Neutral' });
  invoke(volumeStage, 'Hide details');
  await settled();
  assert.equal(currentLabels(volumeStage).includes('Volume details'), false);
  assert.ok(currentLabels(volumeStage).includes('Inspect'));

  const networkStage = host();
  networkStage.render(
    h(Networks, {
      api: {
        networks: {
          inspect: async (id) => ({
            id,
            name: 'development',
            driver: 'bridge',
            scope: 'local',
            kind: 'custom',
            endpoints: { containers: [], truncated: false },
          }),
        },
      },
      resource: resource([
        {
          id: 'a'.repeat(32),
          name: 'development',
          driver: 'bridge',
          scope: 'local',
          kind: 'custom',
          endpoints: { containers: [], truncated: false },
        },
      ]),
      containers: resource([]),
      onOpenExtensions: () => {},
    }),
  );
  invoke(networkStage, 'Manage network');
  await settled();
  assert.ok(labelled(networkStage, 'Network details'));
  assert.deepEqual(property(networkStage, 'Hide details', 'Variant'), { Variant: 'Outline' });
  assert.deepEqual(property(networkStage, 'Hide details', 'Tone'), { Tone: 'Neutral' });
  assert.equal(tag(networkStage, 'Hide details'), 'InlineButton');
  invoke(networkStage, 'Hide details');
  await settled();
  assert.equal(currentLabels(networkStage).includes('Network details'), false);
  assert.ok(currentLabels(networkStage).includes('Manage network'));
});

test('container authority refusal explains recovery and withholds detail operations', async () => {
  const denied = Object.assign(new Error('outside the consented resource scope'), {
    kind: 'denied',
  });
  const stage = host();
  let openedExtensions = 0;
  stage.render(
    h(Containers, {
      api: {
        containers: {
          inspect: async () => {
            throw denied;
          },
        },
      },
      resource: resource([
        {
          id: 'container-private',
          name: 'private-api',
          image: 'internal/api:latest',
          state: 'running',
          generation: 4,
        },
      ]),
      onOpenExtensions: () => {
        openedExtensions += 1;
      },
    }),
  );

  invoke(stage, 'Details');
  await settled();
  await settled();
  assert.equal(currentLabels(stage).includes('Access required'), false);
  assert.ok(
    labelled(
      stage,
      'Top does not have permission to inspect this container. Review its exact container access in Extensions, then inspect again.',
    ),
  );
  assert.equal(
    currentLabels(stage).filter((label) => label.includes('permission to inspect this container'))
      .length,
    1,
    'the refusal is explained once',
  );
  assert.deepEqual(property(stage, 'Review access', 'Size'), { ControlSize: 'Small' });
  invoke(stage, 'Review access');
  assert.equal(openedExtensions, 1, 'the recovery action invokes application navigation');
  assert.equal(currentLabels(stage).includes('Retry details'), false);
  assert.equal(currentLabels(stage).includes('Load logs'), false);
  assert.equal(currentLabels(stage).includes('Kill'), false);
  assert.equal(currentLabels(stage).includes('Execute'), false);
});

test('execution output has an observable loading state and explicit empty result', async () => {
  let finish;
  const logs = new Promise((resolve) => {
    finish = resolve;
  });
  const item = {
    id: 'e'.repeat(32),
    container_id: 'c'.repeat(32),
    running: false,
    exit_code: 0,
    result: { kind: 'code', value: 0 },
    created_at_ms: 1_000,
    started_at_ms: null,
    finished_at_ms: 1_100,
    pid: 0,
    command: ['true'],
    user: '',
  };
  const stage = host();
  stage.render(
    h(Executions, {
      api: { containers: { execution: async () => item, executionLogs: async () => logs } },
      resource: resource([item]),
      requestedExecution: item.id,
    }),
  );
  await settled();
  invoke(stage, 'Load output');
  await settled();
  assert.ok(labelled(stage, 'Loading captured output…'));
  finish({ stdout: '', stderr: '', truncated: false, eof: true });
  await until(() => textProperty(stage, 'No stdout captured (EOF).'));
  assert.ok(textProperty(stage, 'No stdout captured (EOF).'));
  assert.ok(textProperty(stage, 'No stderr captured (EOF).'));
  assert.ok(labelled(stage, 'More actions'));
  assert.deepEqual(property(stage, 'More actions', 'Variant'), { Variant: 'Ghost' });
  assert.equal(labelled(stage, 'Remove record'), undefined);
  invoke(stage, 'More actions');
  await settled();
  assert.ok(
    ancestorTags(stage, 'Remove record').includes('CardContent'),
    'secondary actions live in the card-width panel rather than the summary row',
  );
  assert.ok(labelled(stage, 'Close actions'));
});

test('execution summaries keep exact commands and container authority selectable', async () => {
  const containerId = 'c'.repeat(64);
  const item = {
    id: 'e'.repeat(32),
    container_id: containerId,
    running: false,
    exit_code: 0,
    result: { kind: 'code', value: 0 },
    created_at_ms: 1_000,
    started_at_ms: 1_010,
    finished_at_ms: 1_100,
    pid: 41,
    command: ['/bin/sh', '-lc', 'printf ready'],
    user: 'developer',
  };
  const command = "/bin/sh -lc 'printf ready'";
  const compactContainerId = containerId.slice(0, 12);
  const stage = host();
  stage.render(
    h(Executions, {
      api: { containers: { execution: async () => item } },
      resource: resource([item]),
    }),
  );

  assert.equal(tag(stage, 'Command'), 'Text', 'the compact command label stays proportional');
  assert.equal(tag(stage, 'Container'), 'Text', 'the compact container label stays proportional');
  assert.equal(tagForValue(stage, command), 'Code');
  assert.equal(tagForValue(stage, compactContainerId), 'Code');
  assert.deepEqual(propertyForValue(stage, command, 'Tooltip'), { Text: command });
  assert.deepEqual(propertyForValue(stage, compactContainerId, 'Tooltip'), { Text: containerId });
  assert.deepEqual(propertyForValue(stage, command, 'Ellipsize'), { Flag: true });
  assert.deepEqual(propertyForValue(stage, compactContainerId, 'Ellipsize'), { Flag: true });
  assert.deepEqual(ancestorTagsForValue(stage, command).slice(0, 4), [
    'Row',
    'Row',
    'Responsive',
    'CardContent',
  ]);
  assert.ok(
    ancestorTagsForValue(stage, compactContainerId).includes('Card'),
    'the exact container identity stays inside its execution card',
  );

  invoke(stage, 'Details');
  await settled();
  await settled();

  assert.equal(tag(stage, 'Command'), 'Text', 'the detail command label stays proportional');
  assert.equal(tag(stage, 'Container ID'), 'Text', 'ResourceIdentity keeps its label proportional');
  assert.equal(tagForValue(stage, command), 'Code');
  assert.equal(tagForValue(stage, containerId), 'Code');
  assert.deepEqual(propertyForValue(stage, command, 'Wrap'), { Flag: true });
  assert.deepEqual(propertyForValue(stage, containerId, 'Wrap'), { Flag: true });
  assert.deepEqual(propertyForValue(stage, command, 'Tooltip'), { Text: command });
  assert.deepEqual(propertyForValue(stage, containerId, 'Tooltip'), { Text: containerId });
  assert.deepEqual(ancestorTagsForValue(stage, containerId).slice(0, 2), ['Column', 'Column']);
});

function currentLabels(stage) {
  const labels = new Map();
  const parents = new Map();
  const removed = new Set();
  for (const frame of stage.frames) {
    for (const patch of frame.patches) {
      if (patch.Insert) {
        parents.set(patch.Insert.child, patch.Insert.parent);
        removed.delete(patch.Insert.child);
      }
      if (patch.Remove) removed.add(patch.Remove.id);
      if (patch.SetProp?.prop === 'Label') labels.set(patch.SetProp.id, patch.SetProp.value?.Text);
    }
  }
  const active = (node) => {
    for (let current = node; current !== undefined; current = parents.get(current)) {
      if (removed.has(current)) return false;
    }
    return true;
  };
  return [...labels].filter(([node]) => active(node)).map(([, label]) => label);
}

function ancestorTags(stage, label) {
  const patches = stage.frames.flatMap((frame) => frame.patches);
  const tags = new Map(
    patches.filter((patch) => patch.Create).map((patch) => [patch.Create.id, patch.Create.tag]),
  );
  const parents = new Map(
    patches
      .filter((patch) => patch.Insert)
      .map((patch) => [patch.Insert.child, patch.Insert.parent]),
  );
  let node = patches
    .filter((patch) => patch.SetProp?.prop === 'Label' && patch.SetProp.value?.Text === label)
    .at(-1)?.SetProp.id;
  const ancestors = [];
  while (parents.has(node)) {
    node = parents.get(node);
    ancestors.push(tags.get(node));
  }
  return ancestors;
}

function ancestorProperty(stage, label, depth, prop) {
  const patches = stage.frames.flatMap((frame) => frame.patches);
  const parents = new Map(
    patches
      .filter((patch) => patch.Insert)
      .map((patch) => [patch.Insert.child, patch.Insert.parent]),
  );
  let node = patches
    .filter((patch) => patch.SetProp?.prop === 'Label' && patch.SetProp.value?.Text === label)
    .at(-1)?.SetProp.id;
  for (let index = 0; index <= depth; index += 1) node = parents.get(node);
  return patches.filter((patch) => patch.SetProp?.id === node && patch.SetProp.prop === prop).at(-1)
    ?.SetProp.value;
}

function valueNode(stage, value) {
  return stage.frames
    .flatMap((frame) => frame.patches)
    .filter((patch) => patch.SetProp?.prop === 'Value' && patch.SetProp.value?.Text === value)
    .at(-1)?.SetProp.id;
}

function tagForValue(stage, value) {
  const patches = stage.frames.flatMap((frame) => frame.patches);
  const node = valueNode(stage, value);
  return patches.find((patch) => patch.Create?.id === node)?.Create.tag;
}

function propertyForValue(stage, value, prop) {
  const patches = stage.frames.flatMap((frame) => frame.patches);
  const node = valueNode(stage, value);
  return patches.filter((patch) => patch.SetProp?.id === node && patch.SetProp.prop === prop).at(-1)
    ?.SetProp.value;
}

function ancestorTagsForValue(stage, value) {
  const patches = stage.frames.flatMap((frame) => frame.patches);
  const tags = new Map(
    patches.filter((patch) => patch.Create).map((patch) => [patch.Create.id, patch.Create.tag]),
  );
  const parents = new Map(
    patches
      .filter((patch) => patch.Insert)
      .map((patch) => [patch.Insert.child, patch.Insert.parent]),
  );
  let node = valueNode(stage, value);
  const ancestors = [];
  while (parents.has(node)) {
    node = parents.get(node);
    ancestors.push(tags.get(node));
  }
  return ancestors;
}

function labelled(stage, label) {
  return stage.frames
    .flatMap((frame) => frame.patches)
    .filter((patch) => patch.SetProp?.prop === 'Label' && patch.SetProp.value?.Text === label)
    .at(-1);
}

function tag(stage, label) {
  const patches = stage.frames.flatMap((frame) => frame.patches);
  const id = patches
    .filter((patch) => patch.SetProp?.prop === 'Label' && patch.SetProp.value?.Text === label)
    .at(-1)?.SetProp.id;
  return patches.find((patch) => patch.Create?.id === id)?.Create.tag;
}

function property(stage, label, prop) {
  const patches = stage.frames.flatMap((frame) => frame.patches);
  const id = patches
    .filter((patch) => patch.SetProp?.prop === 'Label' && patch.SetProp.value?.Text === label)
    .at(-1)?.SetProp.id;
  return patches.filter((patch) => patch.SetProp?.id === id && patch.SetProp.prop === prop).at(-1)
    ?.SetProp.value;
}

function textProperty(stage, value) {
  return stage.frames
    .flatMap((frame) => frame.patches)
    .some((patch) =>
      Object.values(patch.SetProp?.value ?? {}).some((property) => property === value),
    );
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

const settled = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await settled();
  }
  assert.fail('condition did not become true');
}
