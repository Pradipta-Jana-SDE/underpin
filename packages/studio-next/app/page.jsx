'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { streamPost, postJson } from '../lib/stream.js';

const STEPS = [
  { id: 'source',   label: 'Source',   sub: 'Enter a URL' },
  { id: 'findings', label: 'Findings', sub: 'What we found' },
  { id: 'scope',    label: 'Scope',    sub: 'Capabilities' },
  { id: 'pages',    label: 'Pages',    sub: 'Which to migrate' },
  { id: 'review',   label: 'Review',   sub: 'Confirm' },
  { id: 'build',    label: 'Build',    sub: 'Generate & verify' },
  { id: 'preview',  label: 'Preview',  sub: 'Side by side' }
];

/**
 * The phases of a build, in the order the pipeline runs them.
 *
 * `weight` is that phase's share of the progress bar, tuned to how long each actually takes
 * rather than split evenly — capture and compile dominate a real run, and a bar that moves
 * at a constant rate through phases of wildly different cost reads as stuck.
 */
const PHASES = [
  { id: 'capture', label: 'Capture pages',       hint: 'Rendering each page in a real browser',          weight: 30 },
  { id: 'assets',  label: 'Mirror assets',       hint: 'Downloading its stylesheets, scripts and images', weight: 20 },
  { id: 'emit',    label: 'Emit components',     hint: 'Writing JSX and checking it round-trips',        weight: 8 },
  { id: 'report',  label: 'Write the report',    hint: 'Grading every page',                             weight: 4 },
  { id: 'verify',  label: 'Acceptance checks',   hint: 'The checks that can be made mechanically',       weight: 3 },
  { id: 'install', label: 'Install dependencies', hint: 'next, react and react-dom',                     weight: 10 },
  { id: 'compile', label: 'Compile the project', hint: 'next build, to a static export',                 weight: 25 }
];

/** Which phase a stage label belongs to. The pipeline names its stages for humans, not for us. */
function phaseForStage(label = '') {
  const l = label.toLowerCase();
  if (l.includes('browser')) return 'capture';
  if (l.includes('mirroring')) return 'assets';
  if (l.includes('emitting') || l.includes('naming sections')) return 'emit';
  if (l.includes('report')) return 'report';
  if (l.includes('acceptance')) return 'verify';
  if (l.includes('installing')) return 'install';
  if (l.includes('static export')) return 'compile';
  return null;
}

