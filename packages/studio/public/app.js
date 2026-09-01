/* Underpin Studio — client.
   No framework: the whole surface is six panels and a table, and a build step would add
   more moving parts than it removes. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = (id, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><use href="#${id}"/></svg>`;

const STEPS = [
  { id: 'source',   label: 'Source',    sub: 'Enter a URL' },
  { id: 'findings', label: 'Findings',  sub: 'What we found' },
  { id: 'scope',    label: 'Scope',     sub: 'Capabilities' },
  { id: 'pages',    label: 'Pages',     sub: 'Which to migrate' },
  { id: 'review',   label: 'Review',    sub: 'Content & templates' },
  { id: 'build',    label: 'Build',     sub: 'Generate & verify' },
  { id: 'preview',  label: 'Preview',   sub: 'Side by side' }
];

const state = {
  siteUrl: null, host: null, limit: 12,
  reached: new Set(['source']),
  questions: [], review: [], templates: [], verify: null, routes: [],
  groups: [], selected: new Set(),
  // Exact copy is the default: it is what someone opening a migration tool is asking for.
  mode: 'fidelity', componentize: true, llm: false
};

const MODE_HELP = {
  fidelity: `Renders every selected page in a real browser and keeps it verbatim — its DOM, its
    own stylesheets and the scripts that drive its animations, re-hosted locally. Nothing calls
    WordPress at runtime.`,
  template: `Reads what each page means and rebuilds it from a library of 15 reusable React
    section components. Tidier and far easier to maintain, but visibly not the same page — use
    this when the migration is a redesign.`
};

/* ------------------------------------------------------------------ chrome */

function renderSteps() {
  $('#steps').innerHTML = STEPS.map((s, i) => {
    const reachable = state.reached.has(s.id);
    const current = s.id === state.current;
    const done = reachable && !current && STEPS.findIndex((x) => x.id === s.id) < STEPS.findIndex((x) => x.id === state.current);
    return `<li><button class="step ${done ? 'done' : ''}" data-goto="${s.id}"
      ${reachable ? '' : 'disabled'} ${current ? 'aria-current="step"' : ''}>
      <span class="n">${done ? svg('i-check', 12) : i + 1}</span>
      <span>${esc(s.label)}<span class="sub">${esc(s.sub)}</span></span>
    </button></li>`;
  }).join('');
}

function goto(id) {
  if (!state.reached.has(id)) return;
  state.current = id;
  for (const s of STEPS) $(`#p-${s.id}`).hidden = s.id !== id;
  renderSteps();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function reach(id) { state.reached.add(id); renderSteps(); }

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-goto]');
  if (b) goto(b.dataset.goto);
});

/* --------------------------------------------------------------- log feed */

function logLine(el, text, kind = '') {
  const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const row = document.createElement('div');
  row.innerHTML = `<span class="t">${t}</span><span class="${kind}">${esc(text)}</span>`;
  el.appendChild(row);
  el.scrollTop = el.scrollHeight;
}

/** Reads an NDJSON response body and yields each event as it arrives. */
async function* ndjson(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const l of lines) if (l.trim()) yield JSON.parse(l);
  }
  if (buf.trim()) yield JSON.parse(buf);
}

const post = (path, payload) =>
  fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

/* --------------------------------------------------------------- step 1-2 */

async function loadRecent() {
  try {
    const sites = await (await fetch('/api/sites')).json();
    if (!sites.length) return;
    $('#recent').innerHTML = `
      <span class="eyebrow">Previously migrated</span>
      <div class="grid g2">${sites.map((s) => `
        <button class="card" data-open="${esc(s.site)}" style="text-align:left;cursor:pointer;font:inherit;color:inherit">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
            <strong class="mono">${esc(s.host)}</strong>
            ${s.verified === true ? '<span class="pill pill--pass">verified</span>'
              : s.verified === false ? '<span class="pill pill--fail">checks failed</span>'
              : s.built ? '<span class="pill pill--info">built</span>' : '<span class="pill pill--warn">in progress</span>'}
          </div>
          <div style="font-size:.8rem;color:var(--muted);margin-top:5px">
            ${s.pages} pages · ${s.inScope} in scope${s.excluded ? ` · ${s.excluded} excluded` : ''}
          </div>
        </button>`).join('')}</div>`;
    $$('[data-open]').forEach((b) => b.addEventListener('click', () => {
      $('#url').value = b.dataset.open;
      inspect();
    }));
  } catch { /* the list is a convenience; its absence is not an error */ }
}

