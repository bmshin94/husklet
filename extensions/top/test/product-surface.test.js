import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

test('Top product surfaces never expose the generic ObjectInspector', async () => {
  const root = new URL('../src/', import.meta.url);
  const files = (await readdir(root, { recursive: true }))
    .filter((name) => /\.(?:ts|tsx)$/.test(name))
    .sort();
  const offenders = [];
  for (const name of files) {
    const source = await readFile(new URL(name, root), 'utf8');
    if (source.includes('ObjectInspector')) offenders.push(name);
  }
  assert.deepEqual(offenders, [], 'known host models require domain-specific product views');
});

test('workspace boolean controls preserve their intentional native semantics', async () => {
  const source = await readFile(new URL('../src/workspace.tsx', import.meta.url), 'utf8');
  assert.match(
    source,
    /<FormControlLabel label="Read only"[\s\S]*?<Switch/,
    'Read only must label its sole binary Switch',
  );
  assert.match(
    source,
    /terminalControl\(\s*'Cursor blink',\s*<Select[\s\S]*?choices=\{\[[\s\S]*?value: '', label: 'Host default'[\s\S]*?value: 'true', label: 'On'[\s\S]*?value: 'false', label: 'Off'/,
    'Cursor blink must retain its host-default, on, and off Select states',
  );
  assert.doesNotMatch(source, /<FormControlLabel label="Cursor blink"/);
  assert.doesNotMatch(source, /<Switch[\s\S]{0,160}\/>\s*<Text label="Read only"/);
});
