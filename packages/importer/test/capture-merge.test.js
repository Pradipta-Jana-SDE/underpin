import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeResources, isPlaceholder } from '../src/capture/merge.js';

const el = (t, a = {}, ...c) => ({ t, a, c });

/** Node count, elements only — the invariant every test in this file leans on. */
const count = (n) => (!n || typeof n === 'string' ? 0 : 1 + (n.c ?? []).reduce((s, c) => s + count(c), 0));
/** Tag-and-order skeleton: proves nothing moved, not just that nothing was lost. */
const skeleton = (n) => (typeof n === 'string' ? '#' : `${n.t}(${(n.c ?? []).map(skeleton).join(',')})`);

const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

test('identical trees merge to a no-op', () => {
  // The baseline. Most nodes on a page have nothing to merge, and the merge must be able
  // to walk past them without touching the tree at all.
  const virgin = el('div', { class: 'wrap' },
    el('h2', {}, 'Services'),
    el('img', { src: '/real.jpg', alt: 'A photo' })
  );
  const driven = structuredClone(virgin);
  const before = structuredClone(virgin);

  const { tree, merged, unmerged } = mergeResources(virgin, driven);

  assert.deepEqual(tree, before, 'a no-op merge still altered the tree');
  assert.equal(merged.length, 0);
  assert.equal(unmerged.length, 0);
  assert.equal(count(tree), count(before));
});

test('a resolved URL replaces the 1x1 placeholder gif', () => {
  // The reason the second snapshot exists at all: at t=0 a lazy-loaded hero is a
  // transparent pixel, and shipping that ships a blank page.
  const virgin = el('div', {}, el('img', { class: 'hero', src: GIF, alt: 'Hero' }));
  const driven = el('div', {}, el('img', { class: 'hero', src: '/uploads/hero.jpg', alt: 'Hero' }));

  const { tree, merged } = mergeResources(virgin, driven);

  assert.equal(tree.c[0].a.src, '/uploads/hero.jpg');
  assert.equal(merged.length, 1);
  assert.deepEqual(
    { path: merged[0].path, attr: merged[0].attr, via: merged[0].via },
    { path: 'b.0', attr: 'src', via: 'driven' }
  );
});

test('a real virgin URL is never overwritten by a different driven URL', () => {
  // Carousels advance under scroll and rotate their own <img src>. The driven snapshot is
  // evidence about what resolved, never about what the page should show.
  const virgin = el('div', {}, el('img', { class: 'slide', src: '/slide-1.jpg' }));
  const driven = el('div', {}, el('img', { class: 'slide', src: '/slide-4.jpg' }));

  const { tree, merged } = mergeResources(virgin, driven);

  assert.equal(tree.c[0].a.src, '/slide-1.jpg', 'the driven snapshot won a fight it should lose');
  assert.equal(merged.length, 0);
});

test('data-src self-promotes even when the driven side never resolved', () => {
  // Below-the-fold images on a slow loader are still placeholders after the scroll pass.
  // The real URL was in the markup the whole time.
  const virgin = el('div', {}, el('img', { class: 'card', src: GIF, 'data-src': '/uploads/card.jpg' }));
  const driven = structuredClone(virgin);

  const { tree, merged } = mergeResources(virgin, driven);

  assert.equal(tree.c[0].a.src, '/uploads/card.jpg');
  assert.equal(merged[0].via, 'data-src');
  assert.equal(tree.c[0].a['data-src'], '/uploads/card.jpg', 'the source attribute must survive for the loader');
});

test('self-promotion still runs with no driven snapshot at all', () => {
  // A failed second pass degrades to this rather than to nothing, and says so.
  const virgin = el('div', {}, el('img', { src: GIF, 'data-lazy-src': '/uploads/x.jpg' }));

  const { tree, merged, unmerged } = mergeResources(virgin, null);

  assert.equal(tree.c[0].a.src, '/uploads/x.jpg');
  assert.equal(merged.length, 1);
  assert.deepEqual(unmerged, [{ path: 'b', reason: 'no-driven-snapshot' }]);
});

test('nodes injected mid-list do not desync the alignment', () => {
  // Index-for-index alignment breaks the moment a script appends anything: every sibling
  // after the injection pairs with its neighbour and one card's image lands on the next
  // card. Distinct classes per thumbnail make a mis-alignment visible instead of harmless.
  const virgin = el('div', { class: 'grid' },
    ...Array.from({ length: 5 }, (_, i) => el('img', { class: `thumb-${i}`, src: GIF }))
  );
  const driven = el('div', { class: 'grid' },
    el('img', { class: 'thumb-0', src: '/real-0.jpg' }),
    el('img', { class: 'thumb-1', src: '/real-1.jpg' }),
    el('div', { class: 'injected' }),
    el('div', { class: 'injected' }),
    el('div', { class: 'injected' }),
    el('img', { class: 'thumb-2', src: '/real-2.jpg' }),
    el('img', { class: 'thumb-3', src: '/real-3.jpg' }),
    el('img', { class: 'thumb-4', src: '/real-4.jpg' })
  );
  const shape = skeleton(virgin);

  const { tree, merged, unmerged } = mergeResources(virgin, driven);

  for (let i = 0; i < 5; i++) {
    assert.equal(tree.c[i].a.src, `/real-${i}.jpg`, `thumb-${i} took the wrong URL`);
  }
  assert.equal(merged.length, 5);
  assert.equal(unmerged.filter((u) => u.reason === 'injected-by-scroll').length, 3);
  assert.equal(count(tree), 6, 'the merge adopted an injected node');
  assert.equal(skeleton(tree), shape, 'the merge reordered the virgin tree');
});

