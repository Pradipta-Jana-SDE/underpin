import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { esc, bar, REPORT_CSS, renderPreviewPage } from './shell.js';

const read = (p, fallback = null) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);

/**
 * The report for a fidelity build.
 *
 * Deliberately not the template-mode report with different numbers in it. Template mode
 * asks "did every section find a home in a component library" — a question about meaning.
 * Fidelity mode asks "is this the same page" — a question about pixels, nodes and whether
 * the site's own scripts still run. Sharing a table would force one set of columns to lie.
 *
 * Before this existed a fidelity run produced no report at all: the CLI's fidelity branch
 * skipped extraction, and the report stage had nothing to describe. A build with no
 * artefact beside it is a site ripper, not an engineering deliverable.
 */

/** pass / warn / fail for one migrated page, with the reason spelled out. */
export function gradeFidelityPage(row) {
  const reasons = [];
  let grade = 'pass';
  const worse = (g) => (grade === 'fail' ? 'fail' : g);

  if (row.captureFailed) { grade = 'fail'; reasons.push('page did not render in the browser'); }
  if (row.componentized && row.sections === 0) { grade = 'fail'; reasons.push('componentisation produced no sections'); }
  if (row.brokenImages > 0) {
    // Deliberately a warning, not a failure. An image whose URL was already 4xx on the
    // source cannot be mirrored and is reproduced exactly as broken as it was — grading
    // that as a migration defect reports the client's own broken link as our bug.
    grade = worse('warn');
    reasons.push(
      row.sourceBroken
        ? `${row.brokenImages} image(s) do not load — ${row.sourceBroken} asset(s) were already 4xx on the source site`
        : `${row.brokenImages} image(s) do not load in the migrated page`
    );
  }

  if (row.parityFallbacks > 0) {
    grade = worse('warn');
    reasons.push(`${row.parityFallbacks} section(s) fell back to the runtime renderer instead of emitting JSX`);
  }
  if (row.mediaFailed > 0) { grade = worse('warn'); reasons.push(`${row.mediaFailed} asset(s) could not be re-hosted`); }
  if (row.visual != null && row.visual < 0.92) { grade = worse('warn'); reasons.push(`visual match ${(row.visual * 100).toFixed(1)}%`); }
  if (row.text != null && row.text < 0.95) { grade = worse('warn'); reasons.push(`content match ${(row.text * 100).toFixed(1)}%`); }
  if (row.unmerged > 0) { grade = worse('warn'); reasons.push(`${row.unmerged} node(s) shifted between the two capture passes`); }
  if (row.scriptsFailed > 0) { grade = worse('warn'); reasons.push(`${row.scriptsFailed} replayed script(s) failed to load`); }
  if (!row.title) { grade = worse('warn'); reasons.push('no title tag captured'); }

  return { grade, reasons };
}

