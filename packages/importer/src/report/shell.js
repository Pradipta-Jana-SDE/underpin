/**
 * The chrome both reports share.
 *
 * Template mode and fidelity mode answer different questions and therefore need different
 * tables — but they are one product and must look like it. Keeping the palette, the grade
 * pills and the side-by-side preview harness in one place is what stops the second report
 * from drifting into a slightly different shade of the first.
 */

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const REPORT_CSS = `
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
  .bar{display:flex;align-items:center;gap:7px}
  .bar i{display:block;height:6px;border-radius:3px;background:var(--line);width:64px;flex:none;overflow:hidden}
  .bar i>b{display:block;height:100%;border-radius:3px}
  .bar em{font-style:normal;font-variant-numeric:tabular-nums;font-size:.8rem;color:var(--muted)}
`;

/** A 0–1 measurement drawn as a bar. Colour follows the same pass/warn/fail language as the pills. */
export function bar(value, { pass = 0.92, warn = 0.85 } = {}) {
  if (value == null || Number.isNaN(value)) return '<span style="color:var(--muted)">—</span>';
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const tone = value >= pass ? 'pass' : value >= warn ? 'warn' : 'fail';
  return `<span class="bar"><i><b style="width:${pct.toFixed(1)}%;background:var(--${tone})"></b></i><em>${pct.toFixed(1)}%</em></span>`;
}

/**
 * The side-by-side harness: original and migrated, at the three breakpoints.
 *
 * `label` lets each mode describe a row in its own terms — a template name and match
 * percentage in template mode, a section count in fidelity mode — without forking the page.
 */
export function renderPreviewPage({ siteUrl, rows, label = (r) => r.path }) {
  const options = rows
    .map((r) => `<option value="${esc(r.path)}" data-src="${esc(r.url)}">${esc(r.path)} — ${esc(label(r))}</option>`)
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
