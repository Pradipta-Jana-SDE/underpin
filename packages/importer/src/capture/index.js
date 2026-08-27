import { chromium } from 'playwright';

/**
 * Full-fidelity capture.
 *
 * Template mode reads a page for its MEANING — sections, slots, archetypes — and
 * rebuilds it from a shared component library. That is what makes one library serve many
 * brands, and it is why a migrated page looks tidier than the original rather than
 * identical to it.
 *
 * Fidelity mode does the opposite: it renders the page in a real browser, waits for the
 * JavaScript to finish, and takes the DOM and CSS as they actually are. The result looks
 * like the original because it IS the original's markup and styles — re-hosted, cleaned
 * of WordPress, and re-emitted as a React tree. Nothing is shared between sites.
 *
 * The two modes trade against each other and cannot both be maximised. Pick per site.
 */

/** Scripts that must never survive: they call WordPress, or exist only for wp-admin. */
const DROP_SCRIPT = [
  /wp-admin/i, /admin-ajax\.php/i, /wp-login/i, /xmlrpc/i,
  /wp-emoji-release/i, /wp-embed/i, /comment-reply/i,
  /\/wp-json\//i, /heartbeat/i
];

/** Inline snippets that are pure WordPress cruft and carry hostile characters. */
const DROP_INLINE = [
  /_wpemojiSettings/i,      // unpaired surrogates; breaks strict JSON parsers
  /wp-emoji/i,
  /admin-ajax\.php/i,
  /wpAjaxUrl|ajaxurl\s*=/i  // points at an endpoint that will not exist
];

/** Nodes that are WordPress chrome, not content. */
const DROP_SELECTOR = [
  '#wpadminbar', '#query-monitor', '.admin-bar-hidden',
  'link[rel="EditURI"]', 'link[rel="wlwmanifest"]', 'link[rel="pingback"]',
  'meta[name="generator"]', 'script[type="application/ld+json"][data-wp]'
];

/** Attributes React will not accept verbatim, or that leak the source install. */
const DROP_ATTR = new Set(['data-wp-nonce', 'nonce', 'data-nonce']);

export async function captureSite(urls, { origin, concurrency = 2, onProgress } = {}) {
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
        if (['stylesheet', 'font', 'image', 'script'].includes(t)) seen.add(`${t}|${r.url()}`);
      });

      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

        // Drive the page so lazy content, carousels and reveal-on-scroll animations
        // have actually run before we read the DOM. Capturing at t=0 is how a static
        // scrape ends up with placeholder images and one slide out of five.
        await page.evaluate(async () => {
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
        });
        await page.waitForTimeout(500);

        const captured = await page.evaluate(
          ({ dropSel, dropAttr }) => {
            const doc = document;
            for (const sel of dropSel) doc.querySelectorAll(sel).forEach((n) => n.remove());

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

            const styleTags = [...doc.querySelectorAll('style')].map((s) => s.textContent ?? '');
            const cssLinks = [...doc.querySelectorAll('link[rel="stylesheet"][href]')].map((l) => l.href);
            const scripts = [...doc.querySelectorAll('script[src]')].map((s) => ({
              src: s.src, async: s.async, defer: s.defer, type: s.type || 'text/javascript'
            }));
            const inlineScripts = [...doc.querySelectorAll('script:not([src])')]
              .map((s) => ({ type: s.type || 'text/javascript', code: s.textContent ?? '' }));

            return {
              lang: doc.documentElement.lang || 'en',
              bodyClass: doc.body.className,
              bodyAttrs: Object.fromEntries([...doc.body.attributes].map((a) => [a.name, a.value])),
              htmlClass: doc.documentElement.className,
              tree: serialize(doc.body),
              styleTags,
              cssLinks,
              scripts,
              inlineScripts,
              title: doc.title,
              head: {
                meta: [...doc.querySelectorAll('meta')].map((m) =>
                  Object.fromEntries([...m.attributes].map((a) => [a.name, a.value]))),
                links: [...doc.querySelectorAll('link[rel]:not([rel="stylesheet"])')].map((l) =>
                  Object.fromEntries([...l.attributes].map((a) => [a.name, a.value])))
              }
            };
          },
          { dropSel: DROP_SELECTOR, dropAttr: [...DROP_ATTR] }
        );

        for (const s of seen) {
          const [kind, u] = s.split('|');
          if (kind === 'script' && DROP_SCRIPT.some((re) => re.test(u))) continue;
          addAsset(u, kind);
        }
        for (const l of captured.cssLinks) addAsset(l, 'stylesheet');
        for (const sc of captured.scripts) {
          if (!DROP_SCRIPT.some((re) => re.test(sc.src))) addAsset(sc.src, 'script');
        }

        const u = new URL(url);
        pages.push({
          url,
          path: u.pathname,
          ...captured,
          scripts: captured.scripts.filter((sc) => !DROP_SCRIPT.some((re) => re.test(sc.src))),
          inlineScripts: captured.inlineScripts.filter(
            (s) =>
              s.code.length < 40000 &&
              !DROP_SCRIPT.some((re) => re.test(s.code)) &&
              !DROP_INLINE.some((re) => re.test(s.code))
          )
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
