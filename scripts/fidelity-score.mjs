#!/usr/bin/env node
/**
 * Measures how close a migrated page is to its original, at three viewport widths.
 *
 * The parts are reported separately because they fail for different reasons: pixels catch
 * styling and layout, text catches lost content, node counts catch a subtree that never
 * rendered.
 *
 *   node scripts/fidelity-score.mjs <originUrl> <migratedBase> [path ...]
 *   node scripts/fidelity-score.mjs https://example.com http://localhost:4400/preview/example-fidelity / /about/
 *
 * The measuring itself lives in packages/importer/src/verify/score.js, so the verify stage
 * and this CLI cannot drift into disagreeing about what "fidelity" means. Everything below
 * is presentation.
 */
import { scorePages } from '../packages/importer/src/verify/score.js';

const [, , origin, migratedBase, ...paths] = process.argv;
if (!origin || !migratedBase) {
  console.error('usage: fidelity-score.mjs <originUrl> <migratedBase> [path ...]');
  process.exit(1);
}

const bar = (v) => {
  const n = Math.round(v * 20);
  return '█'.repeat(n) + '░'.repeat(20 - n);
};
const pct = (v) => `${(v * 100).toFixed(1)}%`;

const result = await scorePages({ origin, migratedBase, paths });

if (result.skipped) {
  // Not a failed migration — an absent measurement. Saying so plainly beats printing a
  // zero that reads like the site is broken.
  console.error(`\n  not measured — ${result.reason}`);
  console.error('  install the browser stack with: npx playwright install chromium\n');
  process.exit(1);
}

const rows = result.pages;

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
  // Three numbers, printed apart. ADR #7: averaging Content Fidelity into Design Fidelity
  // hides the one a reviewer needs to see.
  console.log(`  ── overall ────────────────────────────────`);
  console.log(`     visual fidelity  ${pct(result.overall.visual)}`);
  console.log(`     text coverage    ${pct(result.overall.text)}`);
  console.log(`     node coverage    ${pct(result.overall.nodes)}`);
  console.log(`\n  diff images → ${result.diffs}/\n`);
}
