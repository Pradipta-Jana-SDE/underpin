import { createHash } from 'node:crypto';
import { hoistContent } from './componentize.js';

/**
 * Decides whether a site's header and footer can be hoisted into the shared layout.
 *
 * The generator emits SiteHeader.jsx and SiteFooter.jsx into every page's own folder, so a
 * twelve-page migration ships twelve byte-identical copies of the same chrome while
 * app/layout.jsx sits there as a bare shell. Hoisting them once is the obvious win — right
 * up until the header is not actually identical, and the shared copy silently loses the
 * per-page state. That is a bug the client finds on day one, on the first page they open,
 * and it is invisible in a diff of the generated files because the files all look right.
 *
 * So this module never guesses. It hoists only when the chrome is provably the same across
 * every page in the build, and when it refuses it names the rule that refused and where,
 * because "we kept it per-page" is not something a reviewer can act on.
 *
 * Nothing here mutates anything. It answers a question; the caller decides what to emit.
 */

/* ---------------------------------------------------------------------- hashing */

const isEl = (n) => n && typeof n === 'object' && typeof n.t === 'string';

/**
 * A child that occupies a position in the rendered DOM. Whitespace between tags does not.
 *
 * The same predicate splitSections and hoistContent already use, so all three agree on what
 * counts as a child. Counting inter-tag whitespace would make two captures of one header
 * hash differently for a difference nobody can see.
 */
const isRealChild = (c) => isEl(c) || (typeof c === 'string' && c.trim());

const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/** Every text node hashes the same: its position is structure, its wording is content. */
const TEXT_MARK = '#t';

/**
 * Class tokens carrying a digit are dropped.
 *
 * Builders number their elements per page: Elementor's `elementor-element-7a3f1` is a
 * different string in every export of the same header, and comparing them raw would refuse
 * every hoist on every Elementor site. This is deliberately the same predicate `signature()`
 * uses in componentize.js:82-83 — if the two ever disagree, a header that coalescing treats
 * as one shape would hash here as two, and the refusals would be unexplainable.
 */
