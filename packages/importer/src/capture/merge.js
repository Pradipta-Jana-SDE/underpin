/**
 * Resource merge across the two capture snapshots.
 *
 * Capture takes the DOM twice in one browser session:
 *
 *   virgin — read before the scroll pass. This is the tree that ships.
 *   driven — read after scrolling the whole page. Never shipped; consulted only for
 *            what lazy-loading resolved to.
 *
 * The reason for two is that scrolling is the only way to make a lazy loader fetch its
 * real images, and it is also the thing that ruins the DOM for replay: AOS writes
 * `aos-animate`, GSAP writes inline transforms and pin-spacer wrappers, and a tree
 * carrying that output already is a tree the same scripts cannot animate a second time.
 * So the scroll happens, we keep only its useful residue — resolved URLs — and throw the
 * rest away.
 *
 * The one rule this module obeys:
 *
 *   Virgin structure always wins. Only attribute VALUES ever change. No node is added,
 *   removed or reordered, ever, for any reason.
 *
 * Anything the scroll changed structurally is a diagnostic, not an edit. That is what
 * makes the merge safe to run unattended: the worst case is an image that stays a
 * placeholder and shows up in the report, never a shifted :nth-child count.
 */

/** Attributes that can hold a resolved resource URL, by tag. */
const RESOURCE_ATTRS = {
  img: ['src', 'srcset', 'sizes'],
  source: ['src', 'srcset'],
  video: ['src', 'poster'],
  iframe: ['src']
};

/**
 * Lazy-loader conventions, as `[from, to]`. Every one of these parks the real URL in a
 * data attribute and swaps it into the live attribute on reveal, so the `from` side is
 * already correct in the virgin snapshot — no driven counterpart needed.
 */
const PROMOTE = [
  ['data-src', 'src'],
  ['data-srcset', 'srcset'],
  ['data-lazy-src', 'src'],
  ['data-lazy-srcset', 'srcset'],
  ['data-original', 'src']
];

/**
 * Classes animation libraries ADD during the scroll. They are the difference between the
 * two snapshots by definition, so counting them in the alignment signature would make
 * every revealed element look like a different node and desync the whole walk.
 */
const ANIM_CLASSES =
  /^(aos-animate|aos-init|animated|is-inview|in-view|is-visible|elementor-animated|wow-animated|has-animated|revealed|active)$/;

/**
 * Above this many element children the LCS table stops being worth its cost — and a list
 * that wide is a feed or a product grid, where a diff is meaningless anyway. Tuned from
 * the real captures: the widest legitimate node measured on elementor.com and kinsta.com
 * was 83 children, so 400 is far past anything a hand-built page produces.
 */
const MAX_CHILDREN = 400;

const isEl = (n) => n !== null && typeof n === 'object' && typeof n.t === 'string';
const classTokens = (n) => String(n?.a?.class ?? '').split(/\s+/).filter(Boolean);

/** Cheap per-node identity: tag, id, and the classes that are not animation residue. */
const sig = (n) =>
  `${n.t}|${n.a?.id ?? ''}|${classTokens(n).filter((c) => !ANIM_CLASSES.test(c)).sort().join('.')}`;

const ONE_BY_ONE_GIF = /^data:image\/gif;base64,R0lGOD/i;
const PLACEHOLDER_NAME = /(placeholder|lazy|blank|spacer|loading)\.(gif|png|svg|jpe?g)/i;
const BASE64_IMAGE = /^data:image\/[a-z0-9.+-]+;base64,(.*)$/is;

/** Decodes a data: URI payload, base64 or percent-encoded, without throwing. */
function decodeDataUri(uri) {
  const comma = uri.indexOf(',');
  if (comma < 0) return '';
  const meta = uri.slice(0, comma);
  const payload = uri.slice(comma + 1);
  if (/;base64/i.test(meta)) {
    try {
      return Buffer.from(payload, 'base64').toString('utf8');
    } catch {
      return '';
    }
  }
  try {
    return decodeURIComponent(payload);
  } catch {
    return payload;
  }
}

/**
 * Is this attribute value a stand-in rather than a real resource?
 *
 * Every case here is something a WordPress lazy-loader actually emits. The svg rule needs
 * the decode: lazy loaders emit a `<svg viewBox="0 0 1200 800"/>` with no drawing
 * commands purely to hold the aspect ratio and stop the page reflowing on reveal. It is a
 * spacer, not an image — but it is also indistinguishable from a real inline icon on
 * anything shallower than "does it draw something".
 */
export function isPlaceholder(v) {
  if (v === null || v === undefined) return true;
  const s = String(v).trim();
  if (!s) return true;

  if (ONE_BY_ONE_GIF.test(s)) return true;
  if (PLACEHOLDER_NAME.test(s)) return true;

  // Checked before the size rule below: a real inline SVG is real at any length.
  if (/^data:image\/svg\+xml/i.test(s)) return !/<(path|image|use)\b/i.test(decodeDataUri(s));

  // A blur-up thumbnail is a real image, just not the one the page means to show. Under
  // ~120 characters of base64 there is not enough data for anything but a smudge.
  const m = BASE64_IMAGE.exec(s);
  if (m && m[1].length < 120) return true;

  return false;
}

