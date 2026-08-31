import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLibraries, stripAnimationState } from '../src/capture/strip-animation.js';

const el = (t, a = {}, ...c) => ({ t, a, c });
const count = (n) => (!n || typeof n === 'string' ? 0 : 1 + (n.c ?? []).reduce((s, c) => s + count(c), 0));
const decls = (n) => String(n.a?.style ?? '').split(';').filter(Boolean).map((d) => d.trim()).sort();

const ALL = { aos: true, wow: true, gsap: true, elementor: true, animateCss: true };

test('libraries are fingerprinted from the scripts that survived capture', () => {
  const libs = detectLibraries(
    [
      { kind: 'external', src: 'https://x.test/wp-content/plugins/aos/aos.min.js' },
      { kind: 'inline', code: 'AOS.init({ duration: 600 });' },
      { kind: 'external', src: 'https://cdn.test/gsap/ScrollTrigger.min.js' },
      { kind: 'external', src: 'https://x.test/wp-content/plugins/elementor/assets/js/frontend.min.js' }
    ],
    [{ kind: 'link', href: 'https://cdn.test/animate.min.css' }]
  );

  assert.deepEqual(libs, { aos: true, wow: false, gsap: true, elementor: true, animateCss: true });
});

test('a library whose script was dropped is not detected', () => {
  // THE GATE. Capture drops scripts that call WordPress endpoints, use document.write or
  // blow the size cap. AOS's stylesheet surviving proves only that [data-aos] is still
  // opacity:0 — which is exactly why stripping aos-animate without the bundle would leave
  // the content permanently invisible. Detection reads the scripts, never the sheets.
  const libs = detectLibraries([{ kind: 'external', src: '/js/theme.js' }], [
    { kind: 'link', href: '/css/aos.css' }
  ]);

  assert.equal(libs.aos, false);
  assert.equal(libs.gsap, false);
});

test('aos-animate is stripped only when AOS will replay', () => {
  const make = () => el('body', {}, el('div', { class: 'card aos-init aos-animate', 'data-aos': 'fade-up' }));

  const on = make();
  const { stripped } = stripAnimationState(on, { ...ALL });
  assert.equal(on.c[0].a.class, 'card', 'the baked-in end state shipped and the entrance never replays');
  assert.equal(stripped, 1);

  // The other half of the gate, and the more important one: no AOS, no strip. Removing
  // the class here would leave every reveal element at opacity:0 forever.
  const off = make();
  stripAnimationState(off, { ...ALL, aos: false });
  assert.equal(off.c[0].a.class, 'card aos-init aos-animate');
});

test('an element without data-aos is left alone even with AOS present', () => {
  // `active` and `animated` are ordinary class names on plenty of themes. Only the
  // library's own marker attribute makes them the library's to remove.
  const tree = el('body', {}, el('div', { class: 'tab active aos-animate' }));
  stripAnimationState(tree, { ...ALL });
  assert.equal(tree.c[0].a.class, 'tab active aos-animate');
});

test('WOW state is removed declaration by declaration, not by clearing the style', () => {
  const tree = el('body', {}, el('div', {
    class: 'wow animate__animated animate__fadeInUp',
    style: 'visibility:visible;animation-name:fadeInUp;animation-duration:1s;color:red'
  }));

  stripAnimationState(tree, { ...ALL });

  assert.equal(tree.c[0].a.style, 'color:red', 'a real declaration was collateral damage');
  assert.equal(tree.c[0].a.class, 'wow', 'the runtime classes survived');
});

test('elementor-invisible keeps its class and loses only the animation values', () => {
  // The class IS the pre-animation state — the thing Elementor removes when it starts the
  // entrance. Shipping it is the goal, not a leftover.
  const tree = el('body', {}, el('div', {
    class: 'elementor-invisible elementor-widget',
    style: 'animation-duration:1.2s;animation-name:fadeInUp;--e-con-grid-template-columns:repeat(3,1fr)'
  }));

  stripAnimationState(tree, { ...ALL });

  assert.equal(tree.c[0].a.class, 'elementor-invisible elementor-widget');
  assert.equal(tree.c[0].a.style, '--e-con-grid-template-columns:repeat(3,1fr)');
});

