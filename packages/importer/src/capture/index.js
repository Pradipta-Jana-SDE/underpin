import { chromium } from 'playwright';
import { mergeResources } from './merge.js';
import { detectLibraries, stripAnimationState } from './strip-animation.js';

/**
 * Full-fidelity capture.
 *
 * Template mode reads a page for its meaning — sections, slots, archetypes — and rebuilds it
 * from a shared library, which is what lets one library serve many brands and why the result
 * looks tidier than the original rather than identical.
 *
 * Fidelity mode does the opposite: render in a real browser, wait for the JavaScript, take
 * the DOM and CSS as they are. It looks like the original because it is the original's
 * markup and styles, re-hosted and re-emitted as React. Nothing is shared between sites.
 *
 * The two trade against each other. Pick per site.
 */

/** Scripts that must never survive: they call WordPress, or exist only for wp-admin. */
const DROP_SCRIPT = [
  /wp-admin/i, /admin-ajax\.php/i, /wp-login/i, /xmlrpc/i,
  /wp-emoji-release/i, /wp-embed/i, /comment-reply/i,
  /\/wp-json\//i, /heartbeat/i,
  // Cloudflare's bot-management probe. It is injected by the edge, not by the site, and
  // mirroring it produces a script the export then 404s on — a broken request in every
  // migrated page, caused entirely by copying something that was never the site's.
  /\/cdn-cgi\/challenge-platform\//i
];

/**
 * `document.write` after load triggers an implicit `document.open()` and erases the
 * page. Every script we re-inject runs post-load by construction, so any script using it
 * is in the blast radius — dropped loudly rather than silently.
 */
