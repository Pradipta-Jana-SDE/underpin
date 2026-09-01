/**
 * Undoes what the scroll pass did to the DOM, so the original scripts can replay.
 *
 * An entrance animation is a two-state machine the library owns: `[data-aos]` starts at
 * `opacity: 0`, AOS adds `aos-animate` to move it to 1. Capture scrolls the page — the only
 * way to make lazy images resolve — which drives every machine to its end state and bakes
 * that into the markup. Re-injecting the library then initialises it against a DOM already
 * holding its own output, and nothing animates again. Removing the output resets it.
 *
 * The gate: capture drops scripts (WordPress endpoints, document.write, over the inline
 * size cap) and they never come back. Strip `aos-animate` when AOS's bundle was dropped and
 * its stylesheet still holds every reveal at `opacity: 0` with nothing left to undo it — an
 * invisible page. Silently missing content is far worse than an animation that plays once at
 * t=0. So every operation here is gated on a fingerprint of the scripts that survived, and
 * that asymmetry sets the direction of every judgement call in this file.
 *
 * Second rule, learned from Elementor: never blanket-clear a `style` attribute. Elementor
 * writes real layout inline — `--e-con-grid-template-columns`, backgrounds, per-breakpoint
 * widths — beside its animation state. Only named declarations go, only from elements the
 * library marked, only when the library replays.
 */

const isEl = (n) => n !== null && typeof n === 'object' && typeof n.t === 'string';
const tokens = (n) => String(n?.a?.class ?? '').split(/\s+/).filter(Boolean);
const hasToken = (n, t) => tokens(n).includes(t);

/**
 * Fingerprints the surviving script list and stylesheet hrefs.
 *
 * Matched on scripts, not stylesheets: surviving CSS only proves the pre-animation state
 * (`opacity: 0`, `visibility: hidden`) still applies, which is exactly why stripping
 * without the JS is dangerous. animate.css is the exception — pure CSS, replays on paint.
 *
 * @param {{kind:'external',src:string}|{kind:'inline',code:string}[]} scriptsOrdered
 * @param {(string|{href?:string})[]} sheets
 */