test('a node the scroll removed is reported and left alone', () => {
  const virgin = el('div', {},
    el('p', { class: 'a' }),
    el('div', { class: 'cookie-bar' }),
    el('p', { class: 'b' })
  );
  const driven = el('div', {}, el('p', { class: 'a' }), el('p', { class: 'b' }));

  const { tree, unmerged } = mergeResources(virgin, driven);

  assert.equal(count(tree), 4, 'a node dismissed during the scroll was dropped from the shipped tree');
  const gone = unmerged.find((u) => u.reason === 'removed-by-scroll');
  assert.deepEqual({ path: gone.path, tag: gone.tag }, { path: 'b.1', tag: 'div' });
});

test('classes the animation libraries add do not break alignment', () => {
  // AOS stamps aos-init/aos-animate during the scroll. If those counted toward the
  // signature, every revealed section on the page would read as a different node and the
  // whole subtree below it would fail to merge.
  const virgin = el('body', {},
    el('div', { class: 'hero', 'data-aos': 'fade-up' }, el('img', { class: 'shot', src: GIF }))
  );
  const driven = el('body', {},
    el('div', { class: 'hero aos-init aos-animate', 'data-aos': 'fade-up' },
      el('img', { class: 'shot', src: '/uploads/shot.jpg' }))
  );

  const { tree, merged, unmerged } = mergeResources(virgin, driven);

  assert.equal(tree.c[0].c[0].a.src, '/uploads/shot.jpg');
  assert.equal(merged[0].path, 'b.0.0');
  assert.equal(unmerged.length, 0);
  assert.equal(tree.c[0].a.class, 'hero', 'the animated class leaked into the shipped tree');
});

test('a Cloudflare srcset merges as one opaque string', () => {
  // Cloudflare Image Resizing puts its options in the PATH, so a srcset carries commas
  // that are not separators. This codebase has already shipped that bug once: splitting
  // here shreds every URL and every download 404s. It is copied, never parsed.
  const srcset =
    '/cdn-cgi/image/f=auto,w=632/https://cdn.example.com/hero.jpg 632w, ' +
    '/cdn-cgi/image/f=auto,w=1264/https://cdn.example.com/hero.jpg 1264w';
  const virgin = el('div', {}, el('img', { class: 'hero', src: GIF }));
  const driven = el('div', {}, el('img', { class: 'hero', src: '/hero.jpg', srcset, sizes: '(max-width: 632px) 100vw, 632px' }));

  const { tree } = mergeResources(virgin, driven);

  assert.equal(tree.c[0].a.srcset, srcset);
  assert.equal(tree.c[0].a.sizes, '(max-width: 632px) 100vw, 632px');
});

test('two roots that do not correspond are refused outright', () => {
  // The guard on the pair the caller supplies. Below the root, alignment only ever hands
  // the walk pairs whose signatures already match, so this is where it can fire.
  const virgin = el('main', { class: 'page' }, el('img', { src: GIF }));
  const driven = el('div', { class: 'page' }, el('img', { src: '/real.jpg' }));

  const { tree, merged, unmerged } = mergeResources(virgin, driven);

  assert.equal(merged.length, 0);
  assert.deepEqual(unmerged, [{ path: 'b', tag: 'main', reason: 'signature' }]);
  assert.equal(tree.c[0].a.src, GIF, 'merged across a pair it could not verify');
});

test('a child whose tag changed under scroll is never descended into', () => {
  // Same slot, different element. Merging across it would take an image from a node that
  // is not the same node, so it is reported from both sides and the virgin copy stands.
  const virgin = el('div', {}, el('section', { class: 'promo' }, el('img', { src: GIF })));
  const driven = el('div', {}, el('aside', { class: 'promo' }, el('img', { src: '/real.jpg' })));

  const { tree, merged, unmerged } = mergeResources(virgin, driven);

  assert.equal(merged.length, 0);
  assert.equal(tree.c[0].c[0].a.src, GIF);
  assert.deepEqual(unmerged.map((u) => u.reason).sort(), ['injected-by-scroll', 'removed-by-scroll']);
});

test('an absurdly wide node is skipped rather than diffed', () => {
  // The LCS table is O(n*m). A node this wide is a feed, where a structural diff means
  // nothing anyway — bail loudly instead of burning 250k cells on it.
  const wide = (n, cls) => el('ul', {}, ...Array.from({ length: n }, () => el('li', { class: cls })));

  const { unmerged } = mergeResources(wide(401, 'a'), wide(402, 'b'));

  assert.equal(unmerged.length, 1);
  assert.equal(unmerged[0].reason, 'too-wide');
});

test('isPlaceholder tells a spacer SVG from a real one', () => {
  // WordPress lazy loaders emit an empty <svg> carrying only a viewBox, purely to hold
  // the aspect ratio. It is the right size and draws nothing, so nothing shallower than
  // "does it contain a drawing command" can tell it from an inline icon.
  const spacer = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 800'></svg>")}`;
  const icon = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg'><path d='M0 0h24v24H0z'/></svg>")}`;

  assert.equal(isPlaceholder(spacer), true);
  assert.equal(isPlaceholder(icon), false);
  assert.equal(isPlaceholder(GIF), true);
  assert.equal(isPlaceholder(''), true);
  assert.equal(isPlaceholder(undefined), true);
  assert.equal(isPlaceholder('/wp-content/themes/x/img/lazy.png'), true);
  assert.equal(isPlaceholder('/wp-content/uploads/2026/03/hero.jpg'), false);
  // A blur-up thumbnail is a real image, just not the one the page means to show.
  assert.equal(isPlaceholder(`data:image/jpeg;base64,${'A'.repeat(60)}`), true);
  assert.equal(isPlaceholder(`data:image/jpeg;base64,${'A'.repeat(4000)}`), false);
});
