import { test } from 'node:test';
import assert from 'node:assert/strict';
import { structuralHash, contentHash, hoistDecision } from '../src/generate/chrome.js';
import { componentizePage, hoistContent } from '../src/generate/componentize.js';

const el = (t, a = {}, ...c) => ({ t, a, c });

/**
 * One entry of componentizePage() output, hand-built.
 *
 * The decision tests are about hoistDecision, so they feed it the shape it consumes rather
 * than the page that produces it — a fixture that goes through splitSections would make a
 * rule-4 failure indistinguishable from a coalescing change. The one test that does need
 * the real producer (single page, below) runs componentizePage for real, which keeps the
 * contract between the two modules under test.
 */
const part = (name, order, tree) => ({ id: `sec_${String(order).padStart(2, '0')}`, order, name, kind: 'single', tree });

const page = (key, path, ...parts) => ({ key, path, parts });

/* ------------------------------------------------------------------ structuralHash */

test('structural hash ignores the words and the images, which are content', () => {
  // Headline copy and a logo file name differ between two exports of the same header all
  // the time. If either moved the hash, no site would ever hoist anything.
  const header = (title, logo) =>
    el('header', { class: 'site-header' },
      el('a', { class: 'brand', href: '/' }, el('img', { src: logo, alt: 'Underpin', class: 'logo' })),
      el('h2', { class: 'tagline' }, title)
    );

  assert.equal(
    structuralHash(header('Migrate without the rewrite', '/media/logo-a.svg')),
    structuralHash(header('Pricing that scales', '/media/logo-b.svg'))
  );
  // ...and the content hash must see exactly what the structural hash ignored.
  assert.notEqual(
    contentHash(header('Migrate without the rewrite', '/media/logo-a.svg')),
    contentHash(header('Pricing that scales', '/media/logo-b.svg'))
  );
});

test('structural hash changes when the active nav link is marked', () => {
  // The whole reason class tokens are hashed. `current-menu-item` is genuinely different
  // markup per page, and a single shared header cannot be both — so it must not hoist.
  const nav = (active) =>
    el('header', { class: 'site-header' },
      el('nav', { class: 'menu' },
        el('a', { class: `menu-item${active === 'home' ? ' current-menu-item' : ''}`, href: '/' }, 'Home'),
        el('a', { class: `menu-item${active === 'pricing' ? ' current-menu-item' : ''}`, href: '/pricing/' }, 'Pricing')
      )
    );

  assert.notEqual(structuralHash(nav('home')), structuralHash(nav('pricing')));
});

test('structural hash ignores per-page element ids in class tokens', () => {
  // Elementor stamps a fresh `elementor-element-<hex>` on every element in every export.
  // Comparing those raw would refuse the hoist on a third of the WordPress fleet.
  const box = (uid) =>
    el('div', { class: `elementor-element elementor-widget ${uid}` }, el('p', { class: 'lede' }, 'text'));

  assert.equal(
    structuralHash(box('elementor-element-7a3f1')),
    structuralHash(box('elementor-element-92bd0'))
  );
});

/* ------------------------------------------------------------------- hoistDecision */

const simpleHeader = () =>
  el('header', { class: 'site-header' },
    el('a', { class: 'brand', href: '/' }, 'Underpin'),
    el('nav', { class: 'menu' }, el('a', { class: 'menu-item', href: '/pricing/' }, 'Pricing'))
  );

const simpleFooter = () => el('footer', { class: 'site-footer' }, el('p', {}, 'All rights reserved'));