export default function Studio() {
  const [step, setStep] = useState('source');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const [site, setSite] = useState(null);
  const [chain, setChain] = useState([]);
  const [decisions, setDecisions] = useState({});
  const [plan, setPlan] = useState(null);
  const [pages, setPages] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [filter, setFilter] = useState('');

  const [log, setLog] = useState([]);
  const [activity, setActivity] = useState(null);
  const [phase, setPhase] = useState(null);
  const [phaseDone, setPhaseDone] = useState(new Set());
  const [counts, setCounts] = useState({});
  const [result, setResult] = useState(null);
  const [verify, setVerify] = useState(null);
  const [compiled, setCompiled] = useState(null);
  const logRef = useRef(null);

  const note = useCallback((text, tone = '') => {
    setLog((l) => [...l.slice(-500), { text, tone }]);
    queueMicrotask(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight));
  }, []);

  const reached = useMemo(() => STEPS.findIndex((s) => s.id === step), [step]);

  /**
   * Overall progress: every finished phase's full weight, plus the running phase's own
   * share of its own weight. Derived rather than stored, so the bar can never disagree
   * with the phase list underneath it.
   */
  const pct = useMemo(() => {
    let total = 0;
    for (const p of PHASES) {
      if (phaseDone.has(p.id)) { total += p.weight; continue; }
      if (p.id === phase) {
        const c = counts[p.id];
        // A phase that reports counts fills proportionally; one that does not sits at half,
        // which still shows movement without inventing precision it does not have.
        total += p.weight * (c?.total ? Math.min(c.done / c.total, 1) : 0.5);
      }
    }
    return Math.min(Math.round(total), 100);
  }, [phase, phaseDone, counts]);

  const enterPhase = useCallback((id) => {
    if (!id) return;
    setPhase(id);
    // Everything before this one is finished, even if its own event never arrived —
    // a skipped phase must not leave a spinner running forever.
    setPhaseDone((done) => {
      const idx = PHASES.findIndex((p) => p.id === id);
      const next = new Set(done);
      PHASES.slice(0, idx).forEach((p) => next.add(p.id));
      return next;
    });
  }, []);

  const finishPhase = useCallback((id) => setPhaseDone((d) => new Set(d).add(id)), []);
  const setCount = useCallback((id, done, total) => setCounts((c) => ({ ...c, [id]: { done, total } })), []);

  /* ------------------------------------------------------------- 1. inspect */
  async function inspect() {
    if (!url.trim()) return setError('Enter a site URL first.');
    setBusy(true); setError(null); setLog([]); setChain([]); setSite(null); setStep('findings');
    try {
      await streamPost('/api/inspect', { url }, (ev) => {
        if (ev.type === 'stage') { setActivity(ev.label); note(ev.label); }
        else if (ev.type === 'chain') {
          setChain((c) => [...c, ev]);
          note(`  ${ev.step}${ev.url ? ` → ${ev.url}` : ''}${ev.urls != null ? ` (${ev.urls} URLs)` : ''}`);
        }
        else if (ev.type === 'discovered') note(`  ${ev.urls} URLs discovered${ev.rest?.reachable ? ', REST API reachable' : ''}`, 'ok');
        else if (ev.type === 'error') throw new Error(ev.message);
        else if (ev.type === 'done') {
          setSite(ev);
          const d = {};
          for (const q of ev.questions) d[q.id] = (q.options.find((o) => o.recommended) ?? q.options[0])?.value;
          setDecisions(d);
          note(`  builder: ${ev.builder ?? 'none detected'}`, 'ok');
        }
      });
      setActivity(null);
    } catch (e) { setError(e.message); setActivity(null); }
    setBusy(false);
  }

  /* --------------------------------------------------------------- 2. scope */
  async function agreeScope() {
    setBusy(true); setError(null);
    try {
      const { plan } = await postJson('/api/scope', { siteUrl: site.siteUrl, decisions });
      setPlan(plan);
      const p = await postJson('/api/pages', { siteUrl: site.siteUrl });
      setPages(p);
      setPicked(new Set(p.selected ?? p.groups.flatMap((g) => g.pages.map((x) => x.url))));
      setStep('pages');
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  /* --------------------------------------------------------------- 3. pages */
  async function confirmPages() {
    setBusy(true); setError(null);
    try {
      await postJson('/api/select', { siteUrl: site.siteUrl, urls: [...picked] });
      setStep('review');
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  const toggle = (u) => setPicked((s) => {
    const next = new Set(s);
    next.has(u) ? next.delete(u) : next.add(u);
    return next;
  });

  /* ------------------------------------------------------- 4. build + compile */
  async function build() {
    setBusy(true); setError(null); setLog([]); setStep('build');
    setResult(null); setVerify(null); setCompiled(null);
    setPhase(null); setPhaseDone(new Set()); setCounts({});
    let captured = 0;
    try {
      await streamPost('/api/build', { siteUrl: site.siteUrl, componentize: true }, (ev) => {
        if (ev.type === 'stage') { enterPhase(phaseForStage(ev.label)); setActivity(ev.label); note(ev.label); }
        else if (ev.type === 'progress') {
          enterPhase('capture');
          setCount('capture', ev.done, ev.total);
          setActivity(`Rendering ${ev.done} of ${ev.total} — ${shortUrl(ev.url)}`);
        }
        else if (ev.type === 'assets') {
          enterPhase('assets');
          setCount('assets', ev.done, ev.total);
          setActivity(`Mirroring assets — ${ev.done} of ${ev.total}`);
        }
        else if (ev.type === 'note') note(`  ${ev.text}`);
        else if (ev.type === 'generated') {
          finishPhase('assets'); finishPhase('emit');
          captured = ev.routes;
          setResult(ev);
          note(`  ${ev.routes} routes · ${ev.media?.downloaded ?? 0} assets re-hosted`, 'ok');
          for (const f of ev.captureFailures ?? []) note(`  could not capture ${f.url} — ${f.error}`, 'no');
          if (ev.parity) {
            const bad = ev.parity.fallbacks?.length ?? 0;
            note(`  ${ev.parity.ok}/${ev.parity.sections} sections emitted as real JSX${bad ? ` · ${bad} fell back` : ''}`, bad ? 'wa' : 'ok');
          }
        }
        else if (ev.type === 'report') { finishPhase('report'); note(`  report: ${ev.counts.pass} pass · ${ev.counts.warn} warn · ${ev.counts.fail} fail`, ev.counts.fail ? 'wa' : 'ok'); }
        else if (ev.type === 'verify') {
          finishPhase('verify'); setVerify(ev.verify);
          for (const c of ev.verify.checks ?? []) note(`  ${c.label ?? c.id} — ${c.detail ?? ''}`, c.pass ? 'ok' : 'no');
        }
        else if (ev.type === 'error') throw new Error(ev.message);
      });

      // Nothing was captured, so there is nothing to compile. Running the build anyway
      // buries the real problem — an origin that refused every page — under a webpack
      // error about the empty project it produced.
      if (captured === 0) {
        setActivity(null); setPhase(null); setBusy(false);
        return;
      }

      await streamPost('/api/compile', { siteUrl: site.siteUrl }, (ev) => {
        if (ev.type === 'stage') { enterPhase(phaseForStage(ev.label)); setActivity(ev.label); note(ev.label); }
        else if (ev.type === 'note') note(`  ${ev.text}`);
        else if (ev.type === 'compiled') {
          finishPhase('install'); finishPhase('compile');
          setCompiled(ev.pages);
          note(`  ${ev.pages} static pages exported`, 'ok');
        }
        else if (ev.type === 'error') throw new Error(ev.message);
      });

      // The checks reported during the build ran before the project existed, so the export
      // check could only fail. Re-run them now that there is something on disk — otherwise
      // the run ends by reporting a failure at the moment it actually succeeded.
      // Drop the stale results first. Leaving them up means the failed export check stays
      // on screen — next to a Preview button that works — for as long as the recheck takes.
      setVerify(null);
      setActivity('Re-running the acceptance checks against the export');
      const rechecked = await postJson('/api/verify', { siteUrl: site.siteUrl });
      setVerify(rechecked);
      for (const c of rechecked.checks ?? []) note(`  ${c.label ?? c.id} — ${c.detail ?? ''}`, c.pass ? 'ok' : 'no');

      setActivity(null); setPhase(null);
    } catch (e) { setError(e.message); setActivity(null); setPhase(null); }
    setBusy(false);
  }

  const visibleGroups = useMemo(() => {
    if (!pages) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return pages.groups;
    return pages.groups
      .map((g) => ({ ...g, pages: g.pages.filter((x) => x.path.toLowerCase().includes(q)) }))
      .filter((g) => g.pages.length);
  }, [pages, filter]);

  const checksPassed = verify?.checks?.filter((c) => c.pass).length ?? 0;

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">Underpin<span className="mono"> studio</span></div>
        <ul className="steps">
          {STEPS.map((s, i) => (
            <li key={s.id}>
              <span
                className={`step${s.id === step ? ' on' : ''}${i < reached ? ' done' : ''}`}
                aria-current={s.id === step ? 'step' : undefined}
              >
                <span className="n">{i < reached ? '✓' : i + 1}</span>
                <span>{s.label}<span className="sub">{s.sub}</span></span>
              </span>
            </li>
          ))}
        </ul>
        <div className="rail-foot">
          <p>{site?.host ?? 'No site loaded'}</p>
          <p>No API key required — rules resolve most pages.</p>
        </div>
      </aside>

      <main className="panel">
        {error && <div className="err"><strong>That failed.</strong> {error}</div>}

        {/* ------------------------------------------------------- source */}
        {step === 'source' && (
          <section className="card">
            <h1>Point it at a website</h1>
            <p className="help">
              Nothing is crawled yet. The next step walks the discovery chain and works out what
              the site actually runs, so you can decide what to migrate before anything expensive happens.
            </p>
            <div className="field">
              <label htmlFor="url">Site URL</label>
              <input
                type="url" id="url" value={url} placeholder="https://example.com"
                spellCheck={false} autoComplete="url"
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !busy && inspect()}
              />
              <span className="help">Public pages only. Anything behind a login is flagged, never bypassed.</span>
            </div>
            <div className="actions">
              <button className="btn btn--primary" onClick={inspect} disabled={busy}>
                {busy ? 'Inspecting…' : 'Inspect the site'}
              </button>
            </div>
          </section>
        )}

        {/* ----------------------------------------------------- findings */}
        {step === 'findings' && (
          <section className="card">
            <h1>What we found</h1>
            <p className="help">
              Every line below is something the tool observed, not an assumption about how
              WordPress is usually set up.
            </p>

            {busy && <Working label={activity ?? 'Working…'} />}

            {chain.length > 0 && (
              <>
                <h3>Discovery chain</h3>
                <ul className="chain">
                  {chain.map((c, i) => (
                    <li key={i}>
                      <span className={`tick ${c.found === false ? 'no' : 'ok'}`}>{c.found === false ? '×' : '✓'}</span>
                      <span className="mono">{c.step}</span>
                      <span className="detail">
                        {c.url ? shortUrl(c.url) : ''}
                        {c.urls != null ? ` — ${c.urls} URLs` : ''}
                        {c.sitemaps != null ? ` — ${c.sitemaps} sitemap${c.sitemaps === 1 ? '' : 's'}` : ''}
                        {c.reachable != null ? (c.reachable ? ' — reachable' : ' — not reachable') : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {site && (
              <>
                <div className="grid g4">
                  <Stat v={site.urls} k="URLs discovered" />
                  <Stat v={site.builder ?? 'none'} k="Page builder" />
                  <Stat v={site.capabilities?.length ?? 0} k="Capabilities found" />
                  <Stat v={site.questions.length} k="Decisions for you" />
                </div>
                <div className="actions">
                  <button className="btn btn--primary" onClick={() => setStep('scope')}>Continue to scope</button>
                </div>
              </>
            )}

            <LogBox log={log} logRef={logRef} />
          </section>
        )}

        {/* -------------------------------------------------------- scope */}
        {step === 'scope' && site && (
          <section className="card">
            <h1>The decisions this tool will not make for you</h1>
            <p className="help">
              Every excluded URL gets a routing policy — gone, redirected, or still served by the
              old system. A bare 404 is never an option, because it strands links that are already indexed.
            </p>
            {site.questions.length === 0 && (
              <p className="note">Nothing here needs a decision — the whole site is in scope.</p>
            )}
            {site.questions.map((q) => (
              <div key={q.id} className="field">
                <label>{q.question}</label>
                {q.evidence?.length > 0 && (
                  <ul className="evidence">
                    {q.evidence.slice(0, 3).map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                )}
                <div className="mode-row">
                  {q.options.map((o) => (
                    <label key={o.value} className={`seg ${decisions[q.id] === o.value ? 'on' : ''}`}>
                      <input
                        type="radio" name={q.id} value={o.value}
                        checked={decisions[q.id] === o.value}
                        onChange={() => setDecisions((d) => ({ ...d, [q.id]: o.value }))}
                      />
                      <span>{o.label}{o.recommended ? ' · recommended' : ''}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <div className="actions">
              <button className="btn btn--primary" onClick={agreeScope} disabled={busy}>
                {busy ? 'Working…' : 'Agree scope'}
              </button>
            </div>
          </section>
        )}

        {/* -------------------------------------------------------- pages */}
        {step === 'pages' && pages && (
          <section className="card">
            <h1>Which pages to migrate</h1>
            <p className="help">
              Grouped from URL shape alone — nothing has been fetched. <strong>Only ticked pages
              are ever crawled</strong>, which is the whole point of choosing before extracting.
            </p>
            <div className="pick-bar">
              <input type="text" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <span className="spacer" />
              <span className="mono">{picked.size} of {pages.total} selected</span>
              <button className="btn btn--sm" onClick={() => setPicked(new Set(pages.groups.flatMap((g) => g.pages.map((x) => x.url))))}>All</button>
              <button className="btn btn--sm" onClick={() => setPicked(new Set())}>None</button>
            </div>
            <div className="tw">
              {visibleGroups.map((g) => (
                <div key={g.type}>
                  <h3>{g.type.replace(/_/g, ' ')} <span className="mono">({g.pages.length})</span></h3>
                  {g.pages.slice(0, 400).map((x) => (
                    <label key={x.url} className="toggle">
                      <input type="checkbox" checked={picked.has(x.url)} onChange={() => toggle(x.url)} />
                      <span className="mono">{x.path}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <div className="actions">
              <button className="btn btn--primary" onClick={confirmPages} disabled={busy || !picked.size}>
                Confirm {picked.size} page{picked.size === 1 ? '' : 's'}
              </button>
            </div>
          </section>
        )}

        {/* ------------------------------------------------------- review */}
        {step === 'review' && (
          <section className="card">
            <h1>Ready to build</h1>
            <div className="grid g4">
              <Stat v={picked.size} k="Pages selected" />
              <Stat v={plan?.pages?.excluded ?? 0} k="Excluded, with a policy" />
              <Stat v={site?.builder ?? 'none'} k="Builder" />
              <Stat v="fidelity" k="Mode" />
            </div>
            <p className="help">
              Fidelity mode renders each page in a real browser and keeps its DOM, its own
              stylesheets and its animation scripts — all re-hosted, so nothing calls the old site
              at runtime. Then it compiles the project and runs the acceptance checks.
            </p>
            <p className="note">
              This takes a few minutes on a real site. Every phase reports as it goes.
            </p>
            <div className="actions">
              <button className="btn btn--primary" onClick={build} disabled={busy}>Build the site</button>
            </div>
          </section>
        )}

        {/* -------------------------------------------------------- build */}
        {step === 'build' && (
          <section className="card">
            <h1>Generating and verifying</h1>

            <div className="prog">
              <div className="prog-head">
                <span className="prog-label">{activity ?? (compiled != null ? 'Finished' : 'Starting…')}</span>
                <span className="prog-pct mono">{pct}%</span>
              </div>
              <div className="bar"><i style={{ width: `${pct}%` }} /></div>
            </div>

            <ul className="phases">
              {PHASES.map((p) => {
                const done = phaseDone.has(p.id);
                const active = p.id === phase;
                const c = counts[p.id];
                return (
                  <li key={p.id} className={done ? 'done' : active ? 'active' : ''}>
                    <span className="tick">{done ? '✓' : active ? '●' : '○'}</span>
                    <span>
                      {p.label}
                      <span className="sub">{p.hint}</span>
                    </span>
                    <span className="mono count">
                      {done ? 'done' : c?.total ? `${c.done}/${c.total}` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>

            {result?.captureFailures?.length > 0 && (
              <div className="err">
                <strong>
                  {result.captureFailures.length} page{result.captureFailures.length === 1 ? '' : 's'} could not be captured
                  {result.routes === 0 ? ', so there was nothing to build' : ''}.
                </strong>
                <ul>
                  {result.captureFailures.slice(0, 6).map((f, i) => (
                    <li key={i}><span className="mono">{shortUrl(f.url)}</span> — {f.error}</li>
                  ))}
                </ul>
              </div>
            )}

            {(result || compiled != null) && (
              <div className="grid g4">
                <Stat v={result?.routes ?? '—'} k="Routes generated" />
                <Stat v={result?.media?.downloaded ?? '—'} k="Assets re-hosted" />
                <Stat v={compiled ?? '—'} k="Static pages exported" />
                <Stat v={verify ? `${checksPassed}/${verify.checks.length}` : '—'} k="Acceptance checks" />
              </div>
            )}

            {result?.parity && (
              <p className="note">
                <strong>{result.parity.ok}/{result.parity.sections}</strong> sections were emitted as
                real JSX and round-trip to the DOM they came from
                {result.parity.fallbacks?.length
                  ? ` · ${result.parity.fallbacks.length} fell back to the runtime renderer`
                  : ' — none fell back'}.
              </p>
            )}

            {!verify && compiled != null && busy && (
              <Working label="Re-checking the export against the acceptance criteria" />
            )}

            {verify && (
              <>
                <h3>Acceptance checks</h3>
                <ul className="checks">
                  {verify.checks.map((c) => (
                    <li key={c.id} className={c.pass ? 'ok' : 'no'}>
                      <span className="tick">{c.pass ? '✓' : '×'}</span>
                      <span>{c.label ?? c.id}<span className="sub">{c.detail}</span></span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {compiled != null && (
              <div className="actions">
                <button className="btn btn--primary" onClick={() => setStep('preview')}>Preview it</button>
                <a className="btn" href={`/api/zip?site=${encodeURIComponent(site.host)}`} download>
                  Download the project
                </a>
              </div>
            )}

            <LogBox log={log} logRef={logRef} open={busy} />
          </section>
        )}

        {/* ------------------------------------------------------ preview */}
        {step === 'preview' && site && (
          <section className="card">
            <h1>The original and the migration</h1>
            <div className="pv-bar">
              <span className="mono">{site.siteUrl}</span>
              <span className="spacer" />
              <a className="btn btn--sm" href={`/preview/${site.host}/`} target="_blank" rel="noreferrer">
                Open the migration in a tab
              </a>
              <a className="btn btn--sm" href={`/api/zip?site=${encodeURIComponent(site.host)}`} download>
                Download the project
              </a>
            </div>
            <div className="grid g2">
              <div>
                <h3>Original</h3>
                <iframe title="Original" className="pv-frame" src={site.siteUrl} />
              </div>
              <div>
                <h3>Migrated</h3>
                <iframe title="Migrated" className="pv-frame" src={`/preview/${site.host}/`} />
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

const shortUrl = (u) => {
  if (!u) return '';
  try { return new URL(u).pathname || '/'; } catch { return String(u).slice(0, 60); }
};

/** An indeterminate phase — something is happening but it cannot say how far along. */
function Working({ label }) {
  return (
    <div className="working">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function Stat({ v, k }) {
  return (
    <div className="stat">
      <strong>{v}</strong>
      <span>{k}</span>
    </div>
  );
}

/**
 * The raw event log, collapsed by default.
 *
 * The phase list above answers "what is happening"; this answers "what exactly did it say",
 * which matters when something fails and not before.
 */
function LogBox({ log, logRef, open = false }) {
  if (!log.length) return null;
  return (
    <details className="logbox" open={open}>
      <summary>Detailed log <span className="mono">({log.length} lines)</span></summary>
      <pre className="log" ref={logRef}>
        {log.map((l, i) => (
          <span key={i} className={l.tone}>{l.text}{'\n'}</span>
        ))}
      </pre>
    </details>
  );
}
