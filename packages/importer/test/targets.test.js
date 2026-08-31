import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargets, describeTargets } from '../src/generate/targets.js';

const plan = (extra = {}) => ({
  inScopeUrls: [
    'https://x.test/', 'https://x.test/about/', 'https://x.test/pricing/',
    'https://x.test/blog/a/', 'https://x.test/blog/b/', 'https://x.test/blog/c/'
  ],
  ...extra
});

test('a selection wins over a limit', () => {
  // The load-bearing test. The operator ticked these pages in the picker; sampling on top
  // of that would silently build something they did not ask for — which is exactly the bug
  // this module exists to fix.
  const selected = ['https://x.test/', 'https://x.test/pricing/'];
  const r = resolveTargets(plan({ selectedUrls: selected }), { limit: 4 });
  assert.equal(r.source, 'selected');
  assert.deepEqual(r.urls, selected);
});

test('a limit samples only when nobody has chosen', () => {
  const r = resolveTargets(plan(), { limit: 3 });
  assert.equal(r.source, 'sampled');
  assert.equal(r.urls.length, 3);
  for (const u of r.urls) assert.ok(plan().inScopeUrls.includes(u));
});

test('explicit urls beat both', () => {
  const urls = ['https://x.test/only/'];
  const r = resolveTargets(plan({ selectedUrls: ['https://x.test/'] }), { urls, limit: 2 });
  assert.equal(r.source, 'explicit');
  assert.deepEqual(r.urls, urls);
});

test('an empty selection falls through instead of building nothing', () => {
  // `selectedUrls: []` is what the picker writes when the operator clears every box and
  // then changes their mind. Treating it as a selection would build zero pages; `?.length`
  // rather than `?.` is what makes the difference.
  const r = resolveTargets(plan({ selectedUrls: [] }));
  assert.equal(r.source, 'in-scope');
  assert.equal(r.urls.length, 6);
});

test('no limit and no selection builds everything in scope', () => {
  const r = resolveTargets(plan());
  assert.equal(r.source, 'in-scope');
  assert.equal(r.urls.length, 6);
});

test('a missing or empty plan degrades to an empty build rather than throwing', () => {
  assert.deepEqual(resolveTargets(null).urls, []);
  assert.deepEqual(resolveTargets({}).urls, []);
});

test('the progress label says when a selection took effect', () => {
  // Without this the operator cannot tell from the log whether their picks were honoured.
  assert.equal(describeTargets({ urls: ['a', 'b'], source: 'selected' }), '2 selected pages');
  assert.equal(describeTargets({ urls: ['a'], source: 'sampled' }), '1 sampled page');
  assert.equal(describeTargets({ urls: ['a', 'b'], source: 'in-scope' }), '2 pages');
});
