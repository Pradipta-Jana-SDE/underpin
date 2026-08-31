import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { splitSections, hoistContent, spliceContent, unwrapTree, nameSection, componentizePage } from '../src/generate/componentize.js';

const el = (t, a = {}, ...c) => ({ t, a, c });

test('hoist then splice returns a structurally identical tree', () => {
  // The load-bearing test. If decomposition changes the tree at all, the rendered DOM
  // changes, and every :nth-child count and sibling selector on the page is at risk.
  const tree = el('div', { class: 'sec' },
    el('h2', {}, 'Our Services'),
    el('p', { class: 'lede' }, 'We do things ', el('strong', {}, 'well')),
    el('img', { src: '/a.jpg', alt: 'A photo', class: 'hero' }),
    el('a', { href: '/contact/', 'data-track': 'cta' }, 'Get in touch')
  );
  const content = hoistContent(tree);
  const back = spliceContent(structuredClone(tree), content);
  assert.deepEqual(back, tree);
});

test('hoisting captures text and media but never structure', () => {
  const tree = el('div', { class: 'card', 'data-id': '7', style: 'color:red' },
    el('h3', {}, 'Title'),
    el('img', { src: '/x.png', alt: 'X', class: 'thumb' })
  );
  const { text, media } = hoistContent(tree);
  assert.deepEqual(Object.values(text), ['Title']);
  assert.ok(Object.values(media).includes('/x.png'));
  assert.ok(Object.values(media).includes('X'));
  // class, data-* and style are structure and must never be hoisted.
  const all = JSON.stringify({ text, media });
  assert.ok(!all.includes('card') && !all.includes('color:red') && !all.includes('"7"'));
});

test('unwrapTree passes through script-injected wrappers', () => {
  // GSAP ScrollTrigger injects pin-spacer divs at runtime; they wrap exactly one
  // section each and must be transparent to boundary detection.
  const inner = el('section', { class: 'elementor-section' }, el('p', {}, 'real content here'));
  const wrapped = el('div', { class: 'pin-spacer-heroScroll' }, el('div', { class: 'wrap' }, inner));
  assert.equal(unwrapTree(wrapped), inner);
});

test('unwrapTree stops at a component rather than descending into it', () => {
  const carousel = el('div', { class: 'swiper testimonial' }, el('p', {}, 'only slide rendered'));
  const wrapped = el('div', { class: 'outer' }, carousel);
  assert.equal(unwrapTree(wrapped), carousel);
});

test('runs of identical siblings collapse into one section, not N', () => {
  const body = el('body', {},
    ...Array.from({ length: 6 }, (_, i) =>
      el('div', { class: 'logo-cell' }, el('img', { src: `/l${i}.png` }))
    )
  );
  const sections = splitSections(body);
  assert.equal(sections.length, 1, 'six logos are one section');
  assert.equal(sections[0].kind, 'run');
  assert.equal(sections[0].nodes.length, 6);
});

test('section naming is deterministic and filename-safe', () => {
  const hero = el('section', {}, el('h1', {}, 'Welcome'));
  const name = nameSection(hero, 1);
  assert.match(name, /^Section01[A-Za-z]+$/);
  assert.equal(name, nameSection(hero, 1), 'same input, same name');
});

// ------------------------------------------------- against real captured data
//
// A committed fixture rather than a path into sites/. The three tests below are the ones
// that assert decomposition never loses a node, and for most of this project's life they
// silently skipped because the capture they pointed at was gitignored and absent. A test
// that cannot run is not a test.
//
// Regenerate after a change to capture/:
//   node packages/importer/bin/underpin.js build https://elementor.com --mode fidelity --limit 1
//   then slim sites/elementor.com/site/content/pages/index.json to
//   {path,url,title,lang,bodyClass,htmlClass,tree} — sheets and scripts are megabytes and
//   nothing here reads them.
const CAPTURE = new URL('./fixtures/captured-elementor-home.json', import.meta.url);

test('the capture fixture is committed', () => {
  // Unconditional on purpose: without it, deleting the fixture turns three real tests into
  // three silent skips and the suite still reports green.
  assert.ok(existsSync(CAPTURE), 'missing packages/importer/test/fixtures/captured-elementor-home.json');
});

test('round-trips a real captured page without changing a single node', { skip: !existsSync(CAPTURE) }, () => {
  const page = JSON.parse(readFileSync(CAPTURE, 'utf8'));
  const sections = splitSections(page.tree);
  assert.ok(sections.length >= 2, `expected several sections, got ${sections.length}`);

  for (const s of sections) {
    for (const node of s.nodes) {
      const content = hoistContent(node);
      const back = spliceContent(structuredClone(node), content);
      assert.deepEqual(back, node, `section ${s.id} did not survive the round trip`);
    }
  }
});

test('componentised emission covers the whole captured tree, node for node', { skip: !existsSync(CAPTURE) }, () => {
  // The real acceptance test. Byte-diffing two *builds* cannot work here: each build
  // re-captures a live site, and elementor.com renders differently every time (measured:
  // 1075 vs 1076 nodes, 77 vs 83 body children across two runs). The question that
  // actually matters is whether decomposition loses anything from the capture it was
  // given — so compare the emission against its own source tree.
  const page = JSON.parse(readFileSync(CAPTURE, 'utf8'));
  const count = (n) => (!n || typeof n === 'string' ? 0 : 1 + (n.c ?? []).reduce((s, c) => s + count(c), 0));

  const parts = componentizePage(page);
  const emitted = parts.reduce((sum, p) => {
    const t = p.tree;
    // A run is wrapped in a synthetic fragment that never reaches the DOM.
    return sum + (t.t === 'underpin-fragment' ? (t.c ?? []).reduce((s, c) => s + count(c), 0) : count(t));
  }, 0);

  // +1 for <body> itself, which is the container rather than a section.
  assert.equal(emitted + 1, count(page.tree), 'componentisation dropped nodes from the capture');
});

test('every captured body child lands in exactly one section', { skip: !existsSync(CAPTURE) }, () => {
  const page = JSON.parse(readFileSync(CAPTURE, 'utf8'));
  const sections = splitSections(page.tree);
  const flat = sections.flatMap((s) => s.nodes);
  const original = (page.tree.c ?? []).filter(
    (c) => (c && typeof c === 'object' && c.t) || (typeof c === 'string' && c.trim())
  );
  assert.equal(flat.length, original.length, 'partition is not one-to-one with the body children');
  assert.deepEqual(flat, original, 'partition reordered or altered the children');
});
