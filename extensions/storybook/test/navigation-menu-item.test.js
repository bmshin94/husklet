import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h } from 'react';

import { componentPages } from '../dist/component-pages.js';
import { NavigationMenuItemWorkbench } from '../dist/navigation-menu-item.js';
import { host } from './host.js';

function labelledId(patches, label) {
  return patches.find(
    (patch) => patch.SetProp?.prop === 'Label' && patch.SetProp.value?.Text === label,
  )?.SetProp.id;
}

function selected(patches, id) {
  return patches
    .filter((patch) => patch.SetProp?.id === id && patch.SetProp.prop === 'Selected')
    .at(-1)?.SetProp.value?.Flag;
}

test('NavigationMenuItem documents destinations without substituting action buttons', () => {
  assert.equal(componentPages.NavigationMenuItem, NavigationMenuItemWorkbench);
  const stage = host();
  const first = stage.render(h(NavigationMenuItemWorkbench));
  const items = first.patches.filter((patch) => patch.Create?.tag === 'NavigationMenuItem');
  assert.equal(items.length, 4);
  assert.equal(
    first.patches.some((patch) => patch.Create?.tag === 'Button'),
    false,
  );
  assert.equal(
    first.patches.some((patch) => patch.Create?.tag === 'IconButton'),
    false,
  );

  const workspace = labelledId(first.patches, 'Workspace');
  const extensions = labelledId(first.patches, 'Extensions');
  assert.equal(selected(first.patches, workspace), true);
  assert.equal(selected(first.patches, extensions), false);
  assert.ok(
    stage.surface.dispatch({
      trigger: 'Invoke',
      node: extensions,
      id: `${extensions}:Invoke`,
      value: null,
    }),
  );
  const update = stage.frames.at(-1).patches;
  assert.equal(selected(update, workspace), false);
  assert.equal(selected(update, extensions), true);
  assert.equal(labelledId(update, 'Current destination · Extensions') !== undefined, true);
});