const stableClasses = (n) =>
  String(n?.a?.class ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .filter((c) => !/\d/.test(c))
    .sort();

/**
 * Depth-first hash of structure alone.
 *
 * Tags, ids, stable class tokens, attribute NAMES and child shape are in. Attribute VALUES
 * are out, except class and id, which are part of the canonical string — a `src` pointing at
 * a different hero image or an inline `style` with a computed height differs harmlessly
 * between two renders of the same header, and folding those in would refuse every hoist for
 * a reason nobody could read off the output.
 *
 * Class tokens are deliberately included, and this is the point: `current-menu-item` on the
 * active nav link is exactly the per-page difference that must PREVENT hoisting.
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
 * The hoisted leaves of a subtree as one flat map.
 *
 * Text keys end in `.<index>` and media keys in `@<attr>`, so the two namespaces cannot
 * collide and merging them loses nothing. Always addressed from the default `'s'` base
 * rather than the section id: the same header is `sec_01` on one page and `sec_02` on
 * another, and comparing the two must not turn that into a difference.
 *
 * The paths come from hoistContent's own indexing, which counts whitespace children that
 * structuralHash ignores. So a header differing only in inter-tag whitespace passes rule 3
 * and then trips rule 5 on every key at once. Conservative in the safe direction — it keeps
 * the per-page copies — and reusing hoistContent verbatim is worth more than the edge case,
 * because a second implementation of "what is content here" is a guaranteed future drift.
 */
function hoistMap(node) {
  const { text, media } = hoistContent(node);
  return { ...text, ...media };
}

/**
 * Hash of the editable leaves — the words, the src/href/alt values — addressed by the same
 * paths the renderer splices back in. Same structure plus same content hash means the same
 * header, in the only sense that matters to a reader of the page.
 */
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
 * How much of a section's hoisted content may differ and still count as the same chrome.
 *
 * Tuned against real captures rather than picked: a header whose phone number differs by a
 * space, or whose copyright line renders the page name, is still one header. Five percent of
 * a typical header's ~40 leaves is one or two of them. Anything past that is a genuine
 * per-page difference wearing a disguise, and the safe answer is to keep the copies.
 */
const NEAR_IDENTICAL_KEYS = 0.05;

/** Hoist keys whose value is a destination or an asset, where "close enough" is never enough. */
const isLinkKey = (k) => k.endsWith('@href') || k.endsWith('@src');

const pathOf = (page) => page?.path ?? page?.key ?? '(unnamed page)';

const listPaths = (ps) => {
  if (ps.length === 1) return ps[0];
  if (ps.length === 2) return `${ps[0]} and ${ps[1]}`;
  if (ps.length === 3) return `${ps[0]}, ${ps[1]} and ${ps[2]}`;
  return `${ps.slice(0, 2).join(', ')} and ${ps.length - 2} others`;
};

/**
 * Should the header and the footer move into the shared layout?
 *
 * `pagesParts` is `[{ key, path, parts }]`, where `parts` is componentizePage() output for
 * that page. Each role is decided independently — a site whose footer is identical
 * everywhere and whose header carries an active-nav class should hoist the footer and keep
 * the header, and collapsing that into one yes/no throws away the half that was free.
 *
 * Returns `{ header: { hoist, reason, from? }, footer: { ... } }`. The reason is surfaced in
 * the migration report, so it names the rule and the two pages that disagreed.
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

  // Rule 1 — the name is the signal, and the only signal.
  //
  // componentizePage assigns SiteHeader/SiteFooter only when a section both looks like
  // chrome AND is small relative to the page, which is the judgment that stops a 4,500-leaf
  // content wrapper from being called site furniture. Re-deriving it here would mean two
  // definitions of "chrome" that can drift; matching the name means there is one.
  const found = pages
    .map((page) => ({ page, part: (page.parts ?? []).find((p) => p.name === partName) }))
    .filter((f) => f.part);

  if (!found.length) {
    return per(`rule 1 (no page has a ${partName} section, so there is no shared ${role} to hoist)`);
  }

  // Rule 2 — it has to be on every page, and on more than one.
  //
  // A layout applies to the whole build. Hoisting chrome that only some pages carry would
  // invent a header on the pages that never had one, which is a worse failure than a
  // duplicated file: it changes what those pages render.
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

  // Rule 3 — identical structure, class tokens included. This is where an active-nav class
  // stops the hoist: the markup genuinely is different per page, and one copy cannot be both.
  const structures = found.map((f) => ({ ...f, hash: structuralHash(f.part.tree) }));
  const refS = structures[0];
  const oddS = structures.find((s) => s.hash !== refS.hash);
  if (oddS) {
    return per(`rule 3 (structure differs between ${pathOf(refS.page)} and ${pathOf(oddS.page)})`);
  }

  // Rule 4 — it must already sit at the edge of the page.
  //
  // A layout wraps its children; hoisting a section out of the middle and re-emitting it at
  // the top moves it in the DOM. That shifts every :nth-child count after it and breaks
  // sibling selectors, which is exactly the failure componentize.js is built to avoid.
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

  // Rule 5 — identical content, or near enough that the difference is not a difference.
  const contents = found.map((f) => ({ page: f.page, hash: contentHash(f.part.tree), map: hoistMap(f.part.tree) }));
  const refC = contents[0];
  const oddC = contents.find((c) => c.hash !== refC.hash);
  if (oddC) {
    // Denominator is the union of keys across pages, not one page's count: a leaf that
    // exists on one page and not another is itself a difference, and it must not shrink the
    // total it is measured against.
    const keys = new Set(contents.flatMap((c) => Object.keys(c.map)));
    const differing = [...keys].filter((k) => contents.some((c) => c.map[k] !== refC.map[k]));

    // Checked before the count, and independently of it. A header whose logo links somewhere
    // different per page is one key out of forty and would sail through the 5% allowance —
    // but a shared header sending every page to the same wrong place is precisely the class
    // of bug this module exists to prevent.
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

  // The homepage is the copy to keep. It is the page most likely to have been captured
  // cleanly, the one a reviewer opens first, and the one whose wording wins if two pages
  // differ by a hair under the near-identical rule.
  const source = found.find((f) => f.page.path === '/') ?? found[0];
  return { hoist: true, reason: 'hoisted', from: source.page.key };
}