/**
 * Longest common subsequence over two signature sequences, returned as index pairs.
 *
 * Alignment by index breaks the moment a script injects a node — every sibling after it
 * pairs with its neighbour and the walk merges one card's image into the next card. LCS
 * costs O(n·m) and is bounded by MAX_CHILDREN, which is cheap enough to be unconditional
 * on the slow path.
 */
function lcsPairs(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * Copies resolved resource URLs from the driven tree into the virgin tree.
 *
 * `driven` may be null — a second snapshot that failed, or a caller that only wants the
 * self-promotion pass. In that mode nothing is compared and lazy URLs are recovered from
 * the virgin tree's own `data-src`-style attributes, which is most of the value on the
 * majority of WordPress lazy loaders.
 *
 * Diagnostic paths use the addressing the renderer already renders with (`b.3.1.0`), so a
 * path from the report pastes straight into a DOM query against the shipped tree.
 *
 * @returns {{ tree: object, merged: object[], unmerged: object[] }} `tree` is `virgin`,
 *   mutated in place.
 */
export function mergeResources(virgin, driven, { root = 'b' } = {}) {
  const merged = [];
  const unmerged = [];

  if (!isEl(virgin)) return { tree: virgin, merged, unmerged };

  const soloPass = !isEl(driven);
  // Recorded rather than silent: a page with no driven snapshot and a page with no lazy
  // images look identical in the report otherwise, and only one of them is fine.
  if (soloPass) unmerged.push({ path: root, reason: 'no-driven-snapshot' });

  /** Copy one attribute if the virgin side is a stand-in and the driven side is not. */
  const takeFromDriven = (v, d, attr, path) => {
    if (!d) return false;
    const have = v.a?.[attr];
    const want = d.a?.[attr];
    if (!isPlaceholder(have) || isPlaceholder(want)) return false;
    (v.a ??= {})[attr] = want;
    // srcset travels as one opaque string. Cloudflare Image Resizing puts its options in
    // the path (`/cdn-cgi/image/f=auto,w=632/…`), so anything that splits on commas here
    // shreds every URL in the set — a bug this codebase has already paid for once.
    merged.push({ path, tag: v.t, attr, value: want, via: 'driven' });
    return true;
  };

  const walk = (v, d, path) => {
    if (d && sig(v) !== sig(d)) {
      // Structure diverged. Stop here rather than guessing: descending into a mismatched
      // pair is how one card's image lands on its neighbour.
      unmerged.push({ path, tag: v.t, reason: 'signature' });
      return;
    }

    for (const attr of RESOURCE_ATTRS[v.t] ?? []) takeFromDriven(v, d, attr, path);

    for (const [from, to] of PROMOTE) {
      if (takeFromDriven(v, d, to, path)) continue;
      // No driven counterpart, or the driven side never resolved either: the loader
      // parked the real URL in the virgin tree already, so promote it ourselves.
      const parked = v.a?.[from];
      if (!isPlaceholder(parked) && isPlaceholder(v.a?.[to])) {
        v.a[to] = parked;
        merged.push({ path, tag: v.t, attr: to, value: parked, via: from });
      }
    }

    // Element children only. Counters, typewriter effects and cart totals rewrite text
    // under scroll; aligning across text nodes desyncs the walk for the whole subtree.
    const vKids = [];
    (v.c ?? []).forEach((c, i) => {
      if (isEl(c)) vKids.push({ node: c, i });
    });

    if (soloPass || !d) {
      for (const k of vKids) walk(k.node, null, `${path}.${k.i}`);
      return;
    }

    const dKids = (d.c ?? []).filter(isEl);

    // Fast path: nothing was injected here, so index-for-index is exact and there is no
    // reason to pay for a diff. This is the overwhelmingly common case.
    if (
      vKids.length === dKids.length &&
      vKids.every((k, x) => sig(k.node) === sig(dKids[x]))
    ) {
      vKids.forEach((k, x) => walk(k.node, dKids[x], `${path}.${k.i}`));
      return;
    }

    if (vKids.length > MAX_CHILDREN || dKids.length > MAX_CHILDREN) {
      unmerged.push({ path, tag: v.t, reason: 'too-wide', virgin: vKids.length, driven: dKids.length });
      return;
    }

    const pairs = lcsPairs(vKids.map((k) => sig(k.node)), dKids.map(sig));
    const vMatched = new Set();
    const dMatched = new Set();
    for (const [x, y] of pairs) {
      vMatched.add(x);
      dMatched.add(y);
      walk(vKids[x].node, dKids[y], `${path}.${vKids[x].i}`);
    }

    vKids.forEach((k, x) => {
      // A node the scroll destroyed — a slider clone consumed, a cookie bar dismissed.
      // It stays exactly where it is: the virgin tree is the one that ships.
      if (!vMatched.has(x)) unmerged.push({ path: `${path}.${k.i}`, tag: k.node.t, reason: 'removed-by-scroll' });
    });
    dKids.forEach((n, y) => {
      // Injected during the scroll and deliberately not adopted. It has no address in the
      // shipped tree, so the path names the parent it appeared under.
      if (!dMatched.has(y)) unmerged.push({ path, tag: n.t, drivenIndex: y, reason: 'injected-by-scroll' });
    });
  };

  walk(virgin, soloPass ? null : driven, root);
  return { tree: virgin, merged, unmerged };
}
