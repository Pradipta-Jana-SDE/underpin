import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { hoistContent, componentizePage } from '../src/generate/componentize.js';
import {
  emitJsx,
  emitSectionModule,
  parseEmittedJsx,
  checkParity,
  normalizeAttrs
} from '../src/generate/jsx-emit.js';

const el = (t, a = {}, ...c) => ({ t, a, c });

/** Builds the shape componentizePage() hands to emitSectionModule, using its own hoister. */
const partOf = (tree, name = 'Section01Hero', id = 'sec_01') => {
  const content = hoistContent(tree, id);
  return {
    id,
    order: 1,
    name,
    kind: 'single',
    tree,
    content,
    counts: { text: Object.keys(content.text).length, media: Object.keys(content.media).length }
  };
};

/** The comparison the parity gate makes, exposed so a test can assert on the tree itself. */
const normalize = (node) =>
  typeof node === 'string'
    ? node
    : { t: node.t, a: normalizeAttrs(node.a), c: (node.c ?? []).map(normalize) };

/* ------------------------------------------------------------------ attributes */

test('RENAME from DomTree is applied, so React sees the props it expects', () => {
  // Imported from the renderer rather than retyped. If this drifts, the generated JSX and
  // the runtime walker disagree about the same page and neither one errors.
  const jsx = emitJsx(el('label', { class: 'field', for: 'email', tabindex: '-1' }));
  assert.match(jsx, /className="field"/);
  assert.match(jsx, /htmlFor="email"/);
  assert.match(jsx, /tabIndex="-1"/);
  assert.doesNotMatch(jsx, /\bclass=|\bfor=|\btabindex=/);

  assert.match(emitJsx(el('img', { srcset: '/a.png 1x, /b.png 2x' })), /srcSet="/);
});

test('style becomes an object literal with order and custom properties intact', () => {
  const jsx = emitJsx(el('div', { style: 'color:red;--brand:#f00;margin-top:0' }));
  // Exact string, not a loose match: a custom property must keep its name and therefore
  // needs a quoted key, everything else camelCases, and declaration order is preserved
  // because duplicate CSS declarations are order-sensitive.
  assert.match(jsx, /style=\{\{ color: "red", "--brand": "#f00", marginTop: "0" \}\}/);
});

test('an empty or unparseable style omits the prop entirely', () => {
  // styleToObject returns {} for both, and React renders no style attribute either way.
  // Emitting `style={{}}` would just be noise in a file a developer opens.
  assert.doesNotMatch(emitJsx(el('div', { style: '' })), /style/);
  assert.doesNotMatch(emitJsx(el('div', { style: ';;;' })), /style/);
  assert.doesNotMatch(emitJsx(el('div', { style: 'not-a-declaration' })), /style/);
});

test('all three boolean attribute forms follow DomTree.jsx:60 exactly', () => {
  const jsx = emitJsx(
    el('div', {},
      el('input', { disabled: '' }),
      el('input', { disabled: 'false' }),
      el('div', { hidden: 'hidden' })
    )
  );
  assert.match(jsx, /disabled=\{true\}/);
  assert.match(jsx, /disabled=\{false\}/);
  assert.match(jsx, /hidden=\{true\}/);
});

test('booleans are recognised after the rename, not before', () => {
  // `readonly` is not in BOOLEAN; `readOnly` is. Checking before the rename silently emits
  // readOnly="" — falsy in React, so the field is editable and nothing reports it.
  assert.match(emitJsx(el('input', { readonly: 'readonly' })), /readOnly=\{true\}/);
  assert.match(emitJsx(el('form', { novalidate: '' })), /noValidate=\{true\}/);
});

test('data-* and aria-* pass through verbatim', () => {
  const jsx = emitJsx(el('div', { 'data-element_type': 'container', 'aria-label': 'Menu' }));
  assert.match(jsx, /data-element_type="container"/);
  assert.match(jsx, /aria-label="Menu"/);
});

test('SVG attributes: hyphenated presentation names camelCase, already-camelCase names do not', () => {
  const jsx = emitJsx(
    el('svg', { viewBox: '0 0 24 24', preserveAspectRatio: 'xMidYMid meet' },
      el('path', { 'stroke-width': '2', 'stroke-linecap': 'round', 'fill-rule': 'evenodd' })
    )
  );
  assert.match(jsx, /viewBox="0 0 24 24"/, 'the HTML parser already restored viewBox');
  assert.match(jsx, /preserveAspectRatio="xMidYMid meet"/);
  assert.match(jsx, /strokeWidth="2"/);
  assert.match(jsx, /strokeLinecap="round"/);
  assert.match(jsx, /fillRule="evenodd"/);
});

test('namespaced attributes are renamed — a colon in a prop name is a build failure', () => {
  // The trap. WordPress themes ship sprite sheets full of xlink:href, and one of them is
  // enough to stop the whole generated file from compiling.
  const jsx = emitJsx(
    el('svg', { 'xmlns:xlink': 'http://www.w3.org/1999/xlink' },
      el('use', { 'xlink:href': '#icon-cart', 'xml:lang': 'en' })
    )
  );
  assert.match(jsx, /xmlnsXlink="http:\/\/www\.w3\.org\/1999\/xlink"/);
  assert.match(jsx, /xlinkHref="#icon-cart"/);
  assert.match(jsx, /xmlLang="en"/);
  assert.doesNotMatch(jsx, /:href|:lang|xmlns:/, 'no colon may survive into a prop name');
});

test('Alpine-style attributes collapse into one trailing spread with values intact', () => {
  const jsx = emitJsx(
    el('div', { class: 'menu', '@click': 'open = !open', 'x-on:click': 'go()', ':class': "{ 'is-open': open }" })
  );
  const spreads = jsx.match(/\{\.\.\./g) ?? [];
  assert.equal(spreads.length, 1, 'all unsafe names share one spread, not one each');
  assert.match(jsx, /className="menu"/, 'safe props stay bare and readable');
  assert.match(jsx, /"@click": "open = !open"/);
  assert.match(jsx, /"x-on:click": "go\(\)"/);
  assert.match(jsx, /":class": "\{ 'is-open': open \}"/);

  // React forwards unknown lowercase props to the DOM, so the attribute really survives.
  const back = parseEmittedJsx(jsx);
  assert.equal(back.a['@click'], 'open = !open');
  assert.equal(back.a['x-on:click'], 'go()');
  assert.equal(back.a[':class'], "{ 'is-open': open }");
});

test('inline handlers are dropped and counted, never emitted', () => {
  // Same policy as DomTree.jsx:60 — React cannot take a string handler, and an onclick
  // written for WordPress has no target here. Counted because a silently dropped behaviour
  // is the one the client finds.
  const part = partOf(el('section', {}, el('button', { onclick: 'jQuery(this).toggle()' }, 'Menu')));
  const { jsx, warnings } = emitSectionModule(part, { key: 'index' });

  assert.equal(warnings.droppedHandlers, 1);
  assert.deepEqual(warnings.handlers, [{ path: 'sec_01.0', tag: 'button', attr: 'onclick' }]);
  assert.doesNotMatch(jsx, /onclick=|onClick=/);
  // Reported in the file docblock. JSX children have no line-comment syntax — `// note` in
  // that position is a text node — and a {/* */} comment is barred by the no-comments rule.
  assert.match(jsx, /1 inline handler from the source page was dropped/);
  assert.match(jsx, /sec_01\.0 {2}<button onclick>/);
});

test('an attribute value holding both quote characters still parses', () => {
  const tree = el('div', { title: 'She said "no" — it\'s fine' });
  const jsx = emitJsx(tree);
  // A double quote ends a JSX string attribute, so this has to become an expression.
  assert.match(jsx, /title=\{"/);
  assert.equal(parseEmittedJsx(jsx).a.title, 'She said "no" — it\'s fine');
});

test('an attribute value holding & escapes, because JSX decodes entities in quoted values', () => {
  // href="?a=1&amp;b=2" would arrive at the browser as ?a=1&b=2 — a different URL.
  const tree = el('a', { href: '/search?a=1&amp;b=2' });
  const jsx = emitJsx(tree);
  assert.match(jsx, /href=\{"/);
  assert.equal(parseEmittedJsx(jsx).a.href, '/search?a=1&amp;b=2');
});

/* ------------------------------------------------------------------- elements */

test('void tags always self-close and never take children', () => {
  assert.match(emitJsx(el('img', { src: '/a.png' })), /^<img src="\/a\.png" \/>$/);
  assert.match(emitJsx(el('br', {})), /^<br \/>$/);
  // DomTree.jsx:88 passes no children to createElement for a void tag either.
  assert.match(emitJsx(el('input', { type: 'text' }, 'stray')), /^<input type="text" \/>$/);
});

test('a non-void element with no children self-closes', () => {
  assert.equal(emitJsx(el('div', { class: 'spacer' })), '<div className="spacer" />');
  assert.equal(emitJsx({ t: 'div', a: {} }), '<div />');
});

test('underpin-fragment becomes <>…</> and never reaches the DOM', () => {
  // The synthetic wrapper componentize.js puts around a run of siblings. Emitting it as a
  // real element would add a node the source never had and shift every :nth-child after it.
  const jsx = emitJsx({ t: 'underpin-fragment', a: {}, c: [el('li', {}, 'a'), el('li', {}, 'b')] });
  assert.match(jsx, /^<>\n/);
  assert.match(jsx, /\n<\/>$/);
  assert.doesNotMatch(jsx, /underpin-fragment/);
  assert.equal(parseEmittedJsx(jsx).c.length, 2);
});

test('hyphenated custom element tags pass through lowercase', () => {
  const jsx = emitJsx(el('lite-youtube', { videoid: 'abc' }));
  assert.match(jsx, /^<lite-youtube videoid="abc" \/>$/);
});

test('a long attribute list wraps one per line and still parses', () => {
  // Elementor class lists run past 300 characters. A single line is unreadable, which
  // defeats the entire point of emitting source instead of JSON.
  const tree = el('div', {
    class: 'elementor-element elementor-element-4a2f1c e-con-full e-flex e-con e-child',
    'data-id': '4a2f1c',
    'data-element_type': 'container',
    'data-settings': '{"background_background":"classic"}'
  });
  const jsx = emitJsx(tree);
  assert.ok(jsx.split('\n').length > 4, 'attributes were not wrapped');
  assert.match(jsx, /\n\/>$/, 'a wrapped self-close closes at the element indent');
  assert.deepEqual(normalize(parseEmittedJsx(jsx)), normalize(tree));
});

/* ----------------------------------------------------------------------- text */

test('text emission picks the readable form only when it is safe', () => {
  const jsx = emitJsx(
    el('div', {},
      el('span', {}, 'Plain words'),
      el('span', {}, ' '),
      el('span', {}, 'a { b'),
      el('span', {}, 'a < b'),
      el('span', {}, 'Tom & Jerry'),
      el('span', {}, 'two\nlines'),
      el('span', {}, '  padded')
    )
  );
  assert.match(jsx, /<span>Plain words<\/span>/, 'the common case reads as hand-written');
  // Capture collapses a whitespace-only node to one space; JSX deletes a whitespace-only
  // line outright, so this one has to be an expression to survive at all.
  assert.match(jsx, /<span>\{' '\}<\/span>/);
  assert.match(jsx, /<span>\{"a \{ b"\}<\/span>/);
  assert.match(jsx, /<span>\{"a < b"\}<\/span>/);
  // & is an entity start in JSX text: raw `Tom & Jerry` is at best ambiguous and `&nbsp;`
  // would silently become U+00A0.
  assert.match(jsx, /<span>\{"Tom & Jerry"\}<\/span>/);
  assert.match(jsx, /<span>\{"two\\nlines"\}<\/span>/);
  assert.match(jsx, /<span>\{" {2}padded"\}<\/span>/, 'JSX would have eaten the leading spaces');
});

test('two adjacent raw text siblings do not merge into one child', () => {
  // JSX joins raw text on consecutive lines with a single space, which would turn two
  // children into one. The emitter forces the second into expression form.
  const tree = el('p', {}, 'first', 'second');
  const jsx = emitJsx(tree);
  const back = parseEmittedJsx(jsx);
  assert.deepEqual(back.c, ['first', 'second']);
});

test('text around an element keeps its exact spacing', () => {
  const tree = el('p', {}, 'Read ', el('a', { href: '/x' }, 'the docs'), ' today');
  assert.deepEqual(normalize(parseEmittedJsx(emitJsx(tree))), normalize(tree));
});

test('non-ASCII survives in text and in attribute values', () => {
  const tree = el('p', { 'data-flag': '日本語 🇯🇵' }, 'Ship it 🚀 — naïve façade');
  const jsx = emitJsx(tree);
  assert.match(jsx, /Ship it 🚀 — naïve façade/, 'emoji need no escaping and reading them matters');
  assert.deepEqual(normalize(parseEmittedJsx(jsx)), normalize(tree));
});

/* -------------------------------------------------------------------- hoisting */

test('hoisted text and media become content bindings with semantic names', () => {
  const tree = el('section', { class: 'hero' },
    el('h1', {}, 'Build faster'),
    el('p', {}, 'A short lede.'),
    el('img', { src: '/media/hero.png', alt: 'Hero', srcset: '/media/hero.png 1x' }),
    el('a', { href: '/start/' }, 'Get started')
  );
  const { jsx, identifiers, bindings } = emitSectionModule(partOf(tree), { key: 'index' });

  assert.match(jsx, /<h1>\{content\.heading\}<\/h1>/);
  assert.match(jsx, /<p>\{content\.body\}<\/p>/);
  assert.match(jsx, /src=\{content\.imageSrc\}/);
  assert.match(jsx, /alt=\{content\.imageAlt\}/);
  assert.match(jsx, /srcSet=\{content\.imageSrcSet\}/, 'the binding is still renamed for React');
  assert.match(jsx, /href=\{content\.linkHref\}/);
  assert.match(jsx, /<a href=\{content\.linkHref\}>\{content\.linkLabel\}<\/a>/);

  assert.deepEqual(identifiers, {
    heading: 'Build faster',
    body: 'A short lede.',
    imageSrc: '/media/hero.png',
    imageSrcSet: '/media/hero.png 1x',
    imageAlt: 'Hero',
    linkHref: '/start/',
    linkLabel: 'Get started'
  });
  // Keyed by componentize.js's hoist paths, so the two halves cannot disagree.
  assert.equal(bindings.get('sec_01.0.0'), 'heading');
  assert.equal(bindings.get('sec_01.2@src'), 'imageSrc');
  assert.equal(bindings.get('sec_01.3@href'), 'linkHref');
  // class and style are structure and must never become editable content.
  assert.doesNotMatch(jsx, /content\.\w*[Cc]lass/);
  assert.match(jsx, /className="hero"/);
});

test('identifier collisions get numeric suffixes in document order', () => {
  const tree = el('section', {},
    el('h2', {}, 'One'),
    el('div', {}, el('h2', {}, 'Two')),
    el('h2', {}, 'Three')
  );
  const first = emitSectionModule(partOf(tree), { key: 'index' });
  assert.deepEqual(first.identifiers, { subheading: 'One', subheading2: 'Two', subheading3: 'Three' });
  // Determinism is what makes a migration diffable: the same capture must produce the same
  // key names on every run, or every re-run looks like a rewrite.
  const second = emitSectionModule(partOf(tree), { key: 'index' });
  assert.deepEqual(second.identifiers, first.identifiers);
  assert.equal(second.jsx, first.jsx);
});

test('every generated identifier is a valid JS identifier', () => {
  const tree = el('section', {},
    el('h1', {}, 'A'), el('h1', {}, 'B'),
    el('td', {}, 'cell'),
    el('img', { src: '/a.png' }), el('img', { src: '/b.png' })
  );
  const { identifiers } = emitSectionModule(partOf(tree), { key: 'index' });
  for (const key of Object.keys(identifiers)) assert.match(key, /^[A-Za-z_$][A-Za-z0-9_$]*$/);
  assert.ok('text' in identifiers, 'an unlisted tag falls back rather than emitting a path dump');
});

/* -------------------------------------------------------------- module shape */

test('the emitted module pair is complete, importable and server-renderable', () => {
  const tree = el('section', { class: 'hero' }, el('h1', {}, 'Build faster'));
  const { jsx, content } = emitSectionModule(partOf(tree, 'Section01Hero'), { key: 'index' });

  assert.match(jsx, /^import content from '\.\/Section01Hero\.content\.js';/);
  assert.match(jsx, /export default function Section01Hero\(\) \{/);
  assert.match(jsx, /return \(\n/);
  // These sections are markup with no hooks, no state and no handlers, so they are valid
  // Server Components. A client directive would ship JavaScript for nothing; the source
  // site's interactivity is replayed by SiteScripts on the route. Matched as a directive —
  // it is only one if it is the first statement in the file.
  assert.doesNotMatch(jsx, /^\s*['"]use client['"]/);

  assert.match(content, /const content = \{/);
  assert.match(content, /export default content;\n$/);
  assert.match(content, /safe to edit/);
  assert.match(content, /Renaming a key means renaming it in the JSX too/);
});

test('a section with nothing to hoist does not import an empty content module', () => {
  const { jsx, content } = emitSectionModule(partOf(el('div', { class: 'spacer' })), { key: 'index' });
  assert.doesNotMatch(jsx, /^import/m, 'an unused import is a lint error in the delivered project');
  assert.match(content, /const content = \{\};/);
});

test('chrome sections say so, because an edit there is site-wide', () => {
  const part = partOf(el('header', { class: 'site-header' }, el('a', { href: '/' }, 'Home')), 'SiteHeader');
  assert.match(emitSectionModule(part, { key: 'index', chrome: true }).jsx, /renders on every page/);
  assert.doesNotMatch(emitSectionModule(part, { key: 'index' }).jsx, /renders on every page/);
});

/* ------------------------------------------------------------------- parity */

const FIXTURES = {
  'renamed attributes': el('label', { class: 'f', for: 'e', tabindex: '-1' }, 'Email'),
  'style with a custom property': el('div', { style: 'color:red;--brand:#f00;margin-top:0' }, 'x'),
  'duplicate style declarations': el('div', { style: 'color:red;color:blue' }, 'x'),
  'empty style': el('div', { style: '' }, 'x'),
  'boolean attributes': el('form', { novalidate: '' },
    el('input', { disabled: '' }), el('input', { disabled: 'false' }), el('div', { hidden: 'hidden' })),
  'svg with namespaces': el('svg', { viewBox: '0 0 24 24', 'xmlns:xlink': 'http://www.w3.org/1999/xlink' },
    el('use', { 'xlink:href': '#i' }), el('path', { 'stroke-width': '2', 'fill-rule': 'evenodd' })),
  'alpine attributes': el('div', { '@click': 'open = !open', 'x-on:click': 'go()', ':class': "{ a: 1 }" }, 'Menu'),
  'dropped handler': el('button', { onclick: 'go()' }, 'Go'),
  'void and empty elements': el('div', {}, el('img', { src: '/a.png' }), el('br', {}), el('div', {})),
  'fragment': { t: 'underpin-fragment', a: {}, c: [el('li', {}, 'a'), el('li', {}, 'b')] },
  'awkward text': el('p', {}, 'a { b', ' ', 'Tom & Jerry', 'two\nlines', '  padded', ''),
  'text around elements': el('p', {}, 'Read ', el('a', { href: '/x' }, 'the docs'), ' today'),
  'quote-heavy attribute': el('div', { title: 'She said "no" — it\'s fine', 'data-json': '{"a":1}' }, 'x'),
  'non-ascii': el('p', { 'data-flag': '日本語 🇯🇵' }, 'Ship it 🚀 — naïve façade'),
  'custom element': el('lite-youtube', { videoid: 'abc' }),
  'deeply nested': el('div', {}, el('div', {}, el('div', {}, el('span', {}, 'deep'))))
};

test('every fixture round-trips through emit and re-parse', () => {
  // The load-bearing test of the module. Emitting JSX is only safe if the source parses
  // back into the tree it came from — otherwise the generated component renders a page
  // that is subtly not the captured one, and nothing anywhere reports it.
  for (const [label, tree] of Object.entries(FIXTURES)) {
    const jsx = emitJsx(tree);
    const result = checkParity(tree, jsx);
    assert.equal(result.ok, true, `${label}: ${result.reason ?? ''} at ${result.at ?? ''}`);
    // Parity normalises both sides — the question is whether React gets the same props,
    // not whether the strings match. Assert on the normalised trees so the comparison is
    // visible here rather than only inside checkParity.
    assert.deepEqual(normalize(parseEmittedJsx(jsx)), normalize(tree), label);
  }
});

test('every fixture round-trips as a full generated module, bindings and all', () => {
  for (const [label, tree] of Object.entries(FIXTURES)) {
    const part = partOf(tree);
    const mod = emitSectionModule(part, { key: 'index' });
    const result = checkParity(part.tree, mod.jsx, mod.identifiers, { path: part.id });
    assert.equal(result.ok, true, `${label}: ${result.reason ?? ''} at ${result.at ?? ''}`);
  }
});

test('checkParity reports a real difference instead of passing it', () => {
  const tree = el('section', {}, el('h2', {}, 'Real'), el('p', {}, 'Body'));
  const jsx = emitJsx(tree).replace('Real', 'Wrong');
  const result = checkParity(tree, jsx);
  assert.equal(result.ok, false);
  assert.equal(result.at, 's.0.0');
  assert.equal(result.expected, 'Real');
  assert.equal(result.actual, 'Wrong');
});

test('checkParity reports a changed attribute with the path that carries it', () => {
  const tree = el('div', { class: 'a' }, el('img', { src: '/a.png', alt: 'A' }));
  const jsx = emitJsx(tree).replace('/a.png', '/b.png');
  const result = checkParity(tree, jsx);
  assert.equal(result.ok, false);
  assert.equal(result.at, 's.0@src');
  assert.match(result.reason, /attribute src differs/);
});

test('corrupted source fails parity rather than throwing', () => {
  // A parse failure IS a parity failure: the generated file would not have compiled. A gate
  // that throws is a gate every caller wraps in its own try/catch and then swallows.
  const tree = el('section', { class: 'hero' }, el('h2', {}, 'Title'), el('p', {}, 'Body'));
  const jsx = emitJsx(tree);

  for (const [label, broken] of [
    ['dropped closing tag', jsx.replace('</p>', '')],
    ['mangled quote', jsx.replace('className="hero"', 'className="hero')],
    ['unknown expression', jsx.replace('<h2>Title</h2>', '<h2>{someVar}</h2>')],
    ['unresolved binding', jsx.replace('<h2>Title</h2>', '<h2>{content.missing}</h2>')],
    ['not JSX at all', 'export default function X() { return null; }']
  ]) {
    let result;
    assert.doesNotThrow(() => { result = checkParity(tree, broken); }, label);
    assert.equal(result.ok, false, label);
    assert.equal(typeof result.at, 'string', `${label}: no path reported`);
    assert.match(result.reason, /\S/, `${label}: no reason reported`);
  }
});

test('parseEmittedJsx throws on grammar it does not emit', () => {
  assert.throws(() => parseEmittedJsx('<div class></div>'), /has no value/);
  assert.throws(() => parseEmittedJsx('<div>{1 + 1}</div>'), /string literal or a content binding/);
  assert.throws(() => parseEmittedJsx('<div><span></div>'), /expected <\/span>/);
  assert.throws(() => parseEmittedJsx('{"orphan"}'), /start with </);
});

/* -------------------------------------------------------- a realistic section */

test('a realistic section round-trips: nav, svg sprite, srcset image and a form', () => {
  const tree = el('section', { class: 'promo', style: 'padding-top:40px;--gap:1rem' },
    el('nav', { class: 'nav', 'aria-label': 'Primary' },
      el('ul', { class: 'menu' },
        el('li', { class: 'item' }, el('a', { href: '/pricing/', 'data-track': 'nav' }, 'Pricing')),
        el('li', { class: 'item' }, el('a', { href: '/docs/' }, 'Docs')),
        el('li', { class: 'item' },
          el('a', { href: '/cart/', 'aria-label': 'Cart' },
            el('svg', { viewBox: '0 0 24 24', 'xmlns:xlink': 'http://www.w3.org/1999/xlink', class: 'icon' },
              el('use', { 'xlink:href': '#icon-cart' }),
              el('path', { d: 'M1 1 L23 23', 'stroke-width': '2', 'stroke-linecap': 'round' })
            ),
            ' ',
            'Cart'
          ))
      )
    ),
    el('h2', {}, 'Everything you need'),
    el('p', { class: 'lede' }, 'Start free, ', el('strong', {}, 'no card'), ' required.'),
    el('img', {
      src: '/media/shot.png',
      srcset: '/cdn-cgi/image/f=auto,w=632/media/shot.png 632w, /media/shot.png 1264w',
      alt: 'Product screenshot',
      loading: 'lazy'
    }),
    el('form', { class: 'signup', action: '/subscribe', method: 'post', novalidate: '' },
      el('label', { for: 'email' }, 'Email'),
      el('input', { type: 'email', id: 'email', name: 'email', required: '', placeholder: 'you@example.com' }),
      el('input', { type: 'checkbox', name: 'tos', checked: '', disabled: 'false' }),
      el('button', { type: 'submit', class: 'btn' }, 'Subscribe')
    )
  );

  const part = partOf(tree, 'Section01Promo');
  const mod = emitSectionModule(part, { key: 'index' });

  const result = checkParity(part.tree, mod.jsx, mod.identifiers, { path: part.id });
  assert.equal(result.ok, true, `${result.reason ?? ''} at ${result.at ?? ''}`);

  // The srcset came through parseSrcset-shaped, with a Cloudflare path that contains commas
  // — the exact value that a naive split(',') shredded elsewhere in this pipeline.
  assert.match(mod.identifiers.imageSrcSet, /f=auto,w=632/);
  assert.doesNotMatch(mod.jsx, /:href|xmlns:/);
  assert.doesNotMatch(mod.jsx, /^\s*['"]use client['"]/);
  assert.equal(mod.warnings.droppedHandlers, 0);

  // And it reads like a file somebody wrote: two-space nesting, a single-text element on
  // one line. The output is a deliverable a developer opens, not an intermediate format.
  assert.ok(
    mod.jsx.includes(
      '          <li className="item">\n' +
      '            <a href={content.linkHref2}>{content.linkLabel2}</a>\n' +
      '          </li>\n'
    ),
    mod.jsx
  );
});

/* ------------------------------------------------- against real captured data */

/**
 * Every capture on disk, whichever site was last migrated.
 *
 * Deliberately discovered rather than pinned to one host: sites/ is gitignored, so a pinned
 * path is a test that skips forever on every machine but the one that produced it.
 */
const captures = () => {
  const root = new URL('../../../sites/', import.meta.url);
  if (!existsSync(root)) return [];
  const found = [];
  for (const host of readdirSync(root)) {
    const dir = new URL(`${host}/site/content/pages/`, root);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const page = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
      if (page?.tree) found.push({ key: `${host}/${file.replace(/\.json$/, '')}`, page });
    }
  }
  return found;
};

const CAPTURES = captures();

test('every section of every real capture survives emit and re-parse', { skip: !CAPTURES.length }, () => {
  // The fixtures above are the cases we thought of. A real capture is the case we did not:
  // 300-character class lists, inline SVG sprites, data-settings JSON blobs, and whatever a
  // plugin decided to put in an attribute that week.
  let sections = 0;
  for (const { key, page } of CAPTURES) {
    for (const part of componentizePage(page)) {
      sections += 1;
      const mod = emitSectionModule(part, { key });
      const result = checkParity(part.tree, mod.jsx, mod.identifiers, { path: part.id });
      assert.equal(result.ok, true, `${key} ${part.name}: ${result.reason ?? ''} at ${result.at ?? ''}`);
      // The whole hoist map has to be reachable from the JSX, or content silently stops
      // being editable — the one failure mode a parity check cannot see, because the
      // literal left behind in the markup is still the right literal.
      assert.equal(mod.bindings.size, part.counts.text + part.counts.media, `${key} ${part.name}`);
    }
  }
  assert.ok(sections >= 1, 'found captures but no sections');
});

test('a backslash in a plain attribute survives the round trip', () => {
  // Found on elementor.com: the only parity fallback in 1,044 sections was an <input>
  // whose `pattern` held a regex. JSX attribute values are not JS string literals — a
  // backslash in pattern="\d" is a literal backslash, exactly as in HTML — but the
  // re-parser was reading them through the JS string reader and eating it. The emitter was
  // always right; the check was wrong, and it cost a section its generated source.
  const patterns = [
    String.raw`^(https?://)[^./]+(\.[^./]+)+(/.*)?$`,
    String.raw`[a-z]\d{2,4}`,
    String.raw`back\\slash`,
    `[a-zA-Z0-9!@#$%^&*()_+=\\-\\[\\]{}|;:'",.<>/?]*`
  ];
  for (const pattern of patterns) {
    const node = el('input', { type: 'text', pattern });
    const jsx = emitJsx(node, { path: 's' });
    assert.equal(parseEmittedJsx(jsx, { content: {} }).a.pattern, pattern, `lost characters from ${pattern}`);
    assert.equal(checkParity(node, jsx, {}, { path: 's' }).ok, true, `parity failed for ${pattern}`);
  }
});