export async function writeFidelityReport(outDir, siteUrl) {
  const plan = read(join(outDir, 'migration.plan.json'));
  const generated = read(join(outDir, 'generate-result.json'), {});
  const fp = read(join(outDir, 'fingerprint.json'), {});
  const score = read(join(outDir, '_migration', 'score.json'));
  const smoke = read(join(outDir, '_migration', 'smoke.json'));

  // Score entries are per path AND per width; the report shows the desktop measurement,
  // because that is the width the capture was taken at and therefore the only one where a
  // difference is unambiguously the migration's fault rather than a responsive re-flow.
  const scoreByPath = new Map();
  for (const p of score?.pages ?? []) {
    if (p.width === 1440 || !scoreByPath.has(p.path)) scoreByPath.set(p.path, p);
  }
  const smokeByPath = new Map((smoke?.pages ?? []).map((p) => [p.path, p]));

  const failedUrls = new Set((generated.captureFailures ?? []).map((f) => f.url ?? f));
  // Assets the source itself refused to serve. Counted once for the whole build: the score
  // reports broken images per page but not which URLs, so this is the honest granularity.
  const sourceBroken = (generated.media?.failed ?? []).filter((f) => f.status >= 400 && f.status < 500).length;
  const parityByKey = new Map();
  for (const f of generated.parity?.fallbacks ?? []) {
    parityByKey.set(f.key, (parityByKey.get(f.key) ?? 0) + 1);
  }

  const rows = (generated.routes ?? []).map((r) => {
    const s = scoreByPath.get(r.path);
    const k = smokeByPath.get(r.path);
    const row = {
      path: r.path,
      url: r.url,
      key: r.key,
      title: r.title,
      sections: r.sections ?? 0,
      componentized: !!r.componentized,
      nodes: r.nodes ?? 0,
      sheets: r.sheets ?? 0,
      scripts: r.scripts ?? 0,
      captureFailed: failedUrls.has(r.url),
      parityFallbacks: parityByKey.get(r.key) ?? 0,
      mediaFailed: 0,
      unmerged: generated.captureDiagnostics?.byPath?.[r.path]?.unmerged ?? 0,
      visual: s?.visual ?? null,
      text: s?.text ?? null,
      nodeRatio: s?.nodes ?? null,
      brokenImages: s?.brokenImages ?? 0,
      sourceBroken,
      scriptsRan: k?.scripts?.ran ?? null,
      scriptsTotal: k?.scripts?.total ?? null,
      scriptsFailed: k?.scripts?.failed ?? 0
    };
    return { ...row, ...gradeFidelityPage(row) };
  });

  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const r of rows) counts[r.grade]++;

  const outMigration = join(outDir, '_migration');
  mkdirSync(outMigration, { recursive: true });

  const reportPath = join(outMigration, 'report.html');
  writeFileSync(reportPath, renderFidelityReport({ siteUrl, plan, rows, counts, generated, fp, score }));

  const previewPath = join(outMigration, 'preview.html');
  writeFileSync(
    previewPath,
    renderPreviewPage({
      siteUrl,
      rows,
      label: (r) => (r.componentized ? `${r.sections} sections` : `${r.nodes} nodes`)
    })
  );

  writeFileSync(join(outMigration, 'report.json'), JSON.stringify({ counts, rows }, null, 2));
  return { report: reportPath, preview: previewPath };
}

/* ------------------------------------------------------------------ report */