test('a semicolon inside a value never splits a declaration', () => {
  // Elementor writes background data-URIs inline. Splitting on every ';' cuts the base64
  // payload in half and destroys the background — the same shape of bug as splitting a
  // srcset on commas.
  const bg = 'background-image:url("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")';
  const tree = el('body', {}, el('div', { class: 'wow', style: `${bg};visibility:visible` }));

  stripAnimationState(tree, { ...ALL });

  assert.equal(tree.c[0].a.style, bg);
});

test('a style attribute that empties out is removed entirely', () => {
  const tree = el('body', {}, el('div', { class: 'wow', style: 'visibility:visible' }));
  stripAnimationState(tree, { ...ALL });
  assert.equal('style' in tree.c[0].a, false);
});

test('inline will-change is always dropped', () => {
  // A compositor hint written for the duration of one tween. Baked in, it pins a layer
  // for the life of the page; nothing needs it to render correctly.
  const tree = el('body', {}, el('div', { style: 'will-change:transform;opacity:1' }));
  stripAnimationState(tree, {});
  assert.equal(tree.c[0].a.style, 'opacity:1');
});

test('a pin-spacer is replaced by its child at the same index', () => {
  // ScrollTrigger wraps a pinned section in a spacer div at runtime. Shipping it means
  // ScrollTrigger builds a second spacer around the first on replay, and the layout
  // doubles its own height.
  const tree = el('body', {},
    el('header', {}, 'top'),
    el('div', { class: 'pin-spacer-hero', style: 'padding:0 0 900px' },
      el('section', { class: 'hero', style: 'transform:translate3d(0,120px,0);position:fixed;background:red' })),
    el('footer', {}, 'bottom')
  );
  const before = count(tree);

  const { unwrapped } = stripAnimationState(tree, { ...ALL });

  assert.equal(unwrapped, 1);
  assert.equal(count(tree), before - 1, 'the spacer was not removed, or took something with it');
  assert.deepEqual(tree.c.map((n) => n.t), ['header', 'section', 'footer'], 'siblings moved');
  assert.equal(tree.c[1].a.class, 'hero');
  // Sole child of the spacer, so its frozen inline layout is provably ScrollTrigger's.
  assert.deepEqual(decls(tree.c[1]), ['background:red']);
});

test('nested pin-spacers unwrap outside-in without losing children', () => {
  const tree = el('body', {},
    el('div', { class: 'pin-spacer' },
      el('div', { class: 'pin-spacer-inner' },
        el('section', { class: 'panel' }, 'real content'))),
    el('footer', {}, 'end')
  );

  const { unwrapped } = stripAnimationState(tree, { ...ALL });

  assert.equal(unwrapped, 2);
  assert.deepEqual(tree.c.map((n) => n.t), ['section', 'footer']);
  assert.deepEqual(tree.c[0].c, ['real content']);
});

test('pinned layout is only stripped from a marked element', () => {
  // A spacer holding several children cannot say which one was pinned, and inline
  // position/width on an unmarked element is just as likely to be the theme's.
  const tree = el('body', {},
    el('div', { class: 'pin-spacer' },
      el('section', { class: 'a', style: 'position:fixed;color:blue' }),
      el('section', { id: 'pin-b', style: 'position:fixed;color:blue' }))
  );

  stripAnimationState(tree, { ...ALL });

  assert.deepEqual(decls(tree.c[0]), ['color:blue', 'position:fixed'], 'stripped an element nothing marked');
  assert.deepEqual(decls(tree.c[1]), ['color:blue']);
});

test('with every library dropped the tree is untouched but for will-change', () => {
  // The safe failure mode: motion is lost, content is not.
  const tree = el('body', {},
    el('div', { class: 'pin-spacer' },
      el('div', { class: 'card wow animated aos-animate', 'data-aos': 'fade', style: 'visibility:visible' }))
  );
  const before = structuredClone(tree);

  const { stripped, unwrapped } = stripAnimationState(tree, {});

  assert.deepEqual(tree, before);
  assert.equal(stripped, 0);
  assert.equal(unwrapped, 0);
});