async function inspect() {
  const url = $('#url').value.trim();
  $('#urlErr').textContent = '';
  if (!url) { $('#urlErr').textContent = 'Enter a site URL first.'; $('#url').focus(); return; }

  state.limit = Number($('#limit').value);
  const btn = $('#btnInspect');
  btn.disabled = true;
  btn.textContent = 'Inspecting…';

  reach('findings');
  goto('findings');
  const log = $('#findLog');
  log.innerHTML = '';
  $('#findCaps').innerHTML = '';
  $('#findStats').innerHTML = '';

  try {
    const res = await post('/api/inspect', { url });
    for await (const ev of ndjson(res)) {
      if (ev.type === 'stage') logLine(log, ev.label);
      else if (ev.type === 'chain') {
        if (ev.step === 'robots.txt') logLine(log, ev.found ? `robots.txt · ${ev.sitemaps} sitemap directive(s)` : 'robots.txt absent', ev.found ? 'ok' : 'wa');
        else if (ev.step === 'sitemap') logLine(log, `sitemap ${ev.url} · ${ev.urls || 'none'}`, ev.urls ? 'ok' : '');
        else if (ev.step === 'rest') logLine(log, ev.reachable ? `REST API reachable${ev.viaRestRoute ? ' (via ?rest_route=)' : ''}` : 'REST API unreachable — will render instead', ev.reachable ? 'ok' : 'wa');
        else if (ev.step === 'homepage_link_crawl') logLine(log, `no sitemap — fell back to link crawl · ${ev.urls} URLs`, 'wa');
      } else if (ev.type === 'discovered') {
        logLine(log, `${ev.urls} URLs in inventory`, 'ok');
        if (ev.blockedByRobots) logLine(log, `${ev.blockedByRobots} excluded by robots.txt`);
      } else if (ev.type === 'error') {
        logLine(log, ev.message, 'no');
      } else if (ev.type === 'done') {
        Object.assign(state, { siteUrl: ev.siteUrl, host: ev.host, questions: ev.questions });
        $('#railSite').innerHTML = `<code>${esc(ev.host)}</code>`;
        renderFindings(ev);
        reach('scope');
        renderQuestions();
      }
    }
  } catch (err) {
    logLine(log, String(err.message ?? err), 'no');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `Inspect site ${svg('i-arrow', 15)}`;
  }
}

function renderFindings(ev) {
  $('#findStats').innerHTML = `
    <div class="stat"><b>${ev.urls}</b><span>URLs found</span></div>
    <div class="stat"><b class="mono" style="font-size:1.1rem;line-height:1.6">${esc(ev.builder ?? 'none')}</b><span>page builder</span></div>
    <div class="stat"><b>${ev.capabilities.length}</b><span>capabilities</span></div>
    <div class="stat"><b style="color:${ev.questions.length ? 'var(--warn)' : 'var(--pass)'}">${ev.questions.length}</b><span>need a decision</span></div>`;

  $('#findCaps').innerHTML = ev.capabilities.length
    ? ev.capabilities.map((c) => {
        const decides = c.confidence >= 0.4;
        return `<div style="padding:9px 0;border-bottom:1px solid var(--line)">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:center">
            <strong style="font-size:.9rem">${esc(c.label)}</strong>
            <span class="pill ${decides ? 'pill--warn' : 'pill--info'}">${decides ? 'needs a decision' : `${c.confidence}`}</span>
          </div>
          <ul class="evidence">${c.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
        </div>`;
      }).join('')
    : `<p style="color:var(--muted);font-size:.9rem;margin:0">Nothing beyond a plain content site — no commerce, logins or locales to decide about.</p>`;
}

/* ----------------------------------------------------------------- step 3 */

function renderQuestions() {
  const box = $('#questions');
  if (!state.questions.length) {
    box.innerHTML = `<div class="empty">${svg('i-empty', 40)}
      <p>No capability needs a decision. Everything detected is safe to migrate as-is.</p></div>`;
    return;
  }
  box.innerHTML = state.questions.map((q) => `
    <div class="q">
      <header>
        <h3>${esc(q.question)} <span class="pill pill--info">confidence ${q.confidence}</span></h3>
        <ul class="evidence">${q.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
      </header>
      <div class="opts">
        ${q.options.map((o, i) => `
          <label class="opt">
            <input type="radio" name="q-${esc(q.id)}" value="${esc(o.value)}" ${o.recommended ? 'checked' : ''}>
            <span>
              <span class="lab">${esc(o.label)} ${o.recommended ? '<span class="rec">recommended</span>' : ''}</span>
              <span class="det">${esc(o.detail)}</span>
            </span>
          </label>`).join('')}
      </div>
      ${q.unavailable.length ? `<div class="unavail">
        ${q.unavailable.map((u) => `<div>
          <span class="x">${svg('i-x', 13)}</span>
          <span><span class="lab">${esc(u.label)}</span><span class="det">${esc(u.why)}</span></span>
        </div>`).join('')}
      </div>` : ''}
    </div>`).join('');
}

