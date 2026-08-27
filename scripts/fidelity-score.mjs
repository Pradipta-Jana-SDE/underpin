#!/usr/bin/env node
/**
 * Measures how close a migrated page is to its original.
 *
 * "Looks the same" is an opinion until it has a number attached. This produces one, at
 * three viewport widths, and reports the parts separately because they fail for different
 * reasons: pixels catch styling and layout, text catches lost content, and node counts
 * catch a subtree that never rendered.
 *
 *   node scripts/fidelity-score.mjs <originUrl> <migratedBase> [path ...]
 *   node scripts/fidelity-score.mjs https://example.com http://localhost:4400/preview/example-fidelity / /about/
 */
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { mkdirSync, writeFileSync } from 'node:fs';

const [, , origin, migratedBase, ...paths] = process.argv;
if (!origin || !migratedBase) {
  console.error('usage: fidelity-score.mjs <originUrl> <migratedBase> [path ...]');
  process.exit(1);
}
const targets = paths.length ? paths : ['/'];
const WIDTHS = [375, 768, 1440];
const OUT = '.shots/diff';
mkdirSync(OUT, { recursive: true });

const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Everything we need from one render, in a single pass. */
async function probe(browser, url, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  const failed = [];
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().slice(0, 80)}`); });

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
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
    // Freeze video and CSS animation on BOTH sides before capture. A hero <video> plays
    // independently in each browser, so two playbacks never show the same frame — that
    // alone drags a pixel-perfect migration down to ~65% and says nothing about
    // migration quality. Pausing at frame 0 makes the comparison mean something.
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

/** Share of source words that survive into the migrated page. */
function textCoverage(source, migrated) {
  const words = (s) => new Set(clean(s).toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 3));
  const a = words(source);
  if (!a.size) return 1;
  const b = words(migrated);
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit / a.size;
}

function pixelDelta(aBuf, bBuf, label) {
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
  writeFileSync(`${OUT}/${label}.png`, PNG.sync.write(diff));
  return { changed, total: w * h, ratio: changed / (w * h) };
}

const bar = (v) => {
  const n = Math.round(v * 20);
  return '█'.repeat(n) + '░'.repeat(20 - n);
};
const pct = (v) => `${(v * 100).toFixed(1)}%`;

const browser = await chromium.launch();
const rows = [];

for (const path of targets) {
  for (const width of WIDTHS) {
    const label = `${path.replace(/[^a-z0-9]/gi, '_') || 'root'}-${width}`;
    const [src, mig] = await Promise.all([
      probe(browser, new URL(path, origin).toString(), width),
      probe(browser, migratedBase.replace(/\/$/, '') + path, width)
    ]);

    if (!src.ok || !mig.ok) {
      rows.push({ path, width, error: src.error ?? mig.error });
      continue;
    }

    const px = pixelDelta(src.shot, mig.shot, label);
    rows.push({
      path, width,
      visual: 1 - px.ratio,
      text: textCoverage(src.text, mig.text),
      nodes: Math.min(mig.nodes / Math.max(src.nodes, 1), 1),
      heightDelta: Math.abs(mig.height - src.height) / Math.max(src.height, 1),
      srcSheets: src.sheets, migSheets: mig.sheets,
      srcImages: src.images, migImages: mig.images,
      brokenImages: mig.brokenImages,
      srcFonts: src.fonts, migFonts: mig.fonts,
      failed: mig.failed
    });
  }
}
await browser.close();

console.log(`\n  original : ${origin}`);
console.log(`  migrated : ${migratedBase}\n`);

for (const r of rows) {
  if (r.error) { console.log(`  ${r.path} @${r.width}  FAILED — ${r.error.slice(0, 70)}`); continue; }
  console.log(`  ${r.path} @ ${r.width}px`);
  console.log(`     visual   ${bar(r.visual)} ${pct(r.visual)}`);
  console.log(`     text     ${bar(r.text)} ${pct(r.text)}`);
  console.log(`     nodes    ${bar(r.nodes)} ${pct(r.nodes)}   (${r.srcSheets} → ${r.migSheets} stylesheets)`);
  console.log(`     images   ${r.srcImages} → ${r.migImages}${r.brokenImages ? `  ${r.brokenImages} BROKEN` : ''}`);
  if (Math.abs(r.heightDelta) > 0.05) console.log(`     height   ${pct(r.heightDelta)} different`);
  if (r.srcFonts.join() !== r.migFonts.join()) console.log(`     fonts    ${r.srcFonts.join(', ')}  →  ${r.migFonts.join(', ')}`);
  if (r.failed.length) console.log(`     failed   ${r.failed[0]}`);
  console.log('');
}

const ok = rows.filter((r) => !r.error);
if (ok.length) {
  const avg = (k) => ok.reduce((a, r) => a + r[k], 0) / ok.length;
  console.log(`  ── overall ────────────────────────────────`);
  console.log(`     visual fidelity  ${pct(avg('visual'))}`);
  console.log(`     text coverage    ${pct(avg('text'))}`);
  console.log(`     node coverage    ${pct(avg('nodes'))}`);
  console.log(`\n  diff images → ${OUT}/\n`);
}
