import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { esc, REPORT_CSS, renderPreviewPage } from './shell.js';

const read = (p, fallback = null) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);

/** pass / warn / fail per page, with the reason spelled out. */
function gradePage(match, generated, page) {
  const reasons = [];
  let grade = 'pass';

  if (match.leftover?.length) { grade = 'fail'; reasons.push(`${match.leftover.length} section(s) with nowhere to render`); }
  if (match.pageTypeNeedsReview) { grade = grade === 'fail' ? 'fail' : 'warn'; reasons.push(`page type "${match.pageType}" below the confidence bar`); }
  if (match.missingRequired?.length) { grade = grade === 'fail' ? 'fail' : 'warn'; reasons.push(`template is missing ${match.missingRequired.join(', ')}`); }
  if (match.matchConfidence < 50) { grade = grade === 'fail' ? 'fail' : 'warn'; reasons.push(`template match only ${match.matchConfidence}%`); }
  if (page?.sections?.some((s) => s.incompleteCapture)) { grade = grade === 'fail' ? 'fail' : 'warn'; reasons.push('carousel may be missing slides'); }
  if (!page?.seo?.title) { grade = grade === 'fail' ? 'fail' : 'warn'; reasons.push('no title tag found'); }

  return { grade, reasons };
}

export async function writeReport(outDir, siteUrl) {
  const plan = read(join(outDir, 'migration.plan.json'));
  const siteIr = read(join(outDir, 'site.ir.json'));
  const pages = read(join(outDir, 'ir', 'pages.json'), []);
  const matches = read(join(outDir, 'template-plan.json'), []);
  const generated = read(join(outDir, 'generate-result.json'), {});
  const stats = read(join(outDir, 'extraction-stats.json'), {});
  const fp = read(join(outDir, 'fingerprint.json'), {});

  const pageByUrl = new Map(pages.map((p) => [p.url, p]));
  const rows = matches.map((m) => {
    const page = pageByUrl.get(m.url);
    const { grade, reasons } = gradePage(m, generated, page);
    return { ...m, grade, reasons, sections: page?.sections?.length ?? 0, builder: page?.source?.builder, title: page?.seo?.title };
  });

  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const r of rows) counts[r.grade]++;

  const outMigration = join(outDir, '_migration');
  mkdirSync(outMigration, { recursive: true });

  const reportPath = join(outMigration, 'report.html');
  writeFileSync(reportPath, renderReport({ siteUrl, plan, siteIr, rows, counts, generated, stats, fp }));

  const previewPath = join(outMigration, 'preview.html');
  writeFileSync(previewPath, renderPreview({ siteUrl, rows }));

  writeFileSync(join(outMigration, 'report.json'), JSON.stringify({ counts, rows }, null, 2));
  return { report: reportPath, preview: previewPath };
}

/* ------------------------------------------------------------------ report */

