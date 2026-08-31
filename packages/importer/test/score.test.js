import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  textCoverage,
  gradeScore,
  summarize,
  scorePages,
  VISUAL_PASS,
  VISUAL_WARN,
  TEXT_PASS,
  NODES_PASS
} from '../src/verify/score.js';

/**
 * Pure-function tests only. Everything here runs on a machine with no browser installed,
 * which is the whole reason the measurement core was pulled out of the CLI script: a check
 * that needs Chromium to prove its arithmetic is a check nobody runs in CI.
 */

test('text coverage is the share of real source words that survive', () => {
  // Hand-counted. Words of four characters or more, deduplicated, lowercased:
  //   underpin migrates wordpress sites into react without plugins  → 8
  // "the" is three characters and is dropped: it appears on every page ever written and
  // would float the score for a page that lost all of its actual copy.
  const source = 'Underpin migrates WordPress sites into React without the plugins';

  // Six of the eight survive; "without" and "plugins" are gone.
  assert.equal(textCoverage(source, 'Underpin migrates WordPress sites into React'), 6 / 8);

  // Set membership, not sequence — a paragraph that moved is not a paragraph that was lost.
  assert.equal(textCoverage(source, 'plugins without React into sites WordPress migrates Underpin'), 1);

  // Repetition on either side cannot inflate the number.
  assert.equal(textCoverage('Pricing pricing PRICING plans', 'plans and pricing'), 1);

  // A page whose source has no scoreable words is not a 0% migration; there was nothing
  // to lose. Returning 0 here would flag every icon-only page as a total content failure.
  assert.equal(textCoverage('a of to', 'anything at all'), 1);
});

test('grade is the worst dimension, never the average of them', () => {
  assert.equal(gradeScore({ visual: 0.93, text: 0.97, nodes: 0.99 }), 'pass');
  assert.equal(gradeScore({ visual: 0.80, text: 0.97, nodes: 0.99 }), 'fail');
  assert.equal(gradeScore({ visual: 0.88, text: 0.97, nodes: 0.99 }), 'warn');

  // Exactly on a bar passes; a hair under does not.
  assert.equal(gradeScore({ visual: VISUAL_PASS, text: TEXT_PASS, nodes: NODES_PASS }), 'pass');
  assert.equal(gradeScore({ visual: VISUAL_WARN, text: TEXT_PASS, nodes: NODES_PASS }), 'warn');

  // The point of a minimum rather than a mean: perfect pixels cannot carry lost content.
  // Averaged, a page that dropped half its copy would score 0.79 and read as a near miss.
  assert.equal(gradeScore({ visual: 1, text: 0.5, nodes: 1 }), 'fail');
  assert.equal(gradeScore({ visual: 1, text: 1, nodes: 0.5 }), 'fail');

  // A dimension that was not measured is skipped, not guessed at as a zero.
  assert.equal(gradeScore({ visual: 0.99, text: null, nodes: undefined }), 'pass');
});

test('the summary exposes three scores and no blended one', () => {
  const rows = [
    { path: '/', width: 1440, visual: 0.9, text: 1.0, nodes: 0.98 },
    { path: '/pricing/', width: 1440, visual: 0.8, text: 0.9, nodes: 0.92 },
    { path: '/gone/', width: 1440, error: 'net::ERR_CONNECTION_REFUSED' }
  ];
  const overall = summarize(rows);

  // Failed measurements are excluded rather than counted as zeros — an unreachable page is
  // a reporting problem, and folding it in would make the two that rendered look worse.
  // Compared with a tolerance because these are means of binary floats, and 0.85 is not one.
  const close = (actual, expected, what) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: expected ~${expected}, got ${actual}`);
  close(overall.visual, 0.85, 'visual');
  close(overall.text, 0.95, 'text');
  close(overall.nodes, 0.95, 'nodes');

  // Guards ADR #7 — "Two fidelity scores, never blended. Content Fidelity and Design
  // Fidelity answer different questions; averaging them hides the failure a reviewer needs
  // to see." A single combined number is one line away at all times, so its absence is
  // asserted rather than trusted: these rows would blend to a comfortable 0.92 and bury a
  // page rendering at 80%.
  for (const blended of ['score', 'combined', 'fidelity', 'average', 'overall']) {
    assert.equal(overall[blended], undefined, `a blended "${blended}" reappeared`);
  }
  assert.equal(overall.score, undefined);
  assert.equal(overall.overall, undefined);
  assert.equal(overall.combined, undefined);
  assert.equal(overall.fidelity, undefined);

  // Coverage travels with the means. Excluding a failed page from the average is right;
  // reporting the result as if every page had been measured is not — a confident 100%
  // over the half of the site that happened to load is the same class of lie as blending
  // the two scores together.
  assert.equal(overall.measured, 2);
  assert.equal(overall.total, 3);
  assert.deepEqual(overall.failed.map((f) => f.path), ['/gone/']);
});

test('a machine with no browser reports "not measured" instead of throwing', async () => {
  // playwright is an optionalDependency, so this is the ordinary state of a clean CI
  // install — not an edge case. Throwing here would take down a verify stage whose other
  // six checks ran perfectly well without a browser.
  const result = await scorePages({
    origin: 'https://example.com',
    migratedBase: 'http://localhost:4400',
    paths: ['/'],
    loadDeps: async () => { throw new Error("Cannot find package 'playwright'"); }
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'playwright not installed');
  assert.deepEqual(result.pages, [], 'callers iterate pages unconditionally; it must exist');
});

test('a missing image library is guarded the same way as a missing browser', async () => {
  // pngjs and pixelmatch are hoisted workspace-root deps that a package-level install can
  // miss. Same failure mode, same answer, and the reason names the module so the fix is
  // obvious rather than a guess at which of the three is absent.
  const missing = new Error('pngjs not installed');
  missing.missing = 'pngjs';

  const result = await scorePages({
    origin: 'https://example.com',
    migratedBase: 'http://localhost:4400',
    loadDeps: async () => { throw missing; }
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'pngjs not installed');
});
