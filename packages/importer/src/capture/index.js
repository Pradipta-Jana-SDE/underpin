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

/**
 * `document.write` after load triggers an implicit `document.open()` and erases the
 * page. Every script we re-inject runs post-load by construction, so any script using it
 * is in the blast radius — dropped loudly rather than silently.
 */
export const DOC_WRITE = /document\s*\.\s*write(ln)?\s*\(/;

/** Inline snippets that are pure WordPress cruft and carry hostile characters. */
const DROP_INLINE = [
  /_wpemojiSettings/i,      // unpaired surrogates; breaks strict JSON parsers
  /wp-emoji/i,
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
        // 'media' matters: without it a hero <video src> is never mirrored and keeps
        // pointing at the WordPress origin, which fails origin-independence outright.
        if (['stylesheet', 'font', 'image', 'script', 'media'].includes(t)) seen.add(`${t}|${r.url()}`);
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
        for (const sh of captured.sheets) if (sh.kind === 'link') addAsset(sh.href, 'stylesheet');
        for (const sc of captured.scriptsOrdered) {
          if (sc.kind === 'external' && !DROP_SCRIPT.some((re) => re.test(sc.src))) addAsset(sc.src, 'script');
        }

        const u = new URL(url);
        pages.push({
          url,
          path: u.pathname,
          ...captured,
          scriptsOrdered: captured.scriptsOrdered
            .filter((sc) =>
              sc.kind === 'external'
                ? !DROP_SCRIPT.some((re) => re.test(sc.src))
                : sc.code.length < 60000 &&
                  !DROP_INLINE.some((re) => re.test(sc.code)) &&
                  !DOC_WRITE.test(sc.code)
            )
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