function renderFidelityReport({ siteUrl, plan, rows, counts, generated, fp, score }) {
  const order = { fail: 0, warn: 1, pass: 2 };
  const pageRows = rows
    .slice()
    .sort((a, b) => order[a.grade] - order[b.grade] || a.path.localeCompare(b.path))
    .map(
      (r) => `<tr class="g-${r.grade}">
      <td><span class="pill pill--${r.grade}">${r.grade}</span></td>
      <td><a href="${esc(r.url)}" target="_blank" rel="noreferrer"><code>${esc(r.path)}</code></a></td>
      <td class="num">${r.sections || '—'}</td>
      <td class="num">${r.nodes}</td>
      <td>${bar(r.visual)}</td>
      <td>${bar(r.text, { pass: 0.95, warn: 0.9 })}</td>
      <td class="num">${r.scriptsTotal == null ? '—' : `${r.scriptsRan}/${r.scriptsTotal}`}</td>
      <td class="reasons">${r.reasons.map((x) => `<span>${esc(x)}</span>`).join('')}</td>
    </tr>`
    )
    .join('');

  const mediaFailed = (generated?.media?.failed ?? [])
    .slice(0, 20)
    .map((f) => `<li><code>${esc(f.url)}</code> — ${esc(f.status)}</li>`)
    .join('');

  const fallbacks = (generated?.parity?.fallbacks ?? [])
    .slice(0, 20)
    .map((f) => `<li><code>${esc(f.key)}/${esc(f.id)}</code> at <code>${esc(f.at ?? '?')}</code> — ${esc(f.reason ?? '')}</li>`)
    .join('');

  const chrome = generated?.chrome
    ? `<div class="note"><strong>Shared layout.</strong>
       Header: ${esc(generated.chrome.header?.reason ?? 'not detected')}.
       Footer: ${esc(generated.chrome.footer?.reason ?? 'not detected')}.
       Chrome that is identical across the migrated pages is emitted once into
       <code>app/layout.jsx</code>; anything that differs per page stays per page, because a
       shared header that quietly drops its active-nav state is a bug a client sees on day one.
       </div>`
    : '';

  const parity = generated?.parity;
  const parityLine = parity
    ? `${parity.ok}/${parity.sections} sections emitted as real JSX`
    : 'not a componentised build';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fidelity migration report — ${esc(new URL(siteUrl).host)}</title>
<style>${REPORT_CSS}
</style></head><body><div class="wrap">
<h1>Fidelity migration report</h1>
<p class="sub"><a href="${esc(siteUrl)}" target="_blank" rel="noreferrer">${esc(siteUrl)}</a> · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · detected builder <strong>${esc(fp?.builder ?? 'none')}</strong></p>

<div class="cards">
  <div class="card"><b>${rows.length}</b><span>pages migrated</span></div>
  <div class="card"><b style="color:var(--pass)">${counts.pass}</b><span>pass</span></div>
  <div class="card"><b style="color:var(--warn)">${counts.warn}</b><span>warn</span></div>
  <div class="card"><b style="color:var(--fail)">${counts.fail}</b><span>fail</span></div>
  <div class="card"><b>${rows.reduce((a, r) => a + r.sections, 0)}</b><span>section components</span></div>
  <div class="card"><b>${generated?.media?.downloaded ?? 0}</b><span>assets re-hosted</span></div>
</div>

<div class="note">
  <strong>What fidelity mode did.</strong> Every page was rendered in a real browser and kept
  verbatim — its DOM, its own stylesheets and the scripts that drive its animations, all
  re-hosted locally. Nothing calls WordPress at runtime.
  ${generated?.componentize ? `Each page was then split at its existing section boundaries: <strong>${esc(parityLine)}</strong>.` : ''}
  ${generated?.targets?.source === 'selected' ? `These are the <strong>${generated.targets.count} pages you selected</strong>, not a sample.` : ''}
</div>

${chrome}

<h2>Pages</h2>
<div class="tw"><table><thead><tr>
  <th>Status</th><th>Path</th><th class="num">Sections</th><th class="num">Nodes</th>
  <th>Design fidelity</th><th>Content fidelity</th><th class="num">Scripts</th><th>Notes</th>
</tr></thead><tbody>${pageRows || '<tr><td colspan="8">No pages were built.</td></tr>'}</tbody></table></div>

<div class="note">
  <strong>Two scores, never averaged.</strong> Design fidelity is a pixel comparison against
  the live page; content fidelity is the share of the original's words that survived. They
  answer different questions and a page can be excellent at one and poor at the other — a
  blended number would hide exactly the failure worth looking at.
  ${score ? '' : ' Run the score step to fill these columns.'}
</div>

${fallbacks ? `<h2>Sections that fell back to the runtime renderer</h2>
<p class="sub">These still render correctly — the emitted JSX did not round-trip to the captured DOM, so the safe path was taken instead of shipping markup that was not verified.</p>
<ul>${fallbacks}</ul>` : ''}

${mediaFailed ? `<h2>Assets that could not be re-hosted</h2><ul>${mediaFailed}</ul>` : ''}

<h2>What this report does not claim</h2>
<ul>
  <li>A <strong>pass</strong> means the page renders, nothing was dropped, and the measurements cleared their thresholds — not that a designer could find no difference.</li>
  <li>Video and CSS animation are frozen on both sides before the pixel comparison. Two independent playbacks never share a frame, and scoring them would report a number about video timing rather than about the migration.</li>
  <li>Third-party embeds are preserved verbatim; keys referrer-locked to the old domain need re-scoping before they render.</li>
  <li>Anything personalised, A/B tested or rendered from a live feed was captured once. It is a snapshot, and it is honest to call it one.</li>
</ul>
</div></body></html>`;
}
