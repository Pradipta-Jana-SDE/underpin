import { spliceContent } from '@underpin/templates/splice';

// Re-exported so callers have one import site; the implementation lives in the templates
// package because generated sites import it at runtime too, and two copies would drift.
export { spliceContent };

/**
 * Mechanical decomposition of a captured page into per-section components.
 *
 * Not classification — nothing here decides what a section means. It splits the tree where
 * sections already begin, hoists the editable leaves out and leaves the rest verbatim, so
 * CSS sibling selectors, :nth-child counts and cross-section queries all still resolve.
 *
 * One rule: a split may never add a wrapper, never remove an element that always rendered,
 * and never reorder siblings. Break it and you shift an :nth-child count — invisible in
 * review, obvious to the client.
 */

/** Class fragments marking an element as a component rather than a layout wrapper. */
const COMPONENTISH =
  /swiper|slick|owl|carousel|splide|flickity|slider|accordion|tabs|gallery|testimonial|marquee/i;

/** Section boundaries each builder emits in the rendered DOM. */
const SECTION_MATCHERS = [
  (n) => hasClass(n, 'elementor-top-section') || hasClass(n, 'elementor-section'),
  (n) => n.a?.['data-element_type'] === 'container' && !hasClass(n, 'e-con-inner'),
  (n) => hasClass(n, 'et_pb_section'),
  (n) => hasClass(n, 'vc_row'),
  (n) => hasClass(n, 'fl-row'),
  (n) => hasClass(n, 'brxe-section'),
  (n) => n.t === 'section',
  (n) => hasClass(n, 'wp-block-group') || hasClass(n, 'wp-block-cover')
];

const matchesSection = (n) => isEl(n) && SECTION_MATCHERS.some((m) => m(n));

const cls = (n) => String(n?.a?.class ?? '');
const hasClass = (n, c) => cls(n).split(/\s+/).includes(c);
const isEl = (n) => n && typeof n === 'object' && typeof n.t === 'string';
const textOf = (n) => {
  if (typeof n === 'string') return n;
  if (!isEl(n)) return '';
  return (n.c ?? []).map(textOf).join('');
};

/**
 * Descends through pure layout wrappers. Scripts inject their own at runtime — GSAP
 * ScrollTrigger's `pin-spacer-*` divs litter a real capture and appear in no server HTML —
 * and each wraps exactly one section. Stops at anything component-shaped: descending into
 * a carousel discards the context that identifies it.
 */
export function unwrapTree(node, maxDepth = 8) {
  let cur = node;
  for (let d = 0; d < maxDepth; d++) {
    const kids = (cur?.c ?? []).filter((c) => isEl(c) || (typeof c === 'string' && c.trim()));
    if (kids.length !== 1 || !isEl(kids[0])) break;
    const only = kids[0];

    const outer = textOf(cur).trim().length;
    const inner = textOf(only).trim().length;
    if (inner === 0 || inner < outer * 0.9) break;

    // Descend onto the child, then decide whether to go further. Stopping *before*
    // stepping on would leave a runtime wrapper as the boundary; continuing past a
    // section or a component would discard the very node we are looking for.
    cur = only;
    if (matchesSection(only) || COMPONENTISH.test(cls(only))) break;
  }
  return cur;
}

/** Structural signature used to spot repeated siblings — shape only, never meaning. */
const signature = (n) =>
  isEl(n) ? `${n.t}|${cls(n).split(/\s+/).filter((c) => !/\d/.test(c)).slice(0, 2).join('.')}` : 'text';

/**
 * Splits a captured tree into top-level sections.
 *
 * Builder boundaries first; failing that, the direct children of the unwrapped content
 * root. Runs of structurally identical siblings are merged into one section, because a
 * six-logo strip is one section and not six — the same coalescing lesson template mode
 * already learned the hard way.
 */