export const DOC_WRITE = /document\s*\.\s*write(ln)?\s*\(/;

/**
 * Another app's page-level framework runtime, which can never be replayed here.
 *
 * A hydration framework boots by adopting the DOM it believes it server-rendered, so the
 * source's runtime finds markup our React produced and tears itself apart on it. Worse when
 * the source is itself Next.js (goranggosolutions.com): both apps push into the same
 * `self.__next_f` and `webpackChunk_N_E`, so its flight payload corrupts our hydration
 * stream — "createMutableActionQueue is not a function", and every interaction silently dead.
 *
 * Dropping them is strictly better. The captured DOM is already the framework's finished
 * output, so the page looks right and our React hydrates cleanly. Only interactivity living
 * in the source's own components is lost, so that is counted and reported.
 *
 * Narrow on purpose: these patterns match whole-page runtimes and their bootstrap payloads,
 * not a WordPress site with one React widget on it.
 */
export const FRAMEWORK_SRC = [
  /\/_next\/static\//i,          // Next.js
  /\/_nuxt\//i,                  // Nuxt
  /\/page-data\/|webpack-runtime-[a-f0-9]+\.js|framework-[a-f0-9]+\.js/i, // Gatsby
  /\/_app\/immutable\//i         // SvelteKit
];

export const FRAMEWORK_INLINE = [
  /self\.__next_f/,              // Next.js App Router flight payload
  /__NEXT_DATA__/,               // Next.js Pages Router
  /window\.__NUXT__/,
  /window\.___gatsby|___loader/,
  /__remixContext/,
  /__sveltekit_/
];

/** Names the framework a page was built with, for the report. */
export function detectSourceFramework(scripts = []) {
  const joined = scripts.map((s) => (s.kind === 'external' ? s.src : s.code ?? '')).join('\n');
  if (/self\.__next_f|__NEXT_DATA__|\/_next\/static\//.test(joined)) return 'Next.js';
  if (/window\.__NUXT__|\/_nuxt\//.test(joined)) return 'Nuxt';
  if (/window\.___gatsby|\/page-data\//.test(joined)) return 'Gatsby';
  if (/__remixContext/.test(joined)) return 'Remix';
  if (/__sveltekit_/.test(joined)) return 'SvelteKit';
  return null;
}

/** Inline snippets that are pure WordPress cruft and carry hostile characters. */
const DROP_INLINE = [
  /_wpemojiSettings/i,      // unpaired surrogates; breaks strict JSON parsers
  /wp-emoji/i,
  // Cloudflare's bot-management bootstrap. The edge injects it, the site never asked for
  // it, and replaying it makes the migrated page request /cdn-cgi/challenge-platform/…
  // from its own origin — a 404 on every page, caused entirely by copying infrastructure
  // that was never part of the site. Dropping the external script is not enough: this
  // inline snippet is what injects it.
  /__CF\$cv\$params|cdn-cgi\/challenge-platform/i
];

/** Nodes that are WordPress chrome, not content. */
const DROP_SELECTOR = [
  '#wpadminbar', '#query-monitor', '.admin-bar-hidden',
  // Swiper and Slick inject their own duplicate slides into the live DOM for loop mode.
  // Capturing those clones as permanent nodes means the re-injected library later runs
  // against DOM containing its own stale output from a different page load — it
  // re-duplicates on top of them or miscounts. Let the library regenerate its own.
  '.swiper-slide-duplicate', '.slick-cloned', '.swiper-notification',
  'link[rel="EditURI"]', 'link[rel="wlwmanifest"]', 'link[rel="pingback"]',
  'meta[name="generator"]', 'script[type="application/ld+json"][data-wp]'
];

/** Attributes React will not accept verbatim, or that leak the source install. */
const DROP_ATTR = new Set(['data-wp-nonce', 'nonce', 'data-nonce']);

/**
 * Drives the page top to bottom so lazy images resolve and reveal animations fire.
 *
 * Runs in the browser, and now runs AFTER the shipping snapshot rather than before it —
 * its output is used to learn what the lazy loaders resolved to, not to decide what the
 * migrated page looks like.
 */
const SCROLL_PASS = async () => {
  await new Promise((done) => {
    let y = 0;
    const step = () => {
      y += window.innerHeight * 0.8;
      window.scrollTo(0, y);
      if (y < document.body.scrollHeight) setTimeout(step, 90);
      else { window.scrollTo(0, 0); setTimeout(done, 450); }
    };
    step();
  });
};


/**
 * Opens every chrome menu and marks what appears, in the browser.
 *
 * A JS-built dropdown exists only while that JS runs, so a closed-page capture misses the
 * panel entirely — hovering "Products" on one real site injects ten nodes we never saw, and
 * the migrated menu looks right and does nothing.
 *
 * So open each menu, mark the new nodes and leave them in. They ship `display:none` and are
 * revealed on hover and focus by a small stylesheet, so the closed page renders identically
 * and the menu works without the source's framework, which cannot be replayed anyway.
 *
 * Chrome only — opening arbitrary page widgets would be guessing.
 */
const MENU_PROBE = async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const roots = [...document.querySelectorAll('header, nav, [class*="header" i], [class*="nav" i]')].slice(0, 4);
  if (!roots.length) return { opened: 0, panels: 0 };

  const triggers = new Set();
  for (const root of roots) {
    for (const el of root.querySelectorAll('button, [aria-haspopup], [aria-expanded], li:has(> ul), [class*="dropdown" i] > a, [class*="submenu" i]')) {
      triggers.add(el);
    }
  }

  /**
   * One trigger's own subtree, snapshotted immediately before opening it.
   *
   * Per trigger, not once for the whole chrome. The page's scripts keep adding classes for
   * seconds after load — sticky headers, scrollbar offsets, responsive state — so restoring
   * a three-second-old snapshot strips them. On a Kadence theme that took the page 7%
   * shorter at mobile and cost seven points of fidelity, with nothing failing.
   */
  const snapshotOf = (el) => {
    const m = new Map();
    for (const node of [el, ...el.querySelectorAll('*')]) {
      m.set(node, node.getAttributeNames().map((n) => [n, node.getAttribute(n)]));
    }
    return m;
  };
  const restoreFrom = (m) => {
    for (const [node, attrs] of m) {
      const want = new Map(attrs);
      for (const name of node.getAttributeNames()) {
        if (!want.has(name) && !name.startsWith('data-underpin')) node.removeAttribute(name);
      }
      for (const [name, value] of want) {
        if (node.getAttribute(name) !== value) node.setAttribute(name, value);
      }
    }
  };

  let opened = 0;
  let panels = 0;
  for (const trigger of [...triggers].slice(0, 12)) {
    const container = trigger.closest('li, [class*="dropdown" i], [class*="menu-item" i]') ?? trigger.parentElement ?? trigger;
    const was = snapshotOf(container);
    const before = new Set(document.querySelectorAll('*'));
    for (const type of ['pointerover', 'mouseover', 'mouseenter', 'focus']) {
      try { trigger.dispatchEvent(new (type === 'focus' ? FocusEvent : MouseEvent)(type, { bubbles: type !== 'mouseenter' })); } catch { /* not dispatchable */ }
    }
    await sleep(260);

    const added = [...document.querySelectorAll('*')].filter((el) => !before.has(el));
    if (!added.length) { restoreFrom(was); continue; }

    // Only the outermost new nodes get marked; their descendants come along for free and
    // marking each one would put the attribute on hundreds of elements.
    const outermost = added.filter((el) => !added.includes(el.parentElement));
    if (!outermost.length) continue;

    opened += 1;
    panels += outermost.length;

    // Put the trigger back to its closed appearance — an opened menu also rotates its
    // chevron and sets aria-expanded, and that is not how the page looks at rest. The new
    // panel nodes stay, and so do the two attributes that address them.
    restoreFrom(was);
    container.setAttribute('data-underpin-menu', '');
    for (const el of outermost) el.setAttribute('data-underpin-panel', '');
  }

  return { opened, panels };
};

/**
 * Reveals a captured menu panel on hover and keyboard focus. Minimal and last in the
 * cascade — visibility only, so the panel keeps the source's positioning and colours.
 * `:focus-within` is not a nicety: the original's JS handled keyboard before we removed it.
 */
export const MENU_CSS = `
[data-underpin-panel]{display:none!important}
[data-underpin-menu]:hover>[data-underpin-panel],
[data-underpin-menu]:focus-within>[data-underpin-panel],
[data-underpin-menu]:hover [data-underpin-panel],
[data-underpin-menu]:focus-within [data-underpin-panel]{display:block!important}
@media (prefers-reduced-motion:no-preference){[data-underpin-panel]{animation:none}}
`;

export async function captureSite(urls, { origin, concurrency = 2, onProgress, virgin = true } = {}) {
  const browser = await chromium.launch();
  const pages = [];
  const assets = new Map();
  const failures = [];

  const addAsset = (raw, kind) => {
    if (!raw) return null;
    try {
      const u = new URL(raw, origin);
      if (!/^https?:$/.test(u.protocol)) return null;
      const key = u.toString().split('#')[0];
      if (!assets.has(key)) assets.set(key, { url: key, kind });
      return key;
    } catch {
      return null;
    }
  };

  let done = 0;
  const queue = [...urls];

  const worker = async () => {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
      userAgent: process.env.UNDERPIN_USER_AGENT ?? 'UnderpinBot/0.1 (+migration tooling)'
    });

    while (queue.length) {
      const url = queue.shift();
      const page = await ctx.newPage();
      const seen = new Set();
      page.on('response', (r) => {
        const t = r.request().resourceType();
        // 'media' matters: without it a hero <video src> is never mirrored and keeps
        // pointing at the WordPress origin, which fails origin-independence outright.
        if (['stylesheet', 'font', 'image', 'script', 'media'].includes(t)) seen.add(`${t}|${r.url()}`);
      });

      try {
        // `networkidle` is the right target and the wrong requirement: analytics, chat
        // widgets and long-polling keep a marketing site permanently busy, so it times out
        // and the page drops out of the migration. On demos.kadencewp.com the homepage
        // never idled while `load` fired in under two seconds with a complete DOM.
        // Try for idle, settle for loaded, never drop the page.
        try {
          await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
        } catch {
          await page.goto(url, { waitUntil: 'load', timeout: 45000 });
          // Late-arriving markup that idle would have waited for.
          await page.waitForTimeout(2500);
        }

        const snapshot = () => page.evaluate(
          ({ dropSel, dropAttr }) => {
            const doc = document;
            // Filter at serialization time, not in the live document. This runs twice
            // against the same page, so the first pass must not change what the second
            // sees — and deleting .swiper-slide-duplicate out from under a running Swiper
            // mutates its state mid-flight, breaking the page we are trying to copy.
            const dropSelector = dropSel.join(',');
            const dropped = (el) => { try { return el.matches(dropSelector); } catch { return false; } };

            const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);

            // Serialize to a plain tree. React renders this through createElement, so the
            // output is a real component tree rather than an innerHTML blob.
            const serialize = (node, depth = 0) => {
              if (depth > 60) return null;
              if (node.nodeType === Node.TEXT_NODE) {
                const t = node.nodeValue;
                return t && t.trim() ? t : (/[ \n\t]/.test(t ?? '') ? ' ' : null);
              }
              if (node.nodeType !== Node.ELEMENT_NODE) return null;
              const tag = node.tagName.toLowerCase();
              if (tag === 'script' || tag === 'noscript') return null;
              if (dropped(node)) return null;

              const attrs = {};
              for (const a of node.attributes) {
                if (dropAttr.includes(a.name)) continue;
                attrs[a.name] = a.value;
              }
              if (VOID.has(tag)) return { t: tag, a: attrs };

              const kids = [];
              for (const c of node.childNodes) {
                const s = serialize(c, depth + 1);
                if (s !== null && s !== undefined) kids.push(s);
              }
              return { t: tag, a: attrs, c: kids };
            };

            // One ordered query, not two. Themes interleave <link> and <style> for
            // cascade reasons; capturing them separately and concatenating silently
            // flips which rule wins on a specificity tie.
            const sheets = [...doc.querySelectorAll('style, link[rel="stylesheet"][href]')].map((el, i) =>
              el.tagName === 'STYLE'
                ? { kind: 'inline', order: i, css: el.textContent ?? '' }
                : { kind: 'link', order: i, href: el.href }
            );
            // Structured data travels as data, so it is collected before scripts are
            // stripped from the serialized tree.
            const jsonLd = [...doc.querySelectorAll('script[type="application/ld+json"]')]
              .map((s) => s.textContent ?? '')
              .filter((t) => t.trim());

            // Ordered, interleaved. WordPress prints a plugin's config object in an
            // inline <script> immediately BEFORE the bundle that reads it — capturing
            // externals and inlines separately and running all externals first means the
            // bundle boots with its config undefined. Elementor fails exactly this way.
            const scripts = [...doc.querySelectorAll('script')]
              .map((s, i) => {
                const type = (s.type || 'text/javascript').toLowerCase();
                // Only executable JS goes through the loader. JSON-LD, templating types
                // and importmaps are data — appending them as scripts throws.
                const executable = !type || /javascript|^module$|ecmascript/.test(type);
                if (!executable) return null;
                return s.src
                  ? { kind: 'external', order: i, src: s.src, type }
                  : { kind: 'inline', order: i, code: s.textContent ?? '', type };
              })
              .filter(Boolean);

            return {
              lang: doc.documentElement.lang || 'en',
              bodyClass: doc.body.className,
              bodyAttrs: Object.fromEntries([...doc.body.attributes].map((a) => [a.name, a.value])),
              htmlClass: doc.documentElement.className,
              tree: serialize(doc.body),
              sheets,
              jsonLd,
              scriptsOrdered: scripts,
              title: doc.title,
              head: {
                meta: [...doc.querySelectorAll('meta')].filter((m) => !dropped(m)).map((m) =>
                  Object.fromEntries([...m.attributes].map((a) => [a.name, a.value]))),
                links: [...doc.querySelectorAll('link[rel]:not([rel="stylesheet"])')].filter((l) => !dropped(l)).map((l) =>
                  Object.fromEntries([...l.attributes].map((a) => [a.name, a.value])))
              }
            };
          },
          { dropSel: DROP_SELECTOR, dropAttr: [...DROP_ATTR] }
        );

        // Two snapshots, one page load.
        //
        // The DOM that ships is taken before anything scrolls. Scrolling fires every reveal
        // animation, and capturing afterwards bakes the finished state in — AOS's
        // `aos-animate`, GSAP's inline transforms and pin-spacer wrappers all permanent.
        // Replayed against that DOM the scripts initialise on top of their own output and
        // never run again: the site looks right and feels dead.
        //
        // The page is still driven, but only to learn what lazy-loading resolved to;
        // resource URLs merge back by structural position and nothing else crosses over.
        // Menus open before the shipping snapshot so their panels are in the emitted tree.
        let menuReport = null;
        if (virgin) menuReport = await page.evaluate(MENU_PROBE).catch(() => null);

        const captured = await snapshot();

        let mergeReport = null;
        if (virgin) {
          await page.evaluate(SCROLL_PASS);
          await page.waitForTimeout(500);
          const driven = await snapshot().catch(() => null);
          mergeReport = mergeResources(captured.tree, driven?.tree ?? null);
        } else {
          // The old behaviour, one flag away: drive first, capture once, ship what the
          // scripts left behind. Kept because a site whose reveal library did not survive
          // capture is better off with the animated state baked in than invisible.
          await page.evaluate(SCROLL_PASS);
          await page.waitForTimeout(500);
          const driven = await snapshot();
          captured.tree = driven.tree;
        }

        for (const s of seen) {
          const [kind, u] = s.split('|');
          if (kind === 'script' && DROP_SCRIPT.some((re) => re.test(u))) continue;
          addAsset(u, kind);
        }
        for (const sh of captured.sheets) if (sh.kind === 'link') addAsset(sh.href, 'stylesheet');
        for (const sc of captured.scriptsOrdered) {
          if (sc.kind === 'external' && !DROP_SCRIPT.some((re) => re.test(sc.src))) addAsset(sc.src, 'script');
        }

        const u = new URL(url);
        const sourceFramework = detectSourceFramework(captured.scriptsOrdered);
        const droppedFramework = [];

        const survivingScripts = captured.scriptsOrdered
            .filter((sc) => {
              // Another app's whole-page runtime cannot boot inside this one. Counted, not
              // silently swallowed: losing a site's interactivity is worth saying out loud.
              const isFramework = sc.kind === 'external'
                ? FRAMEWORK_SRC.some((re) => re.test(sc.src))
                : FRAMEWORK_INLINE.some((re) => re.test(sc.code ?? ''));
              if (isFramework) {
                droppedFramework.push(sc.kind === 'external' ? sc.src : `inline #${sc.order}`);
                return false;
              }
              return sc.kind === 'external'
                ? !DROP_SCRIPT.some((re) => re.test(sc.src))
                : sc.code.length < 60000 &&
                  !DROP_INLINE.some((re) => re.test(sc.code)) &&
                  !DOC_WRITE.test(sc.code);
            })
            .map((sc) =>
              sc.kind === 'inline'
                ? {
                    ...sc,
                    // A plugin's config object routinely carries an admin-ajax URL.
                    // Dropping the whole object because of it leaves the bundle booting
                    // with its config undefined; neutralising just the endpoint keeps
                    // everything else — colours, breakpoints, feature flags — intact.
                    code: sc.code.replace(
                      /https?:(\\?\/\\?\/)[^"'\s]*?(admin-ajax\.php|wp-json)[^"'\s]*/gi,
                      'about:blank#wp-endpoint-removed'
                    )
                  }
                : sc
            );

        // Strip the animated state, but only for libraries whose script survived the
        // filtering above and will replay. Remove `aos-animate` after AOS's bundle was
        // dropped and every reveal stays at opacity:0 — a baked-in animation is a
        // disappointment, a blank section is a broken migration.
        let stripReport = null;
        if (virgin) {
          const libs = detectLibraries(survivingScripts, captured.sheets);
          stripReport = { ...stripAnimationState(captured.tree, libs), libs };
        }

        pages.push({
          url,
          path: u.pathname,
          ...captured,
          scriptsOrdered: survivingScripts,
          captureDiagnostics: {
            virgin,
            sourceFramework,
            menus: menuReport,
            droppedFramework: droppedFramework.slice(0, 20),
            droppedFrameworkCount: droppedFramework.length,
            merged: mergeReport?.merged.length ?? 0,
            unmerged: (mergeReport?.unmerged ?? []).slice(0, 40),
            unmergedTotal: mergeReport?.unmerged.length ?? 0,
            animation: stripReport
          }
        });
      } catch (err) {
        failures.push({ url, error: String(err?.message ?? err) });
      } finally {
        await page.close();
        onProgress?.(++done, urls.length, url);
      }
    }
    await ctx.close();
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  await browser.close();
  return { pages, assets: [...assets.values()], failures };
}
