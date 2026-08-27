import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { splitSections, hoistContent, spliceContent, unwrapTree, nameSection } from '../src/generate/componentize.js';

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
const CAPTURE = new URL('../../../sites/elementor-fidelity/site/content/pages/index.json', import.meta.url);

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