export function splitSections(bodyTree) {
  // This must be a PARTITION of the body's children, not a selection of the
  // section-shaped ones. Picking out only the nodes that look like sections silently
  // drops whatever sits between them, and the whole safety argument — that the rendered
  // DOM is unchanged — dies with it. Every child is accounted for, in order.
  const root = unwrapTree(bodyTree);
  const children = (root.c ?? []).filter((c) => isEl(c) || (typeof c === 'string' && c.trim()));

  // Render the children themselves, NOT an unwrapped descendant. Unwrapping picks a
  // deeper node to call "the section", which drops the wrapper element from the output —
  // a direct violation of "never remove an element that always rendered". unwrapTree is
  // for finding boundaries to reason about, never for deciding what to render.
  const nodes = children;

  // Merge runs of structurally similar siblings — a six-logo strip is one section, not
  // six. Signature alone is not enough: Elementor gives every top-level container the
  // same classes, so comparable size is required too.
  const size = (n) => textOf(n).trim().length + countTag(n, 'img') * 40;
  const similar = (a, b) => {
    if (!isEl(a) || !isEl(b) || signature(a) !== signature(b)) return false;
    const [x, y] = [size(a) || 1, size(b) || 1];
    return Math.max(x, y) / Math.min(x, y) <= 3;
  };

  const merged = [];
  let i = 0;
  while (i < nodes.length) {
    let j = i + 1;
    while (j < nodes.length && similar(nodes[j], nodes[i])) j++;
    const run = nodes.slice(i, j);
    if (run.length >= 3) {
      merged.push({ kind: 'run', nodes: run });
      i = j;
    } else {
      merged.push({ kind: 'single', nodes: [nodes[i]] });
      i += 1;
    }
  }

  // Nothing is filtered out. An empty-looking node still occupied a sibling position,
  // and dropping it shifts every :nth-child count after it.
  return merged.map((s, idx) => ({
    id: `sec_${String(idx + 1).padStart(2, '0')}`,
    order: idx + 1,
    kind: s.kind,
    nodes: s.nodes
  }));
}

function countTag(node, tag) {
  if (!isEl(node)) return 0;
  return (node.t === tag ? 1 : 0) + (node.c ?? []).reduce((a, c) => a + countTag(c, tag), 0);
}

/** Attributes whose values are editable content rather than structure. */
const MEDIA_ATTRS = { img: ['src', 'srcset', 'alt'], a: ['href'], video: ['src', 'poster'], source: ['src', 'srcset'] };

/**
 * Hoists the editable leaves of a section out of its tree.
 *
 * The boundary is a lookup, not a judgement: content is leaf text, or src/href/poster/
 * srcset/alt on an element that carries one. Class, id, style, data-*, aria-* and every
 * wrapper stay verbatim. Deciding by which HTML API the value lives in keeps this
 * mechanical — "is this aria-label really content" is where classification creeps back in.
 *
 * Paths reuse DomNode's addressing, so hoisting is reversible.
 */
export function hoistContent(tree, base = 's') {
  const text = {};
  const media = {};

  const walk = (node, path) => {
    if (!isEl(node)) return;

    const attrs = MEDIA_ATTRS[node.t];
    if (attrs) {
      for (const a of attrs) {
        if (node.a?.[a]) media[`${path}@${a}`] = node.a[a];
      }
    }

    (node.c ?? []).forEach((child, i) => {
      const childPath = `${path}.${i}`;
      if (typeof child === 'string') {
        if (child.trim()) text[childPath] = child;
      } else {
        walk(child, childPath);
      }
    });
  };

  walk(tree, base);
  return { text, media };
}

/**
 * Rule-based component naming. Cosmetic — a wrong name is an ugly filename, nothing more,
 * and it is caught in review. Header/footer are named by the caller, which knows the
 * section's size relative to the page; matching on a class here named a 4,516-leaf
 * content wrapper "Footer" purely because a wrapper class contained the word.
 */
export function nameSection(node, order) {
  const n = String(order).padStart(2, '0');
  const text = textOf(node).trim();
  const classes = cls(node).toLowerCase();
  const imgs = countTag(node, 'img');
  const headings = ['h1', 'h2', 'h3'].reduce((a, t) => a + countTag(node, t), 0);

  const guess =
    order === 1 && countTag(node, 'h1') ? 'Hero'
    : countTag(node, 'form') ? 'ContactForm'
    : countTag(node, 'video') ? 'VideoBand'
    : imgs >= 4 && text.length < 220 ? 'LogoWall'
    : /faq|accordion/.test(classes) ? 'Faq'
    : /testimonial|review/.test(classes) ? 'Testimonials'
    : /pricing|price/.test(classes) ? 'Pricing'
    : imgs >= 3 && headings >= 3 ? 'FeatureGrid'
    : imgs === 1 && text.length > 150 ? 'TextMedia'
    : headings >= 1 && text.length < 400 ? 'CallToAction'
    : 'Content';

  return `Section${n}${guess}`;
}