function renderReport({ siteUrl, plan, siteIr, rows, counts, generated, stats, fp }) {
  const cap = (plan?.capabilities ?? [])
    .map((c) => `<tr><td>${esc(c.label ?? c.id)}</td><td><code>${esc(c.disposition)}</code></td><td>${esc(c.note ?? '')}</td></tr>`)
    .join('');

  const pageRows = rows
    .sort((a, b) => (a.grade === b.grade ? a.matchConfidence - b.matchConfidence : a.grade === 'fail' ? -1 : b.grade === 'fail' ? 1 : a.grade === 'warn' ? -1 : 1))
    .map(
      (r) => `<tr class="g-${r.grade}">
      <td><span class="pill pill--${r.grade}">${r.grade}</span></td>
      <td><a href="${esc(r.url)}" target="_blank" rel="noreferrer"><code>${esc(r.path)}</code></a></td>
      <td>${esc(r.pageType)}${r.pageTypeNeedsReview ? ' <span class="q">?</span>' : ''}</td>
      <td>${esc(r.chosen)}</td>
      <td class="num">${r.matchConfidence}%</td>
      <td class="num">${r.sections}</td>
      <td>${esc(r.builder ?? '—')}</td>
      <td class="reasons">${r.reasons.map((x) => `<span>${esc(x)}</span>`).join('')}</td>
    </tr>`
    )
    .join('');

  const mediaFailed = (generated?.media?.failed ?? [])
    .slice(0, 20)
    .map((f) => `<li><code>${esc(f.url)}</code> — ${esc(f.status)}</li>`)
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Migration report — ${esc(new URL(siteUrl).host)}</title>
<style>${REPORT_CSS}
</style></head><body><div class="wrap">
<h1>Migration report</h1>
<p class="sub"><a href="${esc(siteUrl)}" target="_blank" rel="noreferrer">${esc(siteUrl)}</a> · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · detected builder <strong>${esc(fp?.builder ?? 'none')}</strong></p>

<div class="cards">
  <div class="card"><b>${rows.length}</b><span>pages migrated</span></div>
  <div class="card"><b style="color:var(--pass)">${counts.pass}</b><span>pass</span></div>
  <div class="card"><b style="color:var(--warn)">${counts.warn}</b><span>warn</span></div>
  <div class="card"><b style="color:var(--fail)">${counts.fail}</b><span>fail</span></div>
  <div class="card"><b>${stats?.sections ?? 0}</b><span>sections</span></div>
  <div class="card"><b>${generated?.media?.downloaded ?? 0}</b><span>media re-hosted</span></div>
</div>

<div class="note">
  <strong>The scope contract.</strong> This migration is judged against what was agreed at
  scope, not against an unstated ideal. ${plan?.pages?.excluded ?? 0} of ${plan?.pages?.total ?? 0}
  URLs were deliberately excluded, and every one carries a routing policy — no bare 404s.
</div>

<h2>Capability decisions</h2>
<div class="tw"><table><thead><tr><th>Capability</th><th>Disposition</th><th>Chosen</th></tr></thead>
<tbody>${cap || '<tr><td colspan="3">No capability needed a decision.</td></tr>'}</tbody></table></div>

<h2>Branding extracted</h2>
<div class="tw"><table><thead><tr><th>Token</th><th>Value</th><th>Source</th></tr></thead><tbody>
  <tr><td>Primary colour</td><td><code>${esc(siteIr?.brand?.colors?.primary ?? '—')}</code></td><td>${esc(siteIr?.brand?.sources?.colors ?? '—')}</td></tr>
  <tr><td>Heading font</td><td>${esc(siteIr?.brand?.fonts?.heading ?? '—')}</td><td>${esc(siteIr?.brand?.sources?.fonts ?? '—')}</td></tr>
  <tr><td>Body font</td><td>${esc(siteIr?.brand?.fonts?.body ?? '—')}</td><td>${esc(siteIr?.brand?.sources?.fonts ?? '—')}</td></tr>
  <tr><td>Logo</td><td><code>${esc(siteIr?.brand?.logo?.default ?? 'not found')}</code></td><td>${esc(siteIr?.brand?.sources?.logo ?? '—')}</td></tr>
  <tr><td>Navigation</td><td>${siteIr?.nav?.primary?.length ?? 0} items</td><td>${esc(siteIr?.nav?.source ?? '—')}</td></tr>
  <tr><td>Locations</td><td>${siteIr?.locations?.length ?? 0}</td><td>${esc(siteIr?.brand?.sources?.contact ?? '—')}</td></tr>
</tbody></table></div>

<h2>Pages</h2>
<div class="tw"><table><thead><tr>
  <th>Status</th><th>Path</th><th>Type</th><th>Template</th><th class="num">Match</th><th class="num">Sections</th><th>Builder</th><th>Notes</th>
</tr></thead><tbody>${pageRows}</tbody></table></div>

${mediaFailed ? `<h2>Media that could not be re-hosted</h2><ul>${mediaFailed}</ul>` : ''}

<h2>What this report does not claim</h2>
<ul>
  <li>A <strong>pass</strong> means nothing was lost and the template fits — not that the page is pixel-identical. Visual fidelity and content fidelity are scored separately and deliberately.</li>
  <li>Carousel sections flagged "may be missing slides" were read from a static DOM, where only the active slide exists. A render pass is needed to confirm.</li>
  <li>Third-party embeds are preserved verbatim; API keys referrer-locked to the old domain will need re-scoping before they render.</li>
</ul>
</div></body></html>`;
}

/* ----------------------------------------------------------------- preview */

/** Template mode labels each row with the template it chose and how well it fit. */
function renderPreview({ siteUrl, rows }) {
  return renderPreviewPage({
    siteUrl,
    rows,
    label: (r) => `${r.chosen} (${r.matchConfidence}%)`
  });
}
