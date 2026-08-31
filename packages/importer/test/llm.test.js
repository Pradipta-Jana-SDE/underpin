import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLlm, validateNames } from '../src/llm/index.js';
import { componentizePage, describeSection, applyLlmNames } from '../src/generate/componentize.js';

const CAPTURE = new URL('./fixtures/captured-elementor-home.json', import.meta.url);
const page = () => JSON.parse(readFileSync(CAPTURE, 'utf8'));

test('no key, no provider, no model layer', () => {
  assert.equal(createLlm({ env: {} }).available, false);
  assert.equal(createLlm({ env: { LLM_PROVIDER: 'none' } }).available, false);
  assert.equal(createLlm({ env: { LLM_PROVIDER: 'anthropic' } }).available, false, 'a provider without a key is not available');
  assert.equal(createLlm({ env: { LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k' }, enabled: false }).available, false, 'never available unless asked for');
});

test('an unknown provider is declined rather than guessed at', () => {
  const llm = createLlm({ env: { LLM_PROVIDER: 'wishful', LLM_API_KEY: 'k' } });
  assert.equal(llm.available, false);
  assert.match(llm.reason, /unknown provider/);
});

test('a configured provider reports the model it will use', () => {
  const llm = createLlm({ env: { LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k' } });
  assert.equal(llm.available, true);
  assert.equal(llm.model, 'claude-opus-5');
  assert.equal(createLlm({ env: { LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k', LLM_MODEL: 'claude-haiku-4-5' } }).model, 'claude-haiku-4-5');
});

test('componentisation is byte-identical with and without an unavailable model', () => {
  // THE invariant, as a test. The pipeline must run with no API key, and "runs" has to
  // mean "produces the same migration" — not "produces something". If this ever fails, the
  // model has stopped being an accelerator and become a dependency.
  const withoutLlm = componentizePage(page());
  const names = null; // what an unavailable or declining model returns
  const withLlm = applyLlmNames(componentizePage(page()), names, () => 'X');
  assert.deepEqual(JSON.parse(JSON.stringify(withLlm)), JSON.parse(JSON.stringify(withoutLlm)));
});

test('a model name replaces the rule name, and chrome keeps its own', () => {
  const parts = componentizePage(page());
  const flat = [];
  const walk = (l) => { for (const x of l) { flat.push(x); if (x.children) walk(x.children); } };
  walk(parts);

  const chrome = flat.find((p) => p.name === 'SiteHeader' || p.name === 'SiteFooter');
  const plain = flat.find((p) => p.name !== 'SiteHeader' && p.name !== 'SiteFooter');
  const names = { [plain.id]: 'PricingTiers' };
  if (chrome) names[chrome.id] = 'TopNavigation';

  applyLlmNames(parts, names, (n) => n);
  assert.equal(plain.name, 'PricingTiers');
  assert.equal(plain.decidedBy, 'llm');
  if (chrome) {
    // SiteHeader/SiteFooter are matched by exact string when deciding whether chrome can
    // be hoisted into the shared layout. Renaming them would silently disable that.
    assert.match(chrome.name, /^Site(Header|Footer)/);
    assert.equal(chrome.decidedBy, 'rule');
  }
});

test('a section description is small enough to send and rich enough to name from', () => {
  const parts = componentizePage(page());
  const d = describeSection(parts[0]);
  assert.ok(d.id && d.tag);
  assert.ok(d.text.length <= 240, 'text sample is capped');
  assert.ok(d.headings.length <= 5);
  assert.equal(typeof d.images, 'number');
  // The whole subtree would be tens of thousands of tokens and name it no better.
  assert.ok(JSON.stringify(d).length < 1200, `description is ${JSON.stringify(d).length} bytes`);
});

test('a malformed model answer is rejected whole, not applied in part', () => {
  const sections = [{ id: 'sec_01' }, { id: 'sec_02' }];
  const bad = [
    null,
    { names: [] },
    { names: [{ id: 'sec_01', name: 'ok' }, { id: 'sec_02', name: 'Fine' }] },       // not PascalCase
    { names: [{ id: 'sec_01', name: 'Same' }, { id: 'sec_02', name: 'Same' }] },     // collides
    { names: [{ id: 'nope', name: 'Hero' }, { id: 'sec_02', name: 'Cta' }] },        // unknown id
    { names: [{ id: 'sec_01', name: 'Hero' }] }                                      // short
  ];
  for (const answer of bad) {
    assert.equal(validateNames(answer, sections), null, `should have rejected ${JSON.stringify(answer)}`);
  }

  assert.deepEqual(
    validateNames({ names: [{ id: 'sec_01', name: 'HeroBanner' }, { id: 'sec_02', name: 'PricingTiers' }] }, sections),
    { sec_01: 'HeroBanner', sec_02: 'PricingTiers' }
  );
});
