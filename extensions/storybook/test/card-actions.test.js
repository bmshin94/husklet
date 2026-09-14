import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h } from 'react';

import { CardActionsWorkbench } from '../dist/card-actions.js';
import { componentPages } from '../dist/component-pages.js';
import { host } from './host.js';

const creations = (frame, tag) =>
  frame.patches.filter((patch) => patch.Create?.tag === tag).map((patch) => patch.Create.id);

const props = (frame, id) =>
  Object.fromEntries(
    frame.patches
      .filter((patch) => patch.SetProp?.id === id)
      .map((patch) => [patch.SetProp.prop, patch.SetProp.value]),
  );

test('CardActions owns a focused single-component workbench', () => {
  assert.equal(componentPages.CardActions, CardActionsWorkbench);
  const frame = host().render(h(CardActionsWorkbench));
  const headings = creations(frame, 'Heading').map((id) => props(frame, id).Label?.Text);
  assert.deepEqual(headings, [
    'Card Actions',
    'Overview',
    'Alignment',
    'Density',
    'Width constraints',
    'Accessibility',
    'API',
  ]);
  const rows = creations(frame, 'CardActions').map((id) => props(frame, id));
  assert.equal(rows.length, 6);
  assert(rows.every((row) => row.Align?.Align === 'Center'));
  assert(rows.some((row) => row.Justify?.Align === 'Start'));
  assert(rows.some((row) => row.Justify?.Align === 'End'));
  assert(rows.some((row) => row.Justify?.Align === 'Center'));
  for (const alignment of ['Start', 'Center', 'End']) {
    assert.ok(
      creations(frame, 'Text').some((id) => props(frame, id).Label?.Text === alignment),
      `${alignment} alignment specimen needs a visible caption`,
    );
  }
  const alignedSpecimens = rows.filter((row) =>
    ['Actions aligned start', 'Actions aligned center', 'Actions aligned end'].includes(
      row.Tooltip?.Text,
    ),
  );
  assert.equal(alignedSpecimens.length, 3);
  assert(
    alignedSpecimens.every((row) => row.Width?.Bounds?.maximum?.Chars === 36),
    'alignment specimens stay bounded instead of scattering controls across the page',
  );
  assert.equal(
    creations(frame, 'Column')
      .map((id) => props(frame, id))
      .filter((column) => column.Width?.Length?.Chars === 48).length,
    3,
    'each alignment comparison owns the same compact measure',
  );
  const buttons = creations(frame, 'Button').map((id) => props(frame, id));
  assert(buttons.length >= 10);
  assert(buttons.every((button) => button.Size?.ControlSize === 'Small'));
});
