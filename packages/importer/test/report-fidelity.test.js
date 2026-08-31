import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gradeFidelityPage, writeFidelityReport } from '../src/report/fidelity.js';

const row = (over = {}) => ({
  path: '/', title: 'Home', sections: 6, componentized: true, nodes: 900,
  captureFailed: false, parityFallbacks: 0, mediaFailed: 0, unmerged: 0,
  visual: 0.998, text: 1, brokenImages: 0, scriptsFailed: 0, ...over
});

test('a page that did not render is a fail, not a warning', () => {
  const { grade, reasons } = gradeFidelityPage(row({ captureFailed: true }));
  assert.equal(grade, 'fail');
  assert.match(reasons.join(' '), /did not render/);
});

test('a broken image warns, and says so when the source was already broken', () => {
  // Measured on demos.kadencewp.com: six images 301 to a domain that then 404s. They were
  // broken before the migration and are reproduced exactly as broken. Grading that as a
  // migration defect reports the client's own dead link as our bug — so it warns, and the
  // reason names the cause rather than leaving the reader to guess.
  const atSource = gradeFidelityPage(row({ brokenImages: 6, sourceBroken: 6 }));
  assert.equal(atSource.grade, 'warn');
  assert.match(atSource.reasons.join(' '), /already 4xx on the source site/);

  const ours = gradeFidelityPage(row({ brokenImages: 2, sourceBroken: 0 }));
  assert.equal(ours.grade, 'warn');
  assert.match(ours.reasons.join(' '), /do not load in the migrated page/);
});

test('a parity fallback warns and names itself', () => {
  // Falling back to the runtime renderer still renders correctly — that is the whole point
  // of the fail-safe — so it is a warning, not a failure. But it must be visible: a silent
  // fallback is how a build quietly stops emitting the editable components it promised.
  const { grade, reasons } = gradeFidelityPage(row({ parityFallbacks: 2 }));
  assert.equal(grade, 'warn');
  assert.match(reasons.join(' '), /fell back to the runtime renderer/);
});

test('a fail is never downgraded by a later warning', () => {
  const { grade } = gradeFidelityPage(row({ captureFailed: true, visual: 0.5, mediaFailed: 3 }));
  assert.equal(grade, 'fail');
});

test('a clean page passes with no reasons', () => {
  const { grade, reasons } = gradeFidelityPage(row());
  assert.equal(grade, 'pass');
  assert.deepEqual(reasons, []);
});

test('missing measurements do not manufacture a warning', () => {
  // Before the score step runs, visual and text are null. Absence of evidence is not a
  // finding — grading it as one would make every fresh build look worse than it is.
  const { grade } = gradeFidelityPage(row({ visual: null, text: null }));
  assert.equal(grade, 'pass');
});

test('writeFidelityReport emits the shape the studio consumes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'underpin-report-'));
  mkdirSync(join(dir, '_migration'), { recursive: true });
  writeFileSync(join(dir, 'migration.plan.json'), JSON.stringify({ inScopeUrls: [] }));
  writeFileSync(join(dir, 'generate-result.json'), JSON.stringify({
    mode: 'fidelity',
    componentize: true,
    targets: { count: 2, source: 'selected' },
    routes: [
      { path: '/', url: 'https://x.test/', key: 'index', title: 'Home', componentized: true, sections: 5, nodes: 900, sheets: 12, scripts: 20 },
      { path: '/about/', url: 'https://x.test/about/', key: 'about', title: '', componentized: true, sections: 3, nodes: 400, sheets: 12, scripts: 18 }
    ],
    media: { total: 40, downloaded: 40, failed: [] },
    captureFailures: [],
    parity: { sections: 8, ok: 8, fallbacks: [] }
  }));

  await writeFidelityReport(dir, 'https://x.test/');

  const report = JSON.parse(readFileSync(join(dir, '_migration', 'report.json'), 'utf8'));
  assert.equal(report.rows.length, 2);
  assert.equal(report.counts.pass + report.counts.warn + report.counts.fail, 2);
  // The missing title on /about/ is the only finding, so exactly one row warns.
  assert.equal(report.counts.warn, 1);

  const html = readFileSync(join(dir, '_migration', 'report.html'), 'utf8');
  assert.match(html, /Design fidelity/);
  assert.match(html, /Content fidelity/);
  // ADR #7: the two scores are reported side by side and never averaged. A blended number
  // would hide exactly the failure a reviewer needs to see.
  assert.match(html, /never averaged/);
  assert.match(html, /2 pages you selected/);

  const preview = readFileSync(join(dir, '_migration', 'preview.html'), 'utf8');
  assert.match(preview, /5 sections/);
});