test('a header that is not the first section stays per-page', () => {
  // A layout wraps its children. Lifting a section out of the middle of one page and
  // re-emitting it at the top moves it in the DOM, which shifts every :nth-child count
  // after it — the exact failure componentize.js is built around.
  const withBanner = page('pricing', '/pricing/',
    part('Section01CallToAction', 1, el('div', { class: 'promo-bar' }, el('p', {}, 'Sale ends Friday'))),
    part('SiteHeader', 2, simpleHeader()),
    part('Section03Content', 3, el('section', {}, el('p', {}, 'body'))),
    part('SiteFooter', 4, simpleFooter())
  );
  const plain = page('index', '/',
    part('SiteHeader', 1, simpleHeader()),
    part('Section02Content', 2, el('section', {}, el('p', {}, 'body'))),
    part('SiteFooter', 3, simpleFooter())
  );

  const { header, footer } = hoistDecision([plain, withBanner]);

  assert.equal(header.hoist, false);
  assert.match(header.reason, /^per-page: rule 4 /);
  assert.match(header.reason, /\/pricing\//, 'the reason has to name the page that blocked it');

  // Decided independently: the footer is last on both pages and identical, so it still
  // hoists. Collapsing both roles into one verdict would throw away the half that was free.
  assert.equal(footer.hoist, true, 'the footer is unaffected by where the header sits');
  assert.equal(footer.from, 'index');
});

test('one differing word hoists; one differing href does not', () => {
  // 40 hoisted leaves: a brand link (href + label) plus 38 spans of footer-ish copy. One
  // text leaf out of 40 is 2.5%, inside the near-identical allowance — that is a phone
  // number with a stray space, not a per-page header.
  const chrome = ({ brandHref = '/', phone = '0800 123 456' } = {}) =>
    el('header', { class: 'site-header' },
      el('a', { class: 'brand', href: brandHref }, 'Underpin'),
      el('span', { class: 'phone' }, phone),
      ...Array.from({ length: 37 }, (_, i) => el('span', { class: 'meta' }, `office detail ${i}`))
    );

  const leaves = hoistContent(chrome());
  assert.equal(
    Object.keys(leaves.text).length + Object.keys(leaves.media).length,
    40,
    'the fixture has to hold exactly 40 hoist keys for the 5% arithmetic to be the point'
  );

  const nearly = hoistDecision([
    page('index', '/', part('SiteHeader', 1, chrome({ phone: '0800 123 456' }))),
    page('pricing', '/pricing/', part('SiteHeader', 1, chrome({ phone: '0800 123456' })))
  ]);
  assert.equal(nearly.header.hoist, true, 'one word in forty is not a per-page header');
  assert.equal(nearly.header.reason, 'hoisted');
  assert.equal(nearly.header.from, 'index', 'the homepage is the copy that gets kept');

  // Same single-key difference, but the key is a destination. Sharing this header would
  // send every page's logo to whichever URL happened to be captured first — a bug that
  // looks like nothing in review and like everything in production.
  const linked = hoistDecision([
    page('index', '/', part('SiteHeader', 1, chrome({ brandHref: '/' }))),
    page('pricing', '/pricing/', part('SiteHeader', 1, chrome({ brandHref: '/pricing/' })))
  ]);
  assert.equal(linked.header.hoist, false);
  assert.match(linked.header.reason, /^per-page: rule 5 /);
  assert.match(linked.header.reason, /@href/, 'the reason has to name the key that blocked it');
});

test('a build of one page keeps its chrome per-page', () => {
  // Also the contract test between the two modules: rule 1 matches on the exact name
  // `SiteHeader`, which only componentizePage assigns, and only when it judged the section
  // to be chrome. If that naming ever changes, this fails here rather than in a migration.
  const captured = {
    tree: el('body', {},
      el('header', { class: 'site-header' },
        el('a', { href: '/' }, 'Home'),
        el('a', { href: '/pricing/' }, 'Pricing')
      ),
      el('section', { class: 'wp-block-group' },
        ...Array.from({ length: 20 }, (_, i) => el('p', {}, `paragraph number ${i}`))
      ),
      el('footer', { class: 'site-footer' }, el('p', {}, 'All rights reserved'))
    )
  };

  const parts = componentizePage(captured);
  assert.ok(parts.some((p) => p.name === 'SiteHeader'), 'componentizePage no longer names page chrome SiteHeader');
  assert.ok(parts.some((p) => p.name === 'SiteFooter'), 'componentizePage no longer names page chrome SiteFooter');

  const { header, footer } = hoistDecision([{ key: 'index', path: '/', parts }]);

  // Nothing to compare against, so nothing is provably shared. A one-page build keeps its
  // copies rather than promoting an assumption into the layout.
  assert.equal(header.hoist, false);
  assert.match(header.reason, /^per-page: rule 2 /);
  assert.equal(footer.hoist, false);
  assert.match(footer.reason, /^per-page: rule 2 /);
});

test('chrome missing from some pages is never invented in the layout', () => {
  // Hoisting here would render a header on a page that never had one — a worse failure
  // than a duplicated file, because it changes what that page shows.
  const { header } = hoistDecision([
    page('index', '/', part('SiteHeader', 1, simpleHeader())),
    page('pricing', '/pricing/', part('SiteHeader', 1, simpleHeader())),
    page('landing', '/lp/', part('Section01Hero', 1, el('section', {}, el('h1', {}, 'Signup'))))
  ]);

  assert.equal(header.hoist, false);
  assert.match(header.reason, /^per-page: rule 2 /);
  assert.match(header.reason, /\/lp\//);
});
