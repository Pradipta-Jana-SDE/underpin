/**
 * Mechanical decomposition of a captured page into per-section components.
 *
 * Not classification. Nothing here decides what a section *means* — it splits the tree
 * where sections already begin, hoists the editable leaves out, and leaves everything
 * else verbatim. That distinction is what makes it safe: the rendered DOM is unchanged,
 * so CSS sibling selectors, :nth-child counts and scripts that query across sections all
 * still resolve exactly as they did on the source page.
 *
 * The one rule the whole module obeys:
 *
 *   A split is safe if and only if it never adds a wrapper element, never removes an
 *   element that always rendered, and never reorders siblings.
 *
 * Violating it is how you shift an :nth-child count and break a layout in a way that is
 * invisible in review and obvious to a client.
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
 * Descends through pure layout wrappers.
 *
 * Scripts inject their own wrappers at runtime — GSAP ScrollTrigger's `pin-spacer-*`
 * divs are all over the real capture and do not exist in server HTML. Each wraps exactly
 * one section, so passing through them finds the real boundaries. Stops at anything that
 * looks like a component, because descending into a carousel discards the very context
 * that identifies it.
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
  // Collect the OUTERMOST section-matching nodes anywhere in the tree, not just among
  // the body's direct children. Real pages nest their sections inside layout wrappers
  // and script-injected pin-spacers, so looking one level down finds three "sections",
  // one of which is the entire page.
  const found = [];
  const visit = (node) => {
    if (!isEl(node)) return;
    if (matchesSection(node)) {
      found.push(node);
      return; // outermost only — do not descend into nested sections
    }
    (node.c ?? []).forEach(visit);
  };
  visit(bodyTree);

  // Nothing builder-shaped: fall back to the unwrapped root's own children.
  let nodes = found;
  if (nodes.length < 2) {
    const root = unwrapTree(bodyTree);
    nodes = (root.c ?? []).filter(isEl).map((c) => unwrapTree(c));
  }

  // Merge runs of structurally identical siblings — a six-logo strip is one section.
  // Signature alone is not enough: Elementor gives every top-level container the same
  // classes, so seven unrelated sections look identical by shape. Require comparable
  // size as well, which is what actually distinguishes a card grid from a page.
  const size = (n) => textOf(n).trim().length + countTag(n, 'img') * 40;
  const similar = (a, b) => {
    if (signature(a) !== signature(b)) return false;
    const [x, y] = [size(a) || 1, size(b) || 1];
    return Math.max(x, y) / Math.min(x, y) <= 3;
  };

  const merged = [];
  let i = 0;
  while (i < nodes.length) {
    let j = i + 1;
    while (j < nodes.length && similar(nodes[j], nodes[i])) j++;
    const run = nodes.slice(i, j);
    merged.push(run.length >= 3 ? { kind: 'run', nodes: run } : { kind: 'single', nodes: [run[0]] });
    i = run.length >= 3 ? j : i + 1;
  }

  return merged
    .filter((s) => s.nodes.length && (textOf(s.nodes[0]).trim() || countTag(s.nodes[0], 'img')))
    .map((s, idx) => ({
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
 * The boundary is a lookup, not a judgment: a value is content when it is the text of a
 * leaf node, or a src/href/poster/srcset/alt on an element that carries one. Everything
 * else — class, id, style, data-*, aria-* and every wrapper — stays in the component
 * verbatim. Deciding by which HTML API the value lives in is what keeps this mechanical;
 * asking "is this aria-label really content" is where classification creeps back in.
 *
 * Paths use the same addressing DomNode already renders with, so hoisting is reversible.
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
 * Puts hoisted values back. The inverse of hoistContent, and the reason the round-trip
 * test can prove decomposition changed nothing.
 */
export function spliceContent(tree, content, base = 's') {
  const { text = {}, media = {} } = content ?? {};

  const walk = (node, path) => {
    if (!isEl(node)) return node;

    const attrs = MEDIA_ATTRS[node.t];
    const a = { ...node.a };
    if (attrs) {
      for (const name of attrs) {
        const key = `${path}@${name}`;
        if (key in media) a[name] = media[key];
      }
    }

    const c = (node.c ?? []).map((child, i) => {
      const childPath = `${path}.${i}`;
      if (typeof child === 'string') return childPath in text ? text[childPath] : child;
      return walk(child, childPath);
    });

    return node.c === undefined ? { ...node, a } : { ...node, a, c };
  };

  return walk(tree, base);
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
 * Each component is a thin wrapper around the renderer that already works, fed a smaller
 * subtree — deliberately not generated JSX source. Re-deriving the attribute renaming,
 * boolean props and style parsing a second time as codegen is how a 72-hour project
 * becomes a 200-hour one, and the existing renderer already measures 99.8% visual on a
 * static page. The part the client actually asked for — small, ordered, named files they
 * can open and edit — is delivered by the composition in page.jsx and the per-section
 * content JSON.
 */
export function componentizePage(page) {
  const sections = splitSections(page.tree);

  // Header and footer are page chrome. A node matching the class pattern while holding
  // most of the page's text is a content wrapper that happens to share a word — naming
  // it "Footer" is how a 4,500-leaf section ends up called site furniture.
  const leafCount = (n) => Object.keys(hoistContent(n, 'x').text).length;
  const totals = sections.map((s) => leafCount(s.nodes[0]));
  const pageText = totals.reduce((a, b) => a + b, 0) || 1;
  const isChrome = (i) => totals[i] / pageText < 0.25;

  return sections.map((s, i) => {
    // A run of identical siblings is one section holding many items; wrap it so the
    // rendered DOM keeps every sibling exactly where it was.
    const node = s.nodes.length === 1
      ? s.nodes[0]
      : { t: 'underpin-fragment', a: {}, c: s.nodes };

    const primary = s.nodes[0];
    const name = isHeader(primary) && isChrome(i) ? 'SiteHeader'
      : isFooter(primary) && isChrome(i) ? 'SiteFooter'
      : nameSection(primary, s.order);

    const content = hoistContent(node, s.id);
    return {
      id: s.id,
      order: s.order,
      name,
      kind: s.kind,
      itemCount: s.nodes.length,
      tree: node,
      content,
      counts: {
        text: Object.keys(content.text).length,
        media: Object.keys(content.media).length
      }
    };
  });
}
