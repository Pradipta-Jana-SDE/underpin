import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Measures how close a migrated page is to its original, at three viewport widths.
 *
 * The parts are reported separately because they fail for different reasons: pixels catch
 * styling and layout, text catches lost content, node counts catch a subtree that never
 * rendered. Shared with the CLI (scripts/fidelity-score.mjs) so verify and the command line
 * cannot drift into two different definitions of fidelity.
 */

/**
 * Grading thresholds, tuned against the demo migrations and shared with report/fidelity.js.
 *
 * The visual bar cannot be 1.0: two renders of the same URL differ by antialiasing, font
 * hinting and subpixel text positioning, so a 100% bar grades noise. 0.92 sits above that
 * floor and below what anyone notices side by side; under 0.85 something structural moved.
 *
 * Text and node coverage sit higher — words either survived or they did not. The residual
 * few percent are nav labels and cookie banners rendering from a different source.
 */
export const VISUAL_PASS = 0.92;
export const VISUAL_WARN = 0.85;
export const TEXT_PASS = 0.95;
export const NODES_PASS = 0.95;

/**
 * How far below its pass bar a dimension may fall and still warn rather than fail. Derived
 * from the visual bars, so there is one tuned band and every dimension shares its slope.
 */
const WARN_BAND = VISUAL_PASS - VISUAL_WARN;

/** Where diff images land when the caller has no site directory to put them in. */
const DEFAULT_DIFF_DIR = '.shots/diff';

const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

/* ------------------------------------------------------------------ pure helpers */

/**
 * Share of source words surviving into the migrated page. Words under four characters are
 * dropped — "the" and "and" appear everywhere and would float the score for a page that
 * lost all its real copy. Set membership, not sequence: a paragraph that moved is not lost.
 */
export function textCoverage(source, migrated) {
  const words = (s) => new Set(clean(s).toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 3));
  const a = words(source);
  if (!a.size) return 1;
  const b = words(migrated);
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit / a.size;
}

/**
 * One ordinal grade from the three scores: 'pass' | 'warn' | 'fail'. The worst dimension
 * decides — a minimum, never a mean. ADR #7: content and design fidelity answer different
 * questions and a blended 85 hides the failure a reviewer needs to see. Unmeasured
 * dimensions are skipped, not guessed.
 */
export function gradeScore({ visual, text, nodes } = {}) {
  const rank = { pass: 0, warn: 1, fail: 2 };
  const of = (v, bar) => {
    if (typeof v !== 'number' || Number.isNaN(v)) return 'pass';
    if (v >= bar) return 'pass';
    return v >= bar - WARN_BAND ? 'warn' : 'fail';
  };
  return [of(visual, VISUAL_PASS), of(text, TEXT_PASS), of(nodes, NODES_PASS)].reduce(
    (worst, g) => (rank[g] > rank[worst] ? g : worst),
    'pass'
  );
}

/**
 * The three means across every successful measurement — and no fourth key. A combined
 * number is the one thing ADR #7 forbids, and it is always one line away, so the shape is
 * asserted in the tests rather than trusted.
 */
export function summarize(pages) {
  const all = pages ?? [];
  const ok = all.filter((p) => !p.error);
  const mean = (k) => (ok.length ? ok.reduce((a, p) => a + p[k], 0) / ok.length : null);
  // `measured` travels with the means and callers print it. A mean over the pages that
  // happened to load scores a subset, not the migration — reporting 100% while half the
  // pages failed to render is exactly the kind of averaging this project refuses.
  return {
    visual: mean('visual'),
    text: mean('text'),
    nodes: mean('nodes'),
    measured: ok.length,
    total: all.length,
    failed: all.filter((p) => p.error).map((p) => ({ path: p.path, width: p.width, error: String(p.error).split('\n')[0] }))
  };
}

/* ------------------------------------------------------------------ measurement */