async function saveScopeAndPick() {
  const decisions = {};
  for (const q of state.questions) {
    const picked = $(`input[name="q-${q.id}"]:checked`);
    if (picked) decisions[q.id] = picked.value;
  }
  const btn = $('#btnToPages');
  btn.disabled = true;
  btn.textContent = 'Working…';

  try {
    const r = await (await post('/api/scope', { siteUrl: state.siteUrl, decisions })).json();
    if (r.error) throw new Error(r.error);
    state.plan = r.plan;
    const inv = await (await post('/api/pages', { siteUrl: state.siteUrl })).json();
    if (inv.error) throw new Error(inv.error);
    state.groups = inv.groups;
    // Everything on by default: a picker that starts empty makes "migrate the whole
    // site" — the common case — the most work.
    state.selected = new Set(inv.selected ?? inv.groups.flatMap((g) => g.pages.map((p) => p.url)));
    reach('pages');
    goto('pages');
    renderPages();
  } catch (err) {
    alert(`Could not load the page list: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `Choose pages ${svg('i-arrow', 15)}`;
  }
}

/* --------------------------------------------------- step 4 · page picker */

const TYPE_LABEL = {
  home: 'Home', service: 'Service', service_index: 'Services index', about: 'About',
  location: 'Location', contact: 'Contact', team: 'Team', pricing: 'Pricing', faq: 'FAQ',
  testimonials: 'Testimonials', gallery: 'Gallery', case_study: 'Case study',
  careers: 'Careers', blog_index: 'Blog index', blog_post: 'Blog post',
  product: 'Product', product_index: 'Product index', legal: 'Legal',
  archive: 'Archive', landing: 'Landing', generic: 'Other'
};
const groupLabel = (t) => TYPE_LABEL[t] ?? (t.startsWith('section') ? t.replace('section', '') : t);

function renderPages() {
  $('#pageGroups').innerHTML = state.groups.map((g, gi) => {
    const on = g.pages.filter((p) => state.selected.has(p.url)).length;
    // Groups that are wholly selected start collapsed — the operator only needs to open
    // the ones they intend to change.
    const open = on !== g.pages.length || g.pages.length <= 12;
    return `<details class="pgroup" ${open ? 'open' : ''} data-g="${gi}">
      <summary>
        <span class="gname">${esc(groupLabel(g.type))}</span>
        <span class="gcount">${g.count} page${g.count === 1 ? '' : 's'}</span>
        <span class="gbadge" data-gb="${gi}">${on}/${g.count}</span>
        <span class="gactions">
          <button type="button" data-gall="${gi}">all</button>
          <button type="button" data-gnone="${gi}">none</button>
        </span>
      </summary>
      <div class="plist">
        ${g.pages.map((p) => `
          <label class="prow" data-path="${esc(p.path.toLowerCase())}">
            <input type="checkbox" data-url="${esc(p.url)}" ${state.selected.has(p.url) ? 'checked' : ''}>
            <span class="ppath">${esc(p.path)}</span>
          </label>`).join('')}
      </div>
    </details>`;
  }).join('');

  $$('#pageGroups input[type=checkbox]').forEach((cb) =>
    cb.addEventListener('change', () => {
      cb.checked ? state.selected.add(cb.dataset.url) : state.selected.delete(cb.dataset.url);
      updatePickCounts();
    })
  );
  $$('[data-gall]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); setGroup(+b.dataset.gall, true); }));
  $$('[data-gnone]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); setGroup(+b.dataset.gnone, false); }));
  updatePickCounts();
}

function setGroup(gi, on) {
  for (const p of state.groups[gi].pages) on ? state.selected.add(p.url) : state.selected.delete(p.url);
  $$(`#pageGroups details[data-g="${gi}"] input[type=checkbox]`).forEach((cb) => { cb.checked = on; });
  updatePickCounts();
}

function updatePickCounts() {
  const total = state.groups.reduce((a, g) => a + g.count, 0);
  $('#pickCount').textContent = `${state.selected.size} of ${total} selected`;
  state.groups.forEach((g, gi) => {
    const on = g.pages.filter((p) => state.selected.has(p.url)).length;
    const badge = $(`[data-gb="${gi}"]`);
    if (badge) badge.textContent = `${on}/${g.count}`;
  });
  $('#btnMigrate').disabled = state.selected.size === 0;
}

function filterPages(q) {
  const needle = q.trim().toLowerCase();
  $$('#pageGroups .prow').forEach((row) => {
    row.hidden = needle && !row.dataset.path.includes(needle);
  });
  $$('#pageGroups .pgroup').forEach((d) => {
    const any = [...d.querySelectorAll('.prow')].some((r) => !r.hidden);
    d.hidden = !any;
    if (needle && any) d.open = true;
  });
}

async function confirmSelectionAndMigrate() {
  const btn = $('#btnMigrate');
  btn.disabled = true;
  btn.textContent = 'Working…';
  try {
    const r = await (await post('/api/select', {
      siteUrl: state.siteUrl, urls: [...state.selected]
    })).json();
    if (r.error) throw new Error(r.error);
    reach('review');
    goto('review');
    await migrate(state.plan);
  } catch (err) {
    alert(`Could not save the selection: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `Extract and match templates ${svg('i-arrow', 15)}`;
  }
}

/* ----------------------------------------------------------------- step 4 */

async function migrate(plan) {
  $('#migrateProgress').hidden = false;
  $('#reviewBody').hidden = true;
  const log = $('#migrateLog');
  log.innerHTML = '';
  if (plan) logLine(log, `${plan.pages.inScope} pages in scope, ${plan.pages.excluded} excluded`, 'ok');

  const res = await post('/api/migrate', { siteUrl: state.siteUrl, limit: state.limit || null });
  for await (const ev of ndjson(res)) {
    if (ev.type === 'stage') { $('#migrateLabel').textContent = ev.label; logLine(log, ev.label); }
    else if (ev.type === 'progress') {
      $('#migrateBar').style.width = `${Math.round((ev.done / ev.total) * 100)}%`;
      $('#migrateLabel').textContent = `Extracting ${ev.done} of ${ev.total} pages`;
    } else if (ev.type === 'extracted') {
      logLine(log, `${ev.stats.pages} pages · ${ev.stats.sections} sections · ${ev.stats.media} media`, 'ok');
      if (ev.stats.lowConfidence) logLine(log, `${ev.stats.lowConfidence} sections below 0.6 confidence → review`, 'wa');
      if (ev.stats.incompleteCapture) logLine(log, `${ev.stats.incompleteCapture} carousel sections may be missing slides`, 'wa');
      state.siteIr = ev.siteIr;
      state.stats = ev.stats;
    } else if (ev.type === 'error') {
      logLine(log, ev.message, 'no');
    } else if (ev.type === 'done') {
      state.review = ev.review;
      state.templates = ev.templates;
      $('#migrateBar').style.width = '100%';
      renderReview();
      $('#migrateProgress').hidden = true;
      $('#reviewBody').hidden = false;
      reach('build');
    }
  }
}

const meter = (v) => {
  const c = v >= 70 ? 'var(--pass)' : v >= 45 ? 'var(--warn)' : 'var(--fail)';
  return `<span class="meter"><b>${v}%</b><i style="--w:${v}%;--c:${c}"></i></span>`;
};

function renderReview() {
  const r = state.review;
  const avg = Math.round(r.reduce((a, x) => a + x.matchConfidence, 0) / (r.length || 1));
  const leftover = r.reduce((a, x) => a + x.leftover, 0);
  const needsReview = r.filter((x) => x.needsReview).length;

  $('#reviewStats').innerHTML = `
    <div class="stat"><b>${r.length}</b><span>pages</span></div>
    <div class="stat"><b>${state.stats?.sections ?? 0}</b><span>sections</span></div>
    <div class="stat"><b style="color:${avg >= 60 ? 'var(--pass)' : 'var(--warn)'}">${avg}%</b><span>avg template match</span></div>
    <div class="stat"><b style="color:${leftover ? 'var(--fail)' : 'var(--pass)'}">${leftover}</b><span>leftover sections</span></div>`;

  const b = state.siteIr?.brand ?? {};
  const sw = (hex) => hex ? `<span style="display:inline-block;width:13px;height:13px;border-radius:3px;background:${esc(hex)};border:1px solid var(--line);vertical-align:-2px;margin-right:5px"></span>` : '';
  $('#brandOut').innerHTML = `<div class="grid g3" style="gap:10px;font-size:.85rem">
    <div><span style="color:var(--muted)">Primary</span><br>${sw(b.colors?.primary)}<code>${esc(b.colors?.primary ?? 'none found')}</code></div>
    <div><span style="color:var(--muted)">Fonts</span><br><code>${esc(b.fonts?.heading ?? '?')} / ${esc(b.fonts?.body ?? '?')}</code></div>
    <div><span style="color:var(--muted)">Logo</span><br>${b.logo?.default ? '<span class="pill pill--pass">found</span>' : '<span class="pill pill--warn">not found</span>'}</div>
    <div><span style="color:var(--muted)">Navigation</span><br><code>${state.siteIr?.nav?.primary?.length ?? 0} items</code></div>
    <div><span style="color:var(--muted)">Locations</span><br><code>${state.siteIr?.locations?.length ?? 0}</code></div>
    <div><span style="color:var(--muted)">Shell detected</span><br><code>${state.siteIr?.shell?.headerSelector ? 'header + footer' : 'not detected'}</code></div>
  </div>`;

  $('#reviewRows').innerHTML = r.map((p, i) => `
    <tr data-row="${i}">
      <td><span class="path">${esc(p.path)}</span><span class="title">${esc(p.title)}</span></td>
      <td>${esc(p.pageType)}${p.needsReview ? ' <span class="pill pill--warn">check</span>' : ''}</td>
      <td><div class="chips">${p.sections.slice(0, 6).map((s) =>
        `<span class="chip ${s.incomplete ? 'chip--flag' : s.confidence < 0.6 ? 'chip--low' : ''}"
           title="${esc(s.archetype)} · confidence ${s.confidence} · decided by ${esc(s.decidedBy)}${s.items ? ` · ${s.items} items` : ''}">${esc(s.archetype)}${s.items ? `·${s.items}` : ''}</span>`
        ).join('')}${p.sections.length > 6 ? `<span class="chip">+${p.sections.length - 6}</span>` : ''}</div></td>
      <td><select data-tpl="${i}" aria-label="Template for ${esc(p.path)}">
        ${p.alternatives.map((a) => `<option value="${esc(a.templateId)}" ${a.templateId === p.chosen ? 'selected' : ''}>${esc(a.templateId)} — ${a.confidence}%</option>`).join('')}
      </select></td>
      <td class="num">${meter(p.matchConfidence)}</td>
      <td><span data-flags="${i}">${flagsFor(p)}</span></td>
    </tr>`).join('');

  $$('[data-tpl]').forEach((sel) => sel.addEventListener('change', onTemplateChange));
}

function flagsFor(p) {
  const out = [];
  if (p.leftover) out.push(`<span class="pill pill--fail">${p.leftover} leftover</span>`);
  if (p.missingRequired?.length) out.push(`<span class="pill pill--warn">missing ${esc(p.missingRequired.join(', '))}</span>`);
  if (p.sections.some((s) => s.incomplete)) out.push('<span class="pill pill--warn">carousel</span>');
  if (!out.length) out.push('<span class="pill pill--pass">clean</span>');
  return out.join(' ');
}

async function onTemplateChange(e) {
  const i = Number(e.target.dataset.tpl);
  const row = state.review[i];
  const templateId = e.target.value;
  e.target.disabled = true;
  try {
    const r = await (await post('/api/template', { siteUrl: state.siteUrl, path: row.path, templateId })).json();
    if (r.error) throw new Error(r.error);
    row.chosen = templateId;
    row.leftover = r.leftover;
    const alt = row.alternatives.find((a) => a.templateId === templateId);
    row.matchConfidence = alt?.confidence ?? row.matchConfidence;
    row.missingRequired = alt?.missingRequired ?? [];
    $(`[data-row="${i}"] .num`).innerHTML = meter(row.matchConfidence);
    $(`[data-flags="${i}"]`).innerHTML = flagsFor(row);
    renderReviewTotals();
  } catch (err) {
    alert(`Could not change template: ${err.message}`);
  } finally {
    e.target.disabled = false;
  }
}

function renderReviewTotals() {
  const r = state.review;
  const avg = Math.round(r.reduce((a, x) => a + x.matchConfidence, 0) / (r.length || 1));
  const leftover = r.reduce((a, x) => a + x.leftover, 0);
  const stats = $$('#reviewStats .stat b');
  if (stats[2]) { stats[2].textContent = `${avg}%`; stats[2].style.color = avg >= 60 ? 'var(--pass)' : 'var(--warn)'; }
  if (stats[3]) { stats[3].textContent = leftover; stats[3].style.color = leftover ? 'var(--fail)' : 'var(--pass)'; }
}

/* --------------------------------------------------------------- step 5-6 */

async function build() {
  reach('build');
  goto('build');
  const log = $('#buildLog');
  log.innerHTML = '';
  $('#buildOut').innerHTML = '';
  $('#buildBar').style.width = '10%';
  $('#btnPreview').hidden = true;
  $('#btnReport').hidden = true;
  $('#btnZip').hidden = true;
  $('#btnScore').hidden = true;

  const res = await post('/api/build', {
    siteUrl: state.siteUrl,
    mode: state.mode,
    componentize: state.componentize,
    llm: state.llm
  });
  for await (const ev of ndjson(res)) {
    if (ev.type === 'stage') { $('#buildLabel').textContent = ev.label; logLine(log, ev.label); }
    else if (ev.type === 'note') logLine(log, ev.text);
    // Fidelity mode's two long phases report their own progress. Without these the bar sits
    // at 10% through the slowest part of the run, which reads as a hang.
    else if (ev.type === 'progress') {
      $('#buildBar').style.width = `${10 + Math.round((ev.done / Math.max(ev.total, 1)) * 25)}%`;
      $('#buildLabel').textContent = `Rendering ${ev.done}/${ev.total} — ${ev.url ?? ''}`;
    } else if (ev.type === 'assets') {
      $('#buildBar').style.width = `${35 + Math.round((ev.done / Math.max(ev.total, 1)) * 20)}%`;
      $('#buildLabel').textContent = `Mirroring assets ${ev.done}/${ev.total}`;
    } else if (ev.type === 'generated') {
      $('#buildBar').style.width = '55%';
      logLine(log, `${ev.routes} routes · ${ev.media.downloaded} media downloaded, ${ev.media.failed.length} failed`, ev.media.failed.length ? 'wa' : 'ok');
      if (ev.parity) {
        const bad = ev.parity.fallbacks?.length ?? 0;
        logLine(log, `${ev.parity.ok}/${ev.parity.sections} sections emitted as real JSX${bad ? ` · ${bad} fell back to the runtime renderer` : ''}`, bad ? 'wa' : 'ok');
      }
      state.config = ev.config;
      if (ev.routeList?.length) state.routes = ev.routeList;
    } else if (ev.type === 'report') {
      $('#buildBar').style.width = '80%';
      state.report = ev;
      logLine(log, `report: ${ev.counts.pass} pass · ${ev.counts.warn} warn · ${ev.counts.fail} fail`, ev.counts.fail ? 'wa' : 'ok');
    } else if (ev.type === 'verify') {
      state.verify = ev.verify;
      $('#buildBar').style.width = '85%';
      renderVerify(ev.verify);
      for (const c of ev.verify.checks ?? []) logLine(log, `${c.label} — ${c.detail}`, c.pass ? 'ok' : 'no');
    } else if (ev.type === 'error') {
      logLine(log, ev.message, 'no');
    } else if (ev.type === 'done') {
      state.host = ev.host;
      $('#btnReport').hidden = false;
      $('#btnZip').hidden = false;
    }
  }

  // Generating a project you cannot look at is not a migration. Compile it, then let the
  // operator through to Preview — which is the step that used to show a 404.
  await compile(log);
}

async function compile(log) {
  $('#buildLabel').textContent = 'Compiling the generated project…';
  logLine(log, 'compiling — npm install (first run only) then next build');

  let ok = false;
  try {
    const res = await post('/api/compile', { siteUrl: state.siteUrl });
    for await (const ev of ndjson(res)) {
      if (ev.type === 'stage') { $('#buildLabel').textContent = ev.label; logLine(log, ev.label); }
      else if (ev.type === 'note') logLine(log, ev.text);
      else if (ev.type === 'compiled') { ok = true; logLine(log, `static export ready — ${ev.pages} pages`, 'ok'); }
      else if (ev.type === 'error') logLine(log, ev.message, 'no');
    }
  } catch (err) {
    logLine(log, String(err.message ?? err), 'no');
  }

  $('#buildBar').style.width = '100%';
  $('#buildLabel').textContent = ok ? 'Done — the export is built and previewable.' : 'Generated, but the build failed.';

  if (ok) {
    // Re-run the checks against the export that now exists; before it did, they could only
    // report "not built yet".
    try {
      const verify = await (await post('/api/verify', { siteUrl: state.siteUrl })).json();
      state.verify = verify;
      renderVerify(verify);
    } catch { /* the checks are a report, not a gate */ }

    reach('preview');
    $('#btnPreview').hidden = false;
    $('#btnScore').hidden = false;
    buildPreviewList();
  }
}


/**
 * Design fidelity and content fidelity, side by side and never averaged. Two bars because
 * they answer different questions — a page can carry every word and still look wrong, and
 * a blended figure hides whichever of those happened.
 */
async function score() {
  const log = $('#buildLog');
  const btn = $('#btnScore');
  btn.disabled = true;
  btn.textContent = 'Measuring…';
  logLine(log, 'comparing every page against the live site at 375, 768 and 1440');

  try {
    const res = await post('/api/score', { siteUrl: state.siteUrl });
    for await (const ev of ndjson(res)) {
      if (ev.type === 'stage') { $('#buildLabel').textContent = ev.label; logLine(log, ev.label); }
      else if (ev.type === 'progress') $('#buildLabel').textContent = `Scoring ${ev.done}/${ev.total} — ${ev.path} @ ${ev.width}px`;
      else if (ev.type === 'score') { state.score = ev.score; renderScore(ev.score); }
      else if (ev.type === 'smoke') {
        state.smoke = ev.smoke;
        for (const p of ev.smoke.pages ?? []) {
          logLine(log, `${p.path} — ${p.scripts ? `${p.scripts.ran}/${p.scripts.total} scripts ran` : 'no scripts'}${p.reasons?.length ? ' · ' + p.reasons[0] : ''}`, p.pass ? 'ok' : 'wa');
        }
      } else if (ev.type === 'error') logLine(log, ev.message, 'no');
    }
    $('#buildLabel').textContent = 'Measured.';
  } catch (err) {
    logLine(log, String(err.message ?? err), 'no');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Measure against the original';
  }
}

function renderScore(score) {
  if (score?.skipped) {
    $('#buildOut').insertAdjacentHTML('afterbegin',
      `<div class="note note--warn"><p>Visual scoring needs a browser engine — run <code>npx playwright install chromium</code>.</p></div>`);
    return;
  }
  const o = score.overall;
  const pct = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');
  const tone = (v, pass) => (v == null ? 'muted' : v >= pass ? 'pass' : v >= pass - 0.07 ? 'warn' : 'fail');
  const meter = (v, pass) =>
    `<span class="smeter"><i><b style="width:${v == null ? 0 : Math.min(v, 1) * 100}%;background:var(--${tone(v, pass)})"></b></i><em>${pct(v)}</em></span>`;

  const byPath = new Map();
  for (const p of score.pages ?? []) if (p.width === 1440 || !byPath.has(p.path)) byPath.set(p.path, p);

  const rows = [...byPath.values()].map((p) => `
    <div class="srow">
      <span class="spath" title="${esc(p.path)}">${esc(p.path)}</span>
      ${p.error ? `<span class="fail">did not render</span><span></span>` : meter(p.visual, 0.92) + meter(p.text, 0.95)}
    </div>`).join('');

  $('#buildOut').insertAdjacentHTML('afterbegin', `
    <div class="card" style="margin-bottom:16px">
      <span class="eyebrow">How much of the site came across</span>
      <div class="grid g3" style="margin:10px 0 14px">
        <div class="stat"><b style="color:var(--${tone(o.visual, 0.92)})">${pct(o.visual)}</b><span>design fidelity</span></div>
        <div class="stat"><b style="color:var(--${tone(o.text, 0.95)})">${pct(o.text)}</b><span>content fidelity</span></div>
        <div class="stat"><b style="color:var(--${tone(o.nodes, 0.95)})">${pct(o.nodes)}</b><span>node coverage</span></div>
      </div>
      <div class="scores"><div class="srow"><span class="spath" style="color:var(--muted)">page</span><span style="color:var(--muted);font-size:.76rem">design</span><span style="color:var(--muted);font-size:.76rem">content</span></div>${rows}</div>
      <p class="mode-help">Measured ${o.measured}/${o.total} page-widths at 375, 768 and 1440.
      Video and CSS animation are frozen on both sides first — two independent playbacks never
      share a frame, and scoring that would report video timing rather than migration quality.
      Design and content fidelity are shown separately and never averaged.</p>
    </div>`);
}

function renderVerify(v) {
  const rows = (v.checks ?? []).map((c) => `
    <div class="check">
      <span class="icon" style="color:${c.pass ? 'var(--pass)' : 'var(--fail)'}">${svg(c.pass ? 'i-check' : 'i-x', 17)}</span>
      <span class="label">${esc(c.label)}</span>
      <span class="detail">${esc(c.detail)}</span>
    </div>`).join('');

  const counts = state.report?.counts ?? {};
  $('#buildOut').innerHTML = `
    ${!v.built ? `<div class="note note--warn"><p>The site was generated but not compiled yet. Underpin Studio does not run <code>npm install</code> for you — build it, then re-run the checks.</p></div>` : ''}
    <div class="grid g4" style="margin-bottom:16px">
      <div class="stat"><b style="color:var(--pass)">${counts.pass ?? 0}</b><span>pages pass</span></div>
      <div class="stat"><b style="color:var(--warn)">${counts.warn ?? 0}</b><span>warn</span></div>
      <div class="stat"><b style="color:var(--fail)">${counts.fail ?? 0}</b><span>fail</span></div>
      <div class="stat"><b style="color:${v.passed ? 'var(--pass)' : 'var(--fail)'}">${v.passed ? 'PASS' : 'CHECK'}</b><span>acceptance</span></div>
    </div>
    <div class="card"><span class="eyebrow">Acceptance checks — read from the built export</span>${rows}</div>
    ${!v.built ? `<div class="card" style="margin-top:14px">
      <span class="eyebrow">Compile it</span>
      <pre class="mono" style="margin:0;font-size:.8rem;color:var(--fg-2);overflow-x:auto">cd sites/${esc(state.host)}/site
npm install &amp;&amp; npm run build</pre>
    </div>` : ''}`;
  $('#btnReport').onclick = () => window.open(`/report/${state.host}/report.html`, '_blank');
}

/* ----------------------------------------------------------------- step 6 */

const pv = { orig: true, mig: true, widths: new Set([375, 768, 1440]) };

function buildPreviewList() {
  // Prefer what was actually built. The review step is optional — and skipped entirely in
  // fidelity mode — so keying the preview off it left the picker empty on the exact path.
  const source = state.routes?.length
    ? state.routes.map((r) => ({ path: r.path, label: r.path }))
    : state.review.map((p) => ({ path: p.path, label: `${p.path} — ${p.chosen}` }));
  $('#pvPage').innerHTML = source
    .map((p) => `<option value="${esc(p.path)}">${esc(p.label)}</option>`).join('');
  renderPreview();
}

function renderPreview() {
  const path = $('#pvPage').value || '/';
  const stage = $('#pvStage');
  const widths = [...pv.widths].sort((a, b) => a - b);
  if (!widths.length || (!pv.orig && !pv.mig)) {
    stage.innerHTML = `<div class="empty" style="width:100%">${svg('i-empty', 40)}<p>Nothing selected to show.</p></div>`;
    return;
  }
  const origin = state.siteUrl ? new URL(state.siteUrl).origin : '';
  const frame = (src, w, label) => `
    <figure class="device" style="margin:0">
      <figcaption><span>${esc(label)}</span><span>${w}px</span></figcaption>
      <div class="frame" style="width:${w}px">
        <iframe src="${esc(src)}" width="${w}" height="760" loading="lazy" title="${esc(label)} ${w}px"
                sandbox="allow-same-origin allow-scripts allow-popups"></iframe>
      </div>
    </figure>`;

  stage.innerHTML = widths.flatMap((w) => [
    pv.orig ? frame(origin + path, w, 'Original') : '',
    pv.mig ? frame(`/preview/${state.host}${path}`, w, 'Migrated') : ''
  ]).filter(Boolean).join('');
}

/* ------------------------------------------------------------------- wire */

$('#btnInspect').addEventListener('click', inspect);
$('#url').addEventListener('keydown', (e) => { if (e.key === 'Enter') inspect(); });
$('#btnToScope').addEventListener('click', () => goto('scope'));
$('#btnToPages').addEventListener('click', saveScopeAndPick);
$('#btnMigrate').addEventListener('click', confirmSelectionAndMigrate);
$('#pickAll').addEventListener('click', () => {
  state.groups.forEach((_, gi) => setGroup(gi, true));
});
$('#pickNone').addEventListener('click', () => {
  state.groups.forEach((_, gi) => setGroup(gi, false));
});
$('#pageFilter').addEventListener('input', (e) => filterPages(e.target.value));
$('#btnZip').addEventListener('click', () => {
  window.location.href = `/api/zip?site=${encodeURIComponent(state.host)}`;
});
$('#btnBuild').addEventListener('click', build);
$('#btnScore').addEventListener('click', score);

function setMode(mode) {
  state.mode = mode;
  $('#modeFidelity').setAttribute('aria-pressed', String(mode === 'fidelity'));
  $('#modeTemplate').setAttribute('aria-pressed', String(mode === 'template'));
  $('#modeHelp').textContent = MODE_HELP[mode];
  // Componentisation splits a captured page; there is nothing to split in template mode,
  // where the sections are already separate components by construction.
  $('#optComponentize').disabled = mode !== 'fidelity';
}
$('#modeFidelity').addEventListener('click', () => setMode('fidelity'));
$('#modeTemplate').addEventListener('click', () => setMode('template'));
$('#optComponentize').addEventListener('change', (e) => { state.componentize = e.target.checked; });
$('#optLlm').addEventListener('change', (e) => { state.llm = e.target.checked; });
$('#btnPreview').addEventListener('click', () => { goto('preview'); renderPreview(); });
$('#pvPage').addEventListener('change', renderPreview);
$('#pvOrig').addEventListener('click', (e) => {
  pv.orig = !pv.orig; e.target.setAttribute('aria-pressed', String(pv.orig)); renderPreview();
});
$('#pvMig').addEventListener('click', (e) => {
  pv.mig = !pv.mig; e.target.setAttribute('aria-pressed', String(pv.mig)); renderPreview();
});
$$('[data-w]').forEach((b) => b.addEventListener('click', () => {
  const w = Number(b.dataset.w);
  pv.widths.has(w) ? pv.widths.delete(w) : pv.widths.add(w);
  b.setAttribute('aria-pressed', String(pv.widths.has(w)));
  renderPreview();
}));

// Say plainly whether a model is configured. An unexplained disabled checkbox is worse
// than no checkbox: the operator cannot tell a missing key from a broken feature.
fetch('/api/llm').then((r) => r.json()).then((s) => {
  const box = $('#optLlm');
  const label = $('#llmState');
  if (s.available) { label.textContent = `— ${s.model}`; return; }
  box.disabled = true;
  label.textContent = `— not configured (${s.reason}); rules will name them`;
}).catch(() => {});

state.current = 'source';
renderSteps();
loadRecent();