export function detectLibraries(scriptsOrdered = [], sheets = []) {
  const js = (scriptsOrdered ?? [])
    .map((s) => (s?.kind === 'external' ? s?.src : s?.code) ?? '')
    .join('\n');
  const css = (sheets ?? [])
    .map((s) => (typeof s === 'string' ? s : s?.href) ?? '')
    .join('\n');

  return {
    aos: /aos(\.min)?\.js|AOS\.init/.test(js),
    wow: /wow(\.min)?\.js|new WOW\(/.test(js),
    gsap: /gsap|ScrollTrigger|TweenMax/.test(js),
    elementor: /elementor-frontend|elementor\/assets/.test(js),
    animateCss: /animate(\.min)?\.css/.test(css)
  };
}

/** Inline declarations WOW.js writes as it reveals an element. */
const WOW_DECLS = new Set(['visibility', 'animation-name', 'animation-duration', 'animation-delay']);

/** Inline declarations ScrollTrigger writes onto a pinned element while it is pinned. */
const GSAP_PIN_DECLS = new Set([
  'transform', 'translate', 'inset', 'position', 'top', 'left', 'width', 'height', 'margin'
]);

/**
 * Splits a style attribute into declarations without breaking on a semicolon inside a
 * value. `background-image:url(data:image/svg+xml;base64,…)` is common on Elementor
 * sections; a naive `split(';')` halves it — same bug as splitting a srcset on commas.
 */
function splitDeclarations(style) {
  const out = [];
  let buf = '';
  let depth = 0;
  let quote = null;

  for (const ch of String(style)) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.filter((d) => d.trim());
}

/** Property name of one declaration, lowercased for matching only. */
const propOf = (decl) => {
  const i = decl.indexOf(':');
  return (i < 0 ? decl : decl.slice(0, i)).trim().toLowerCase();
};

/** Removes named declarations from an element's inline style. Returns true if it changed. */
function dropDecls(node, pred) {
  const style = node.a?.style;
  if (typeof style !== 'string' || !style) return false;

  const decls = splitDeclarations(style);
  const kept = decls.filter((d) => !pred(propOf(d)));
  if (kept.length === decls.length) return false;

  const next = kept.map((d) => d.trim()).join(';');
  if (next) node.a.style = next;
  else delete node.a.style;
  return true;
}

/** Removes matching class tokens. Returns true if it changed. */
function dropTokens(node, pred) {
  const before = tokens(node);
  const kept = before.filter((t) => !pred(t));
  if (kept.length === before.length) return false;
  // The attribute stays even when it empties out. Removing it would stop the element
  // matching a bare `[class]` selector, and a strip that changes which CSS applies is
  // not a strip any more.
  node.a.class = kept.join(' ');
  return true;
}

const isPinSpacer = (n) => tokens(n).some((t) => /^pin-spacer/.test(t));

/**
 * Puts a captured tree back into its pre-animation state, in place.
 *
 * @param {object} tree captured node tree (the shipped, virgin one)
 * @param {{aos?:boolean,wow?:boolean,gsap?:boolean,elementor?:boolean,animateCss?:boolean}} libs
 *   from `detectLibraries`
 * @returns {{stripped:number, unwrapped:number}} `stripped` counts elements that lost at
 *   least one class token or declaration; `unwrapped` counts pin-spacer wrappers removed.
 */
export function stripAnimationState(tree, libs = {}) {
  let stripped = 0;
  let unwrapped = 0;
  if (!isEl(tree)) return { stripped, unwrapped };

  // Elements that were the sole occupant of a removed pin-spacer. ScrollTrigger writes
  // the pinned element's frozen layout inline, and that is the one case where we can be
  // sure an inline `position`/`transform` is the library's and not the theme's.
  const pinned = new Set();

  const isPinned = (n) =>
    pinned.has(n) ||
    n.a?.['data-scroll'] !== undefined ||
    /^pin-/.test(String(n.a?.id ?? ''));

  const stripNode = (node) => {
    if (!node.a) return false;
    let touched = false;

    // AOS toggles exactly these two classes and owns the opacity behind them.
    if (libs.aos && node.a['data-aos'] !== undefined) {
      touched = dropTokens(node, (t) => t === 'aos-animate' || t === 'aos-init') || touched;
    }

    // WOW re-adds its animateClass on reveal and clears the inline `visibility: hidden`
    // it wrote at init, so both sides of that swap are runtime state. `animate__*` covers
    // animate.css v4, where the name class is what actually runs the keyframes.
    if ((libs.wow || libs.animateCss) && hasToken(node, 'wow')) {
      touched = dropTokens(node, (t) => t === 'animated' || /^animate__/.test(t)) || touched;
      touched = dropDecls(node, (p) => WOW_DECLS.has(p)) || touched;
    }

    // `elementor-invisible` IS the pre-animation state — the class Elementor removes when
    // it starts the entrance. Keeping it is the whole point; only the inline
    // animation-* values it wrote on the way through are dropped.
    if (libs.elementor && hasToken(node, 'elementor-invisible')) {
      touched = dropDecls(node, (p) => /^animation(-|$)/.test(p)) || touched;
    }

    if (libs.gsap && isPinned(node)) {
      touched = dropDecls(node, (p) => GSAP_PIN_DECLS.has(p)) || touched;
    }

    // Unconditional: inline `will-change` is a compositor hint written for one tween.
    // Baked in it pins a layer for the life of the page and nothing needs it to render.
    touched = dropDecls(node, (p) => p === 'will-change') || touched;

    return touched;
  };

  const visit = (node) => {
    // Unwrap spacers among THIS node's children, so the root itself is never replaced and
    // the walk always has a parent to splice into. Outside-in falls out of re-examining
    // the same index: a nested spacer slides up into the slot just vacated.
    if (libs.gsap && Array.isArray(node.c)) {
      for (let i = 0; i < node.c.length; i++) {
        const child = node.c[i];
        if (!isEl(child) || !isPinSpacer(child)) continue;

        const kids = Array.isArray(child.c) ? child.c : [];
        const els = kids.filter(isEl);
        node.c.splice(i, 1, ...kids);
        unwrapped++;
        if (els.length === 1) pinned.add(els[0]);
        i--;
      }
    }

    if (stripNode(node)) stripped++;
    for (const child of node.c ?? []) if (isEl(child)) visit(child);
  };

  visit(tree);
  return { stripped, unwrapped };
}