/* ------------------------------------------------------------------ emission */

const isHeader = (n) =>
  n.t === 'header' || /elementor-location-header|site-header|masthead/i.test(cls(n));
const isFooter = (n) =>
  n.t === 'footer' || /elementor-location-footer|site-footer|colophon/i.test(cls(n));

/**
 * Turns a captured page into an ordered set of section components.
 *
 * Each is a thin wrapper around the working renderer fed a smaller subtree, not generated
 * JSX source: re-deriving attribute renaming, boolean props and style parsing as codegen is
 * a second full implementation, and the renderer already measures 99.8% visual on a static
 * page. Small, ordered, editable files come from the composition in page.jsx plus the
 * per-section content JSON.
 */
/**
 * How much of a page one section must hold before it is worth opening up. Block themes wrap
 * the whole site in one `div.wp-site-blocks`, so a body-level split yields a single
 * component holding header, content and footer. Elementor needs none of this — its body
 * children already are the sections — hence the conditional descent.
 */
const DOMINANT_SHARE = 0.6;
const MIN_CHILDREN = 2;

/**
 * Splits a dominant section into a parent that renders its own wrapper and child components
 * inside it. The parent keeps the wrapper — descending past it would delete an element that
 * always rendered. Every child is accounted for in order, whitespace text nodes included,
 * so the browser builds the same DOM as before.
 */
function nestSection(node, id, depth, budget, unique) {
  if (depth >= budget || !isEl(node)) return null;

  const kids = node.c ?? [];
  const elementKids = kids.filter(isEl);
  if (elementKids.length < MIN_CHILDREN) return null;

  const inner = splitSections({ t: node.t, a: node.a, c: kids });
  if (inner.length < MIN_CHILDREN) return null;

  // The children must be a faithful partition of what the wrapper actually held. If the
  // split dropped or reordered anything, composing the parent from these pieces would
  // render a different DOM — so decline to nest rather than nest incorrectly.
  const flat = inner.flatMap((s) => s.nodes);
  const expected = kids.filter((c) => isEl(c) || (typeof c === 'string' && c.trim()));
  if (flat.length !== expected.length || flat.some((n, i) => n !== expected[i])) return null;

  return inner.map((s, i) => {
    const childNode = s.nodes.length === 1 ? s.nodes[0] : { t: 'underpin-fragment', a: {}, c: s.nodes };
    const childId = `${id}_${String(i + 1).padStart(2, '0')}`;
    const nested = s.nodes.length === 1 ? nestSection(s.nodes[0], childId, depth + 1, budget, unique) : null;
    const content = hoistContent(childNode, childId);
    return {
      id: childId,
      order: i + 1,
      name: unique(chromeName(s.nodes[0], inner, i) ?? nameSection(s.nodes[0], i + 1)),
      kind: s.kind,
      itemCount: s.nodes.length,
      tree: childNode,
      children: nested,
      content,
      counts: { text: Object.keys(content.text).length, media: Object.keys(content.media).length }
    };
  });
}

/** Chrome naming, applied at whatever depth the header and footer actually live. */
function chromeName(node, siblings, i) {
  if (!isEl(node)) return null;
  const totals = siblings.map((s) => Object.keys(hoistContent(s.nodes[0], 'x').text).length);
  const total = totals.reduce((a, b) => a + b, 0) || 1;
  const small = totals[i] / total < 0.25;
  if (isHeader(node) && small) return 'SiteHeader';
  if (isFooter(node) && small) return 'SiteFooter';
  return null;
}

/**
 * A compact description of one section, for a model to name.
 *
 * Deliberately small: tags, headings, a text sample and a few counts. The whole subtree
 * would be tens of thousands of tokens per section and would not name it any better.
 */
