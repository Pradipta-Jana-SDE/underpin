/**
 * Does the migrated page actually still work?
 *
 * Every other acceptance check reads files. Files cannot tell you whether the site's own
 * scripts booted, whether a carousel initialised, or whether the reveal animations ran —
 * and those are exactly what fidelity mode promises. A page can pass all six file checks,
 * score 100% on a frozen screenshot, and be completely inert.
 *
 * So this one loads the built page in a real browser and asks it directly.
 */

/** Beacons that are referrer-locked to the old domain by design. Their 404s are expected. */
const THIRD_PARTY_NOISE = /googletagmanager|google-analytics|facebook\.net|hotjar|doubleclick|analytics|clarity\.ms|segment|intercom|recaptcha/i;

/** Classes the common reveal and carousel libraries add once they have initialised. */
const RUN_MARKERS = [
  '.aos-animate', '.is-inview', '.in-view', '.animated', '.wow.animated',
  '.swiper-initialized', '.slick-initialized', '.elementor-animated',
  '[data-elementor-type] .animated', '.splide--slide.is-initialized'
].join(',');

/** Elements that declare a reveal but have not received their "played" class. */
const STUCK = { declared: '[data-aos]', played: '[data-aos].aos-animate' };

export async function smokeCheck({ migratedBase, paths, width = 1440, loadDeps } = {}) {
  let chromium;
  try {
    ({ chromium } = loadDeps ? await loadDeps() : await import('playwright'));
  } catch (err) {
    return { skipped: true, reason: 'playwright not installed', pages: [], pass: true };
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
  const pages = [];

  try {
    for (const path of paths) {
      const page = await ctx.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const text = m.text();
        if (!THIRD_PARTY_NOISE.test(text)) consoleErrors.push(text.slice(0, 200));
      });
      page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 200)));

      // "Failed to load resource" without the URL is not a diagnosis. The console message
      // omits it, so the response is where the answer has to come from.
      const badRequests = [];
      page.on('response', (r) => {
        if (r.status() < 400) return;
        const u = r.url();
        if (!THIRD_PARTY_NOISE.test(u)) badRequests.push(`${r.status()} ${u}`);
      });

      try {
        await page.goto(migratedBase.replace(/\/$/, '') + path, { waitUntil: 'load', timeout: 45000 });
        // The replay runs in an effect after mount, and awaits each external in turn.
        await page.waitForTimeout(2500);

        const before = await page.evaluate((sel) => document.querySelectorAll(sel).length, RUN_MARKERS);

        await page.evaluate(async () => {
          await new Promise((done) => {
            let y = 0;
            const step = () => {
              y += window.innerHeight * 0.8;
              window.scrollTo(0, y);
              if (y < document.body.scrollHeight) setTimeout(step, 90);
              else { window.scrollTo(0, 0); setTimeout(done, 400); }
            };
            step();
          });
        });
        await page.waitForTimeout(800);

        const after = await page.evaluate((sel) => document.querySelectorAll(sel).length, RUN_MARKERS);
        const stuck = await page.evaluate((s) => {
          const declared = document.querySelectorAll(s.declared).length;
          const played = document.querySelectorAll(s.played).length;
          return { declared, played, ratio: declared ? (declared - played) / declared : 0 };
        }, STUCK);
        const scripts = await page.evaluate(() => window.__underpin ?? null);

        const row = {
          path,
          consoleErrors,
          pageErrors,
          scripts,
          badRequests,
          animatedBefore: before,
          animatedAfterScroll: after,
          revealStuck: stuck,
          pass: true,
          reasons: []
        };

        if (pageErrors.length) { row.pass = false; row.reasons.push(`${pageErrors.length} uncaught error(s): ${pageErrors[0]}`); }
        if (badRequests.length) {
          row.pass = false;
          row.reasons.push(`${badRequests.length} request(s) failed: ${badRequests.slice(0, 3).join(', ')}`);
        } else if (consoleErrors.length) {
          row.pass = false;
          row.reasons.push(`${consoleErrors.length} console error(s): ${consoleErrors[0]}`);
        }
        if (!scripts) {
          row.pass = false;
          row.reasons.push('the script replay never ran — no counter was installed on the page');
        } else {
          if (scripts.total && scripts.ran + scripts.failed < scripts.total) {
            row.pass = false;
            row.reasons.push(`replay stalled at ${scripts.ran + scripts.failed}/${scripts.total} scripts`);
          }
          if (scripts.total && scripts.failed / scripts.total > 0.1) {
            row.pass = false;
            row.reasons.push(`${scripts.failed}/${scripts.total} scripts failed to load`);
          }
        }
        // The Phase-3 safety net. Reveal elements that never receive their played class are
        // sitting at opacity:0 — invisible content, and the one way virgin capture can make
        // a page worse rather than better.
        if (stuck.declared && stuck.ratio > 0.3) {
          row.pass = false;
          row.reasons.push(`${stuck.declared - stuck.played}/${stuck.declared} reveal elements never animated in — rebuild with --no-virgin`);
        }

        pages.push(row);
      } catch (err) {
        pages.push({ path, pass: false, reasons: [String(err?.message ?? err)], consoleErrors, pageErrors, badRequests });
      } finally {
        await page.close();
      }
    }
  } finally {
    await ctx.close();
    await browser.close();
  }

  return { skipped: false, pages, pass: pages.every((p) => p.pass) };
}
