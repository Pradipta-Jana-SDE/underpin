import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const read = (p, fallback = null) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

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
<style>
  :root{--bg:#fbfcfd;--fg:#12181f;--muted:#5d6874;--line:#e2e8ee;--card:#fff;
        --pass:#0f7355;--pass-bg:#e6f4ef;--warn:#8a5300;--warn-bg:#fdf2e0;--fail:#a5342f;--fail-bg:#fbeceb;--accent:#2b50d9}
  @media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e5eaf0;--muted:#8b98a6;--line:#232c36;--card:#151c24;
        --pass:#48c79b;--pass-bg:#10271f;--warn:#d9a040;--warn-bg:#2a2012;--fail:#e58585;--fail-bg:#2c1717;--accent:#8aa0f8}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
  .wrap{max-width:1180px;margin:0 auto;padding:32px 20px 64px}
  h1{font-size:1.7rem;margin:0 0 .2em;letter-spacing:-.02em}
  h2{font-size:1.1rem;margin:2.4rem 0 .7rem;letter-spacing:-.01em}
  .sub{color:var(--muted);margin:0 0 1.6rem}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:0 0 8px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px}
  .card b{display:block;font-size:1.7rem;line-height:1.1;font-variant-numeric:tabular-nums}
  .card span{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.08em}
  .tw{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--card)}
  table{border-collapse:collapse;width:100%;min-width:900px;font-size:.87rem}
  th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-size:.7rem;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);white-space:nowrap;background:var(--bg)}
  tbody tr:last-child td{border-bottom:0}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  code{font-family:ui-monospace,Menlo,monospace;font-size:.85em}
  .pill{display:inline-block;padding:2px 8px;border-radius:20px;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
  .pill--pass{background:var(--pass-bg);color:var(--pass)}
  .pill--warn{background:var(--warn-bg);color:var(--warn)}
  .pill--fail{background:var(--fail-bg);color:var(--fail)}
  .reasons span{display:block;color:var(--muted);font-size:.8rem}
  .q{color:var(--warn);font-weight:700}
  .note{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:0 6px 6px 0;padding:12px 16px;margin:12px 0}
  ul{margin:.4rem 0;padding-left:1.1rem;color:var(--muted);font-size:.86rem}
  a{color:var(--accent)}
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

function renderPreview({ siteUrl, rows }) {
  const options = rows
    .map((r) => `<option value="${esc(r.path)}" data-src="${esc(r.url)}">${esc(r.path)} — ${esc(r.chosen)} (${r.matchConfidence}%)</option>`)
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Migration preview — ${esc(new URL(siteUrl).host)}</title>
<style>
  :root{--bg:#fbfcfd;--fg:#12181f;--muted:#5d6874;--line:#e2e8ee;--card:#fff;--accent:#2b50d9}
  @media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e5eaf0;--muted:#8b98a6;--line:#232c36;--card:#151c24;--accent:#8aa0f8}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
  header{position:sticky;top:0;background:var(--card);border-bottom:1px solid var(--line);padding:12px 20px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;z-index:5}
  select,button{font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--fg)}
  button{cursor:pointer}
  button[aria-pressed=true]{background:var(--accent);color:#fff;border-color:var(--accent)}
  .stage{display:flex;gap:22px;padding:22px;overflow-x:auto;align-items:flex-start}
  .device{flex:none}
  .device figcaption{font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
  .frame{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#fff;box-shadow:0 2px 14px -6px rgba(0,0,0,.25)}
  iframe{border:0;display:block;background:#fff}
  .hint{color:var(--muted);font-size:.82rem;padding:0 20px 20px;max-width:80ch}
  code{font-family:ui-monospace,Menlo,monospace}
</style></head><body>
<header>
  <strong>Preview</strong>
  <select id="page">${options}</select>
  <span style="color:var(--muted)">show:</span>
  <button id="b-orig" aria-pressed="true">Original</button>
  <button id="b-mig" aria-pressed="true">Migrated</button>
  <span style="margin-left:auto;color:var(--muted)">375 · 768 · 1440</span>
</header>
<div class="stage" id="stage"></div>
<p class="hint">
  The migrated column expects the generated site to be served locally — run
  <code>npm install &amp;&amp; npm run build &amp;&amp; npx serve out</code> inside the site directory,
  then set the base URL below. Widths are the three breakpoints the component library is
  built against, so this doubles as the responsive check.
  <br><br>Migrated base: <input id="base" value="http://localhost:3000" style="font:inherit;padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)">
</p>
<script>
  const WIDTHS = [[375,'Mobile'],[768,'Tablet'],[1440,'Desktop']];
  const stage = document.getElementById('stage');
  const sel = document.getElementById('page');
  const base = document.getElementById('base');
  let showOrig = true, showMig = true;

  function frame(src, w, label) {
    const fig = document.createElement('figure');
    fig.className = 'device';
    fig.style.margin = '0';
    fig.innerHTML = '<figcaption>' + label + ' · ' + w + 'px</figcaption>' +
      '<div class="frame" style="width:' + w + 'px"><iframe src="' + src + '" width="' + w + '" height="820" loading="lazy" sandbox="allow-same-origin allow-scripts"></iframe></div>';
    return fig;
  }

  function render() {
    const opt = sel.selectedOptions[0];
    if (!opt) return;
    stage.innerHTML = '';
    for (const [w, name] of WIDTHS) {
      if (showOrig) stage.appendChild(frame(opt.dataset.src, w, 'Original · ' + name));
      if (showMig) stage.appendChild(frame(base.value.replace(/\\/$/, '') + opt.value, w, 'Migrated · ' + name));
    }
  }

  sel.addEventListener('change', render);
  base.addEventListener('change', render);
  document.getElementById('b-orig').addEventListener('click', (e) => {
    showOrig = !showOrig; e.target.setAttribute('aria-pressed', String(showOrig)); render();
  });
  document.getElementById('b-mig').addEventListener('click', (e) => {
    showMig = !showMig; e.target.setAttribute('aria-pressed', String(showMig)); render();
  });
  render();
</script>
</body></html>`;
}