export function describeSection(part) {
  const node = part.tree;
  const headings = [];
  const collect = (n, depth = 0) => {
    if (!isEl(n) || depth > 6) return;
    if (/^h[1-4]$/.test(n.t)) headings.push(textOf(n).trim().slice(0, 80));
    (n.c ?? []).forEach((c) => collect(c, depth + 1));
  };
  collect(node);
  return {
    id: part.id,
    order: part.order,
    tag: node.t,
    classes: cls(node).slice(0, 120),
    headings: headings.slice(0, 5),
    text: textOf(node).trim().replace(/\s+/g, ' ').slice(0, 240),
    images: countTag(node, 'img'),
    links: countTag(node, 'a'),
    forms: countTag(node, 'form')
  };
}

/** Applies model-supplied names over the rule-derived ones, keeping uniqueness intact. */
export function applyLlmNames(parts, names, unique) {
  if (!names) return parts;
  const walk = (list) => {
    for (const part of list) {
      const proposed = names[part.id];
      // Chrome keeps its rule name: SiteHeader and SiteFooter are load-bearing for the
      // shared-layout hoist, which matches on exactly those two strings.
      if (proposed && part.name !== 'SiteHeader' && part.name !== 'SiteFooter') {
        part.name = unique(proposed);
        part.decidedBy = 'llm';
      }
      if (part.children) walk(part.children);
    }
  };
  walk(parts);
  return parts;
}

export function componentizePage(page, { nest = true, maxDepth = 3 } = {}) {
  const sections = splitSections(page.tree);

  // Header and footer are page chrome. A node matching the class pattern while holding
  // most of the page's text is a content wrapper that happens to share a word — naming
  // it "Footer" is how a 4,500-leaf section ends up called site furniture.
  const leafCount = (n) => Object.keys(hoistContent(n, 'x').text).length;
  const totals = sections.map((s) => leafCount(s.nodes[0]));
  const pageText = totals.reduce((a, b) => a + b, 0) || 1;
  const isChrome = (i) => totals[i] / pageText < 0.25;

  const used = new Map();
  /**
   * Uniqueness is page-wide, not per level: every component for a page lands in one
   * directory, so the same name at two depths overwrites the other and leaves Page.jsx
   * importing someone else's markup.
   *
   * Two chrome sections on one page — a desktop and a mobile header, routine in Elementor
   * and Divi — both name themselves SiteHeader, and the duplicate import is a hard build
   * failure. Order-numbered names cannot collide, so this only fires on chrome.
   */
  const unique = (name) => {
    const n = (used.get(name) ?? 0) + 1;
    used.set(name, n);
    return n === 1 ? name : `${name}${n}`;
  };

  const parts = sections.map((s, i) => {
    // A run of identical siblings is one section holding many items; wrap it so the
    // rendered DOM keeps every sibling exactly where it was.
    const node = s.nodes.length === 1
      ? s.nodes[0]
      : { t: 'underpin-fragment', a: {}, c: s.nodes };

    const primary = s.nodes[0];
    const name = unique(
      isHeader(primary) && isChrome(i) ? 'SiteHeader'
      : isFooter(primary) && isChrome(i) ? 'SiteFooter'
      : nameSection(primary, s.order)
    );

    // A section holding most of the page is a wrapper, not a section. Open it up so the
    // export is a real component tree rather than one file with the whole site in it.
    const dominant = totals[i] / pageText >= DOMINANT_SHARE;
    const children = nest && dominant && s.nodes.length === 1
      ? nestSection(s.nodes[0], s.id, 1, maxDepth, unique)
      : null;

    const content = hoistContent(node, s.id);
    return {
      id: s.id,
      order: s.order,
      name,
      kind: s.kind,
      itemCount: s.nodes.length,
      tree: node,
      children,
      content,
      decidedBy: 'rule',
      counts: {
        text: Object.keys(content.text).length,
        media: Object.keys(content.media).length
      }
    };
  });

  // Exposed so a caller that has a model can rename without re-deriving uniqueness.
  Object.defineProperty(parts, 'unique', { value: unique, enumerable: false });
  return parts;
}
