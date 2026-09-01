import { createHash } from 'node:crypto';
import { hoistContent } from './componentize.js';

/**
 * Decides whether the header and footer can move into the shared layout.
 *
 * Hoisting saves a byte-identical copy per page, but chrome that is only nearly identical
 * loses its per-page state when shared, and the generated files all still look right in a
 * diff. So we hoist on proof only, and a refusal names the rule and the pages involved.
 *
 * Read-only: this answers a question, the caller decides what to emit.
 */

/* ---------------------------------------------------------------------- hashing */

const isEl = (n) => n && typeof n === 'object' && typeof n.t === 'string';

/** Whitespace between tags is not a child. Same predicate as splitSections and hoistContent. */
const isRealChild = (c) => isEl(c) || (typeof c === 'string' && c.trim());

const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/** All text hashes alike — position is structure, wording is content. */
const TEXT_MARK = '#t';

/**
 * Drop class tokens containing a digit. Builders number elements per page — Elementor's
 * `elementor-element-7a3f1` differs in every export of the same header — so comparing raw
 * classes refuses every hoist on every Elementor site. Same predicate as `signature()` in
 * componentize.js; if they drift, one shape hashes as two and the refusals stop making sense.
 */
const stableClasses = (n) =>
  String(n?.a?.class ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .filter((c) => !/\d/.test(c))
    .sort();

/**
 * Depth-first hash of structure: tags, ids, stable classes, attribute names, child shape.
 * Attribute values stay out (bar class and id) — a differing `src` or a computed inline
 * height is harmless between two renders of one header, and folding it in refuses everything.
 *
 * Classes are in on purpose: `current-menu-item` on the active nav link is exactly the
 * per-page difference that must prevent a hoist.
 */
export function structuralHash(node) {
  if (!isEl(node)) return sha1(TEXT_MARK);
  const id = node.a?.id ?? '';
  const classes = stableClasses(node).join('.');
  const attrs = Object.keys(node.a ?? {}).sort().join(',');
  const kids = (node.c ?? [])
    .filter(isRealChild)
    .map((c) => (isEl(c) ? structuralHash(c) : TEXT_MARK));
  return sha1(`${node.t}#${id}.${classes}[${attrs}](${kids.join(',')})`);
}

/**
 * A subtree's hoisted leaves as one flat map. Text keys end `.<index>` and media keys
 * `@<attr>`, so merging the two namespaces cannot collide. Addressed from the default `'s'`
 * base, never the section id — the same header is `sec_01` on one page and `sec_02` on the next.
 *
 * Paths come from hoistContent, which counts whitespace children that structuralHash ignores,
 * so a header differing only in whitespace clears rule 3 and then trips rule 5 on every key.
 * That errs toward keeping the copies, and one shared definition of "what is content" is
 * worth more than the edge case.
 */
function hoistMap(node) {
  const { text, media } = hoistContent(node);
  return { ...text, ...media };
}

/** Hash of the editable leaves, keyed by the paths the renderer splices back in. */
export function contentHash(node) {
  const map = hoistMap(node);
  return sha1(
    Object.keys(map)
      .sort()
      .map((k) => `${k}=${map[k]}`)
      .join('\n')
  );
}

/* --------------------------------------------------------------------- decision */

/**
 * How much hoisted content may differ and still be the same chrome. Tuned on real captures:
 * 5% of a typical 40-leaf header is one or two leaves — a copyright line naming the page, a
 * phone number spaced differently. Past that it is a real per-page difference; keep the copies.
 */
const NEAR_IDENTICAL_KEYS = 0.05;

/** Destination and asset keys, where "close enough" is never enough. */
const isLinkKey = (k) => k.endsWith('@href') || k.endsWith('@src');

const pathOf = (page) => page?.path ?? page?.key ?? '(unnamed page)';

const listPaths = (ps) => {
  if (ps.length === 1) return ps[0];
  if (ps.length === 2) return `${ps[0]} and ${ps[1]}`;
  if (ps.length === 3) return `${ps[0]}, ${ps[1]} and ${ps[2]}`;
  return `${ps.slice(0, 2).join(', ')} and ${ps.length - 2} others`;
};

/**
 * `pagesParts` is `[{ key, path, parts }]`, parts being componentizePage() output.
 *
 * Header and footer are decided separately: a site with an identical footer and an
 * active-nav class in the header should still get the footer for free.
 *
 * Returns `{ header: { hoist, reason, from? }, footer: {...} }`. The reason reaches the
 * migration report, so it names the rule and the two pages that disagreed.
 */
export function hoistDecision(pagesParts) {
  const pages = Array.isArray(pagesParts) ? pagesParts : [];
  return {
    header: decide(pages, 'SiteHeader', 'header'),
    footer: decide(pages, 'SiteFooter', 'footer')
  };
}

function decide(pages, partName, role) {
  const per = (reason) => ({ hoist: false, reason: `per-page: ${reason}` });
  const edge = role === 'header' ? 'first' : 'last';

  // Rule 1 — the component name is the only signal. componentizePage assigns
  // SiteHeader/SiteFooter only when a section looks like chrome and is small relative to the
  // page, which is what stops a 4,500-leaf content wrapper being called site furniture.
  // Re-deriving that here would give us two definitions of chrome, free to drift apart.
  const found = pages
    .map((page) => ({ page, part: (page.parts ?? []).find((p) => p.name === partName) }))
    .filter((f) => f.part);

  if (!found.length) {
    return per(`rule 1 (no page has a ${partName} section, so there is no shared ${role} to hoist)`);
  }

  // Rule 2 — on every page, and on more than one. A layout applies to the whole build, so
  // hoisting partial chrome invents a header on pages that never had one. That changes what
  // those pages render, which is worse than a duplicated file.
  if (pages.length < 2) {
    return per(`rule 2 (only one page in this build — there is nothing to share a ${role} with)`);
  }
  const missing = pages.filter((p) => !(p.parts ?? []).some((x) => x.name === partName));
  if (missing.length) {
    return per(
      `rule 2 (a ${role} appears on ${found.length} of ${pages.length} pages — ` +
        `${listPaths(missing.map(pathOf))} ${missing.length === 1 ? 'has' : 'have'} none, ` +
        `and a shared layout would invent one)`
    );
  }

  // Rule 3 — identical structure, classes included. An active-nav class stops the hoist
  // here: the markup really does differ per page, and one copy cannot be both.
  const structures = found.map((f) => ({ ...f, hash: structuralHash(f.part.tree) }));
  const refS = structures[0];
  const oddS = structures.find((s) => s.hash !== refS.hash);
  if (oddS) {
    return per(`rule 3 (structure differs between ${pathOf(refS.page)} and ${pathOf(oddS.page)})`);
  }

  // Rule 4 — must already sit at the edge of the page. A layout wraps its children, so
  // lifting a section out of the middle moves it in the DOM, shifting every :nth-child after
  // it and breaking sibling selectors — the failure componentize.js exists to avoid.
  for (const f of found) {
    const orders = (f.page.parts ?? []).map((p) => p.order);
    const wanted = role === 'header' ? Math.min(...orders) : Math.max(...orders);
    if (f.part.order !== wanted) {
      return per(
        `rule 4 (the ${role} is not the ${edge} section on ${pathOf(f.page)}, ` +
          `so hoisting it would reorder that page)`
      );
    }
  }

  // Rule 5 — identical content, or close enough that the difference is not one.
  const contents = found.map((f) => ({ page: f.page, hash: contentHash(f.part.tree), map: hoistMap(f.part.tree) }));
  const refC = contents[0];
  const oddC = contents.find((c) => c.hash !== refC.hash);
  if (oddC) {
    // Union of keys across pages, not one page's count: a leaf present on one page and
    // missing on another is itself a difference, and must not shrink its own denominator.
    const keys = new Set(contents.flatMap((c) => Object.keys(c.map)));
    const differing = [...keys].filter((k) => contents.some((c) => c.map[k] !== refC.map[k]));

    // Checked before the count and independently of it. A logo linking somewhere different
    // per page is one key in forty and would sail through the 5% allowance, but a shared
    // header sending every page to the same wrong place is the bug this module prevents.
    const links = differing.filter(isLinkKey).sort();
    if (links.length) {
      return per(
        `rule 5 (a link or image in the ${role} differs between ${pathOf(refC.page)} and ` +
          `${pathOf(oddC.page)} at ${links[0]} — a destination that changes per page is not shared chrome)`
      );
    }

    if (differing.length / (keys.size || 1) > NEAR_IDENTICAL_KEYS) {
      return per(
        `rule 5 (content differs between ${pathOf(refC.page)} and ${pathOf(oddC.page)} in ` +
          `${differing.length} of ${keys.size} places — too much of the ${role} to be incidental)`
      );
    }
  }

  // Keep the homepage copy: most likely to have captured cleanly, and the page a reviewer
  // opens first if two pages differ by a hair under the near-identical rule.
  const source = found.find((f) => f.page.path === '/') ?? found[0];
  return { hoist: true, reason: 'hoisted', from: source.page.key };
}
