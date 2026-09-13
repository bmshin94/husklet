import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h } from 'react';

import { ResponsiveWorkbench } from '../dist/responsive.js';
import { host } from './host.js';

test('Responsive documents explicit compact and wide alternate subtrees', () => {
  const frame = host().render(h(ResponsiveWorkbench));
  const responsive = frame.patches.find((patch) => patch.Create?.tag === 'Responsive')?.Create.id;
  assert.ok(responsive);
  assert(
    frame.patches.some(
      (patch) =>
        patch.SetProp?.id === responsive &&
        patch.SetProp.prop === 'Breakpoint' &&
        patch.SetProp.value?.Number === 720,
    ),
  );
  assert.equal(
    frame.patches.filter((patch) => patch.Insert?.parent === responsive).length,
    2,
    'alternate layout owns exactly compact and wide branches',
  );
  assert.equal(
    frame.patches.filter((patch) => patch.Create?.tag === 'Splitter').length,
    0,
    'alternate layout must not invent divider semantics',
  );
});
