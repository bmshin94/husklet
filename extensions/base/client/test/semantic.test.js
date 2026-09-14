import assert from 'node:assert/strict';
import test from 'node:test';
import { semanticText, semanticXml } from '../dist/index.js';

test('semantic XML is deterministic, escaped, redacted, and bounded', () => {
  const xml = semanticXml({
    slot: 'pane<&',
    generation: 2,
    revision: 3,
    truncated: false,
    root: {
      id: 1,
      role: 'textbox',
      label: '<Account>',
      value: 'never-print-me',
      redacted: true,
      disabled: false,
      destructive: true,
      actions: ['invoke'],
      children: [],
    },
  });
  assert.match(xml, /^<pane slot="pane&lt;&amp;" generation="2" revision="3"/);
  assert.match(xml, /<label>&lt;Account&gt;<\/label>/);
  assert.match(xml, /<value redacted="true">\[redacted\]<\/value>/);
  assert(!xml.includes('never-print-me'));
  assert(new TextEncoder().encode(xml).byteLength <= 64 * 1024);
});

test('semantic redaction is structural rather than guessed from labels', () => {
  const node = (label, value, redacted) => ({
    id: 1,
    role: 'textbox',
    label,
    value,
    redacted,
    disabled: false,
    destructive: false,
    actions: [],
    children: [],
  });
  const tree = (root) => ({ slot: 'surface', generation: 1, revision: 2, truncated: false, root });
  assert.match(semanticXml(tree(node('Ordinary token count', '42', false))), /<value>42<\/value>/);
  const hidden = semanticXml(tree(node('Account', 'must-not-escape', true)));
  assert.match(hidden, /redacted="true">\[redacted\]/);
  assert(!hidden.includes('must-not-escape'));
});

test('semantic text distinguishes host truncation from bounded XML projection truncation', () => {
  const node = (id) => ({
    id,
    role: 'button',
    label: 'label'.repeat(80),
    value: null,
    redacted: false,
    disabled: false,
    destructive: false,
    actions: ['invoke'],
    children: [],
  });
  const projected = semanticText({
    slot: 'surface',
    generation: 4,
    revision: 9,
    truncated: false,
    root: { ...node(0), children: Array.from({ length: 255 }, (_, index) => node(index + 1)) },
  });
  assert.equal(projected.complete, false);
  assert.equal(projected.sourceTruncated, false);
  assert.equal(projected.projectionTruncated, true);
  assert.match(projected.text, /<truncated\/>/);
  assert(new TextEncoder().encode(projected.text).byteLength <= 64 * 1024);

  const source = semanticText({
    slot: 'surface',
    generation: 4,
    revision: 10,
    truncated: true,
    root: node(0),
  });
  assert.equal(source.complete, false);
  assert.equal(source.sourceTruncated, true);
  assert.equal(source.projectionTruncated, false);
});
