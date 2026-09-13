import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h } from 'react';
import { SplitterWorkbench } from '../dist/splitter.js';
import { host } from './host.js';

function labels(patches) {
  return patches
    .filter((patch) => patch.SetProp?.prop === 'Label')
    .map((patch) => patch.SetProp.value?.Text);
}

test('Splitter documents both orientations, interaction, and its public API', () => {
  const stage = host();
  const frame = stage.render(h(SplitterWorkbench));
  const text = labels(frame.patches);
  const sections = ['Splitter', 'Overview', 'Vertical orientation', 'Interaction', 'API'].map(
    (label) => text.indexOf(label),
  );
  assert(sections.every((index) => index >= 0));
  assert.deepEqual(
    sections,
    [...sections].sort((left, right) => left - right),
  );
  assert(text.some((label) => label?.includes('Drag the 8px divider')));
  assert(text.some((label) => label?.includes('arrow keys resize one step')));

  const splitters = frame.patches
    .filter((patch) => patch.Create?.tag === 'Splitter')
    .map((patch) => patch.Create.id);
  assert.equal(splitters.length, 2);
  const orientations = frame.patches
    .filter(
      (patch) => splitters.includes(patch.SetProp?.id) && patch.SetProp?.prop === 'Orientation',
    )
    .map((patch) => patch.SetProp.value?.Orientation);
  assert.deepEqual(orientations, ['Horizontal', 'Vertical']);
});

test('controlled horizontal Splitter preserves the exact reported position', () => {
  const stage = host();
  const frame = stage.render(h(SplitterWorkbench));
  const splitter = frame.patches.find((patch) => patch.Create?.tag === 'Splitter')?.Create.id;
  assert.ok(splitter);
  const before = stage.frames.length;
  assert(
    stage.surface.dispatch({
      trigger: 'Change',
      node: splitter,
      id: `${splitter}:Change`,
      value: 192,
    }),
  );
  assert(labels(stage.since(before)).includes('Leading pane · 192px'));
});