/**
 * Loads the browser and image stack lazily. playwright is optional and pngjs/pixelmatch live
 * at the workspace root, so a machine that skipped the browser download has none of them.
 * A module-scope import would take the whole verify stage, and its tests, down with it.
 */
async function loadRenderDeps() {
  const load = async (name, pick) => {
    try {
      return pick(await import(name));
    } catch (cause) {
      const err = new Error(`${name} not installed`);
      err.missing = name;
      err.cause = cause;
      throw err;
    }
  };
  return {
    chromium: await load('playwright', (m) => m.chromium),
    PNG: await load('pngjs', (m) => m.PNG),
    pixelmatch: await load('pixelmatch', (m) => m.default ?? m)
  };
}

/** Everything we need from one render, in a single pass. */
async function probe(browser, url, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  const failed = [];
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().slice(0, 80)}`); });

  try {
    // Same lesson capture learned: a real marketing site never reaches network idle —
    // analytics and chat widgets keep it busy — so waiting times out and the page goes
    // unmeasured, which used to vanish from the average and leave a confident 100%.
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
    } catch {
      await page.goto(url, { waitUntil: 'load', timeout: 45000 });
      await page.waitForTimeout(2500);
    }
    // Drive lazy-load and scroll animations so both sides are compared in the same state.
    await page.evaluate(async () => {
      await new Promise((done) => {
        let y = 0;
        const step = () => {
          y += window.innerHeight * 0.8;
          window.scrollTo(0, y);
          if (y < document.body.scrollHeight) setTimeout(step, 70);
          else { window.scrollTo(0, 0); setTimeout(done, 400); }
        };
        step();
      });
    });
    // Freeze video and CSS animation on both sides. A hero <video> plays independently in
    // each browser, so two playbacks never show the same frame — that alone drags a
    // pixel-perfect migration to ~65% and says nothing about the migration.
    await page.evaluate(() => {
      for (const v of document.querySelectorAll('video')) {
        try { v.pause(); v.currentTime = 0; } catch { /* not seekable */ }
      }
      const style = document.createElement('style');
      style.textContent =
        '*,*::before,*::after{animation-play-state:paused !important;' +
        'transition:none !important;caret-color:transparent !important}';
      document.head.appendChild(style);
    });
    await page.waitForTimeout(1400);

    // Wait for images to finish. A hero photo still decoding when the shutter opens reads
    // as a defect: the same page measured 81.7% on one run and 99.5% on the next, purely on
    // whether a background had painted.
    await page
      .waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 8000 })
      .catch(() => { /* a genuinely broken image never completes; it is counted below */ });
    // One more frame so the decoded image is actually painted.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const facts = await page.evaluate(() => ({
      nodes: document.querySelectorAll('*').length,
      text: document.body.innerText,
      images: [...document.images].filter((i) => i.naturalWidth > 0).length,
      brokenImages: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).length,
      height: document.body.scrollHeight,
      // A page with no author stylesheet is the classic "renders unstyled" failure.
      sheets: document.styleSheets.length,
      fonts: [...new Set([...document.querySelectorAll('h1,h2,p,a')]
        .map((e) => getComputedStyle(e).fontFamily.split(',')[0].replace(/['"]/g, '').trim())
        .filter(Boolean))].slice(0, 4)
    }));

    const shot = await page.screenshot({ fullPage: false });
    return { ok: true, ...facts, shot, failed: failed.slice(0, 5) };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err), failed };
  } finally {
    await ctx.close();
  }
}

/**
 * Pixel delta between two screenshots, cropped to their common rectangle. Cropped, not
 * scaled: a page one pixel wider is a one-pixel bug, and resampling would smear that
 * across every edge in the image and report a much larger one.
 */
function pixelDelta({ PNG, pixelmatch }, aBuf, bBuf, outFile) {
  const a = PNG.sync.read(aBuf);
  const b = PNG.sync.read(bBuf);
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const crop = (src) => {
    const out = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) src.data.copy(out.data, y * w * 4, y * src.width * 4, y * src.width * 4 + w * 4);
    return out;
  };
  const ca = crop(a);
  const cb = crop(b);
  const diff = new PNG({ width: w, height: h });
  const changed = pixelmatch(ca.data, cb.data, diff.data, w, h, { threshold: 0.12, includeAA: false });
  writeFileSync(outFile, PNG.sync.write(diff));
  return { changed, total: w * h, ratio: changed / (w * h) };
}

/**
 * Scores every path at every width and, given an outDir, writes _migration/score.json.
 *
 * `loadDeps` is injectable so a machine with no browser can prove this returns
 * `{ skipped: true }` rather than exploding — without needing a browser to prove it.
 *
 * Returns `{ pages, overall, diffs }`, or `{ skipped, reason }`. `pages` holds one row per
 * path *and* per width; report/fidelity.js reads it that way.
 */
export async function scorePages({
  origin,
  migratedBase,
  paths,
  widths = [375, 768, 1440],
  outDir,
  onProgress,
  loadDeps = loadRenderDeps
} = {}) {
  let deps;
  try {
    deps = await loadDeps();
  } catch (err) {
    // Never throw. No browser means "not measured", not a dead verify stage — and not a
    // zero either, which reads as a failed migration rather than an absent measurement.
    return {
      skipped: true,
      reason: err?.missing ? `${err.missing} not installed` : 'playwright not installed',
      detail: String(err?.message ?? err),
      pages: [],
      overall: { visual: null, text: null, nodes: null }
    };
  }

  const targets = paths?.length ? paths : ['/'];
  const diffs = outDir ? join(outDir, '_migration', 'diffs') : DEFAULT_DIFF_DIR;
  mkdirSync(diffs, { recursive: true });

  const browser = await deps.chromium.launch();
  const rows = [];
  const total = targets.length * widths.length;
  let done = 0;

  try {
    for (const path of targets) {
      for (const width of widths) {
        const label = `${path.replace(/[^a-z0-9]/gi, '_') || 'root'}-${width}`;
        const [src, mig] = await Promise.all([
          probe(browser, new URL(path, origin).toString(), width),
          probe(browser, migratedBase.replace(/\/$/, '') + path, width)
        ]);

        if (!src.ok || !mig.ok) {
          rows.push({ path, width, error: src.error ?? mig.error });
        } else {
          const px = pixelDelta(deps, src.shot, mig.shot, join(diffs, `${label}.png`));
          const row = {
            path, width,
            visual: 1 - px.ratio,
            text: textCoverage(src.text, mig.text),
            nodes: Math.min(mig.nodes / Math.max(src.nodes, 1), 1),
            heightDelta: Math.abs(mig.height - src.height) / Math.max(src.height, 1),
            srcSheets: src.sheets, migSheets: mig.sheets,
            srcImages: src.images, migImages: mig.images,
            brokenImages: mig.brokenImages,
            srcFonts: src.fonts, migFonts: mig.fonts,
            failed: mig.failed,
            diff: join(diffs, `${label}.png`)
          };
          rows.push({ ...row, grade: gradeScore(row) });
        }

        done += 1;
        onProgress?.({ done, total, path, width });
      }
    }
  } finally {
    // Closed in a finally: an unreachable origin halfway through a twelve-page run must not
    // leave a headless Chromium alive on the operator's machine.
    await browser.close();
  }

  const overall = summarize(rows);
  const result = {
    origin,
    migratedBase,
    widths,
    generatedAt: new Date().toISOString(),
    pages: rows,
    overall,
    // An ordinal label, not a blended score. gradeScore takes the worst dimension, so this
    // is only ever as good as the weakest measurement — ADR #7 forbids the mean, not a summary.
    grade: gradeScore(overall),
    diffs
  };

  if (outDir) {
    const file = join(outDir, '_migration', 'score.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(result, null, 2));
    result.file = file;
  }

  return result;
}
