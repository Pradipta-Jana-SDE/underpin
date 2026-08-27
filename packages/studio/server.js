#!/usr/bin/env node
/**
 * Underpin Studio — a local UI for the migration pipeline.
 *
 * Deliberately dependency-free: node:http plus static files. Adding a server framework
 * to a tool whose whole point is removing runtime dependencies would be a poor look, and
 * there is nothing here that warrants one.
 *
 * Long-running stages stream NDJSON so the browser can show real progress instead of a
 * spinner that tells the operator nothing.
 */
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, extname, resolve, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipDirectory } from './zip.js';

import { discover } from '@underpin/importer/src/discover/index.js';
import { fingerprint } from '@underpin/importer/src/fingerprint/index.js';
import { optionsFor } from '@underpin/importer/src/scope/options.js';
import { extractSite, extractionStats } from '@underpin/importer/src/extract/index.js';
import { classifyAll, groupUrlsByType } from '@underpin/importer/src/classify/index.js';
import { matchAll, rankTemplates, mapToTemplate } from '@underpin/importer/src/match/index.js';
import { generateSite } from '@underpin/importer/src/generate/index.js';
import { writeReport } from '@underpin/importer/src/report/index.js';
import { reuseMatrix } from '@underpin/importer/src/report/reuse.js';
import { verifyBuild } from '@underpin/importer/src/verify/index.js';
import { MigrationPlan } from '@underpin/schema';
import { TEMPLATES } from '@underpin/templates/manifests';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const SITES = join(ROOT, 'sites');
const PORT = Number(process.env.PORT ?? 4400);

const hostOf = (url) => new URL(url).host.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '-');
const dirFor = (url) => join(SITES, hostOf(url));
const readJson = (p, fb = null) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fb);
const writeJson = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2));
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8'
};

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

/** NDJSON stream: one event per line, flushed immediately. */
function stream(res) {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no'
  });
  return {
    send: (event) => res.write(JSON.stringify(event) + '\n'),
    end: () => res.end()
  };
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/* --------------------------------------------------------------- handlers */

async function listSites() {
  if (!existsSync(SITES)) return [];
  const dirs = await readdir(SITES);
  const out = [];
  for (const d of dirs) {
    const base = join(SITES, d);
    const plan = readJson(join(base, 'migration.plan.json'));
    if (!plan) continue;
    const matches = readJson(join(base, 'template-plan.json'), []);
    const verify = readJson(join(base, '_migration', 'verify.json'));
    out.push({
      host: d,
      site: plan.site,
      decidedAt: plan.decidedAt,
      pages: matches.length,
      inScope: plan.pages?.inScope ?? 0,
      excluded: plan.pages?.excluded ?? 0,
      built: existsSync(join(base, 'site', 'out')),
      verified: verify?.passed ?? null,
      checks: verify?.checks?.length ?? 0
    });
  }
  return out.sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt)));
}

/** Stage 1+2: discover and fingerprint, returning the questions a human must answer. */
async function handleInspect(req, res) {
  const { url } = await body(req);
  if (!url) return json(res, 400, { error: 'A site URL is required.' });

  let siteUrl;
  try {
    siteUrl = new URL(url.startsWith('http') ? url : `https://${url}`).toString();
  } catch {
    return json(res, 400, { error: `Not a usable URL: ${url}` });
  }

  const s = stream(res);
  try {
    s.send({ type: 'stage', stage: 'discover', label: 'Walking the discovery chain' });
    const d = await discover(siteUrl);
    for (const c of d.chain) s.send({ type: 'chain', ...c });
    s.send({ type: 'discovered', urls: d.urls.length, blockedByRobots: d.blockedByRobots, rest: d.rest, viaLinkCrawl: d.viaLinkCrawl });

    s.send({ type: 'stage', stage: 'fingerprint', label: 'Fingerprinting what the site actually runs' });
    const fp = await fingerprint(d);

    const questions = fp.needsDecision
      .map((cap) => {
        const set = optionsFor(cap);
        if (!set) return null;
        return {
          id: cap.id,
          label: cap.label,
          confidence: cap.confidence,
          signalClasses: cap.signalClasses ?? [],
          evidence: cap.evidence ?? [],
          detected: cap.detected ?? {},
          question: set.question,
          options: set.options.map((o) => ({
            value: o.value, label: o.label, detail: o.detail, recommended: Boolean(o.recommended)
          })),
          unavailable: set.unavailable ?? []
        };
      })
      .filter(Boolean);

    const out = dirFor(siteUrl);
    mkdirSync(out, { recursive: true });
    writeJson(join(out, 'discovery.json'), { ...d, urls: d.urls.slice(0, 5000) });
    writeJson(join(out, 'fingerprint.json'), fp);

    s.send({
      type: 'done',
      siteUrl,
      host: hostOf(siteUrl),
      builder: fp.builder,
      capabilities: fp.capabilities,
      questions,
      urls: d.urls.length
    });
  } catch (err) {
    s.send({ type: 'error', message: String(err?.message ?? err) });
  }
  s.end();
}

/** Stage 3: record the operator's decisions as the scope contract. */
async function handleScope(req, res) {
  const { siteUrl, decisions } = await body(req);
  if (!siteUrl) return json(res, 400, { error: 'siteUrl required' });
  const out = dirFor(siteUrl);
  const d = readJson(join(out, 'discovery.json'));
  const fp = readJson(join(out, 'fingerprint.json'));
  if (!d || !fp) return json(res, 400, { error: 'Run inspect first.' });

  const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
  const chosen = [];
  for (const cap of fp.needsDecision) {
    const set = optionsFor(cap);
    if (!set) continue;
    const picked = set.options.find((o) => o.value === decisions?.[cap.id]) ?? set.options.find((o) => o.recommended) ?? set.options[0];
    chosen.push({
      id: cap.id, label: cap.label, detected: cap.detected ?? {}, evidence: cap.evidence ?? [],
      disposition: picked.value, urlPolicy: picked.urlPolicy ?? {}, redirectTarget: null,
      locales: cap.detected?.locales ?? [], note: picked.label
    });
  }

  const rules = chosen.flatMap((c) =>
    Object.entries(c.urlPolicy ?? {}).map(([glob, policy]) => ({ re: globToRe(glob), policy, capability: c.id, glob }))
  );
  const inScope = [];
  const excluded = [];
  for (const u of d.urls) {
    let path;
    try { path = new URL(u.loc).pathname; } catch { continue; }
    const hit = rules.find((r) => r.re.test(path));
    if (!hit || hit.policy === 'migrate') inScope.push(u.loc);
    else excluded.push({ url: u.loc, reason: `${hit.capability}: ${hit.glob}`, policy: hit.policy });
  }
  const exclusionReasons = {};
  for (const e of excluded) exclusionReasons[e.reason] = (exclusionReasons[e.reason] ?? 0) + 1;

  const plan = MigrationPlan.parse({
    site: siteUrl, planVersion: 1, decidedAt: new Date().toISOString(), decidedBy: 'studio',
    capabilities: chosen,
    pages: { total: d.urls.length, inScope: inScope.length, excluded: excluded.length, exclusionReasons },
    inScopeUrls: inScope, excludedUrls: excluded
  });
  writeJson(join(out, 'migration.plan.json'), plan);
  json(res, 200, { plan: { ...plan, inScopeUrls: [], excludedUrls: excluded.slice(0, 50) } });
}

/**
 * The page inventory, grouped by type.
 *
 * Classified from URL shape alone — the whole point of choosing pages is to avoid
 * crawling the ones nobody wants, so nothing is fetched to build this list.
 */
async function handlePages(req, res) {
  const { siteUrl } = await body(req);
  const out = dirFor(siteUrl);
  const plan = readJson(join(out, 'migration.plan.json'));
  if (!plan) return json(res, 400, { error: 'Agree scope first.' });

  const groups = groupUrlsByType(plan.inScopeUrls);
  json(res, 200, {
    total: plan.inScopeUrls.length,
    excluded: plan.pages?.excluded ?? 0,
    groups,
    // Everything is selected unless the operator says otherwise; a picker that starts
    // empty makes the common case (migrate the whole site) the most work.
    selected: plan.selectedUrls ?? null
  });
}

/** Records which pages the operator actually wants. */
async function handleSelect(req, res) {
  const { siteUrl, urls } = await body(req);
  const out = dirFor(siteUrl);
  const plan = readJson(join(out, 'migration.plan.json'));
  if (!plan) return json(res, 400, { error: 'Agree scope first.' });
  if (!Array.isArray(urls) || !urls.length) {
    return json(res, 400, { error: 'Select at least one page.' });
  }

  const inScope = new Set(plan.inScopeUrls);
  const selected = urls.filter((u) => inScope.has(u));
  plan.selectedUrls = selected;
  plan.pages = { ...plan.pages, selected: selected.length };
  writeJson(join(out, 'migration.plan.json'), plan);
  json(res, 200, { selected: selected.length, of: plan.inScopeUrls.length });
}

/** Packages the generated site as a downloadable zip. */
async function handleZip(req, res, url) {
  const host = url.searchParams.get('site');
  if (!host) return json(res, 400, { error: 'site required' });
  const dir = join(SITES, host, 'site');
  if (!existsSync(dir)) return json(res, 404, { error: 'Nothing generated for that site yet.' });

  // Source, not build artefacts: node_modules and .next are reproducible from
  // package.json and would multiply the download by two orders of magnitude.
  //
  // The workspace packages the site depends on are vendored in and every path rewritten,
  // because inside the monorepo they resolve via `file:../../../packages/...` and in a
  // zip that path leads nowhere. Vendoring just the template package is not enough — it
  // depends on @underpin/schema and @underpin/vocabulary in turn, and npm goes to the
  // registry for anything it cannot find on disk, which 404s.
  const WORKSPACE = ['templates', 'schema', 'vocabulary'];
  const vendorName = (n) => `underpin-${n}`;
  const vendored = WORKSPACE
    .map((n) => ({ name: n, dir: resolve(ROOT, 'packages', n) }))
    .filter((w) => existsSync(w.dir));

  /** Repoints every @underpin/* dependency at its vendored sibling. */
  const repoint = (text, depth) => {
    const pkg = JSON.parse(text);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const dep of Object.keys(pkg[field] ?? {})) {
        const m = /^@underpin\/(.+)$/.exec(dep);
        if (!m) continue;
        pkg[field][dep] = depth === 0
          ? `file:./vendor/${vendorName(m[1])}`
          : `file:../${vendorName(m[1])}`;
      }
    }
    return JSON.stringify(pkg, null, 2) + '\n';
  };

  const rewrite = { 'package.json': (t) => repoint(t, 0) };
  for (const w of vendored) {
    rewrite[`vendor/${vendorName(w.name)}/package.json`] = (t) => repoint(t, 1);
  }

  const { buffer, count } = zipDirectory(dir, {
    // The lockfile is monorepo-specific: it pins the old file: paths and npm trusts it
    // over the rewritten package.json, so it must not travel.
    ignore: ['node_modules', '.next', 'out', 'package-lock.json'],
    extra: vendored.map((w) => ({
      root: w.dir,
      prefix: join('vendor', vendorName(w.name)),
      ignore: ['node_modules']
    })),
    rewrite
  });

  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': buffer.length,
    'x-file-count': String(count),
    'content-disposition': `attachment; filename="${host.replace(/[^a-z0-9.-]/gi, '-')}-nextjs.zip"`
  });
  res.end(buffer);
}

/** Stages 4-6: extract, classify, match. Streams per-page progress. */
async function handleMigrate(req, res) {
  const { siteUrl, limit } = await body(req);
  const out = dirFor(siteUrl);
  const plan = readJson(join(out, 'migration.plan.json'));
  const d = readJson(join(out, 'discovery.json'));
  const fp = readJson(join(out, 'fingerprint.json'));
  if (!plan) return json(res, 400, { error: 'Agree scope first.' });

  const s = stream(res);
  try {
    s.send({ type: 'stage', stage: 'extract', label: `Extracting ${limit ? `a ${limit}-page sample` : `${plan.inScopeUrls.length} pages`}` });
    // A selection replaces the sample: the operator has already said which pages matter,
    // so stratified sampling would be second-guessing them.
    const planForRun = plan.selectedUrls?.length
      ? { ...plan, inScopeUrls: plan.selectedUrls }
      : plan;

    const { siteIr, pages, failed } = await extractSite({
      origin: new URL(siteUrl).origin, plan: planForRun,
      discovery: { ...d, builder: fp.builder },
      limit: plan.selectedUrls?.length ? null : (limit || null),
      onProgress: (done, total, url) => s.send({ type: 'progress', done, total, url })
    });
    writeJson(join(out, 'site.ir.json'), siteIr);
    writeJson(join(out, 'ir', 'pages.json'), pages);
    const stats = extractionStats(pages);
    writeJson(join(out, 'extraction-stats.json'), { ...stats, failed });
    s.send({ type: 'extracted', siteIr, stats, failed: failed.length });

    s.send({ type: 'stage', stage: 'classify', label: 'Classifying pages and scoring templates' });
    const classifications = await classifyAll(pages, { nav: siteIr.nav.primary }, null);
    const matches = matchAll(pages, classifications);
    writeJson(join(out, 'classifications.json'), classifications);
    writeJson(join(out, 'template-plan.json'), matches);

    // Everything the review table needs, including alternatives so a change is one click.
    const review = matches.map((m) => {
      const page = pages.find((p) => p.url === m.url);
      return {
        url: m.url, path: m.path, title: page?.seo?.title ?? '',
        pageType: m.pageType, pageTypeConfidence: m.pageTypeConfidence,
        needsReview: m.pageTypeNeedsReview,
        chosen: m.chosen, matchConfidence: m.matchConfidence,
        alternatives: rankTemplates(page, m.pageType).map((r) => ({
          templateId: r.templateId, label: r.label, confidence: r.confidence, missingRequired: r.missingRequired
        })),
        sections: (page?.sections ?? []).map((sec) => ({
          archetype: sec.archetype, confidence: sec.confidence, decidedBy: sec.decidedBy,
          items: Array.isArray(sec.slots?.items) ? sec.slots.items.length : null,
          incomplete: sec.incompleteCapture
        })),
        leftover: m.leftover.length, missingRequired: m.missingRequired, builder: page?.source?.builder
      };
    });
    s.send({ type: 'done', review, templates: TEMPLATES.map((t) => ({ id: t.id, label: t.label, pageType: t.pageType })) });
  } catch (err) {
    s.send({ type: 'error', message: String(err?.message ?? err) });
  }
  s.end();
}

/** The operator overriding a recommendation — a first-class action, not a hidden config edit. */
async function handleSetTemplate(req, res) {
  const { siteUrl, path, templateId } = await body(req);
  const out = dirFor(siteUrl);
  const matches = readJson(join(out, 'template-plan.json'), []);
  const pages = readJson(join(out, 'ir', 'pages.json'), []);
  const row = matches.find((m) => m.path === path);
  const page = pages.find((p) => p.path === path);
  if (!row || !page) return json(res, 404, { error: 'Page not found in the plan.' });

  const mapping = mapToTemplate(page, templateId);
  row.chosen = templateId;
  row.chosenBy = 'human';
  row.leftover = mapping.leftover;
  row.flexible = mapping.flexible.length;
  row.warnings = mapping.warnings;
  writeJson(join(out, 'template-plan.json'), matches);
  json(res, 200, {
    path, templateId,
    leftover: mapping.leftover.length,
    flexible: mapping.flexible.length,
    placed: mapping.placed.length
  });
}

/** Stages 7-9: generate, report, verify. */
async function handleBuild(req, res) {
  const { siteUrl } = await body(req);
  const out = dirFor(siteUrl);
  const plan = readJson(join(out, 'migration.plan.json'));
  const siteIr = readJson(join(out, 'site.ir.json'));
  const pages = readJson(join(out, 'ir', 'pages.json'), []);
  const matches = readJson(join(out, 'template-plan.json'), []);
  if (!plan || !siteIr) return json(res, 400, { error: 'Nothing to build yet.' });

  const s = stream(res);
  try {
    s.send({ type: 'stage', stage: 'generate', label: 'Generating the React site and re-hosting media' });
    const result = await generateSite({
      outDir: join(out, 'site'), siteIr, pages, plan, matches,
      onProgress: (phase, n) => s.send({ type: 'note', text: `re-hosting ${n} media files` })
    });
    writeJson(join(out, 'generate-result.json'), result);
    s.send({ type: 'generated', routes: result.routes.length, media: result.media, config: result.config });

    s.send({ type: 'stage', stage: 'report', label: 'Writing the migration report' });
    await writeReport(out, siteUrl);
    const report = readJson(join(out, '_migration', 'report.json'), { counts: {}, rows: [] });
    s.send({ type: 'report', counts: report.counts, rows: report.rows });

    s.send({ type: 'stage', stage: 'verify', label: 'Checking the export against the acceptance criteria' });
    const verify = verifyBuild({ outDir: out, siteUrl, routes: result.routes });
    writeJson(join(out, '_migration', 'verify.json'), verify);
    s.send({ type: 'verify', verify });

    s.send({ type: 'done', host: hostOf(siteUrl) });
  } catch (err) {
    s.send({ type: 'error', message: String(err?.message ?? err) });
  }
  s.end();
}

async function handleVerify(req, res) {
  const { siteUrl } = await body(req);
  const out = dirFor(siteUrl);
  const gen = readJson(join(out, 'generate-result.json'));
  if (!gen) return json(res, 400, { error: 'Build the site first.' });
  const verify = verifyBuild({ outDir: out, siteUrl, routes: gen.routes });
  writeJson(join(out, '_migration', 'verify.json'), verify);
  json(res, 200, verify);
}

/* ------------------------------------------------------------ static files */

async function serveFile(res, filePath, fallbackIndex = false) {
  try {
    let p = filePath;
    let st = await stat(p).catch(() => null);
    if ((!st || st.isDirectory()) && fallbackIndex) {
      p = join(filePath, 'index.html');
      st = await stat(p).catch(() => null);
    }
    if (!st || !st.isFile()) return false;
    const buf = await readFile(p);
    res.writeHead(200, {
      'content-type': MIME[extname(p).toLowerCase()] ?? 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': 'no-store'
    });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------- main */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = decodeURIComponent(url.pathname);

  try {
    if (req.method === 'POST') {
      if (path === '/api/inspect') return handleInspect(req, res);
      if (path === '/api/scope') return handleScope(req, res);
      if (path === '/api/pages') return handlePages(req, res);
      if (path === '/api/select') return handleSelect(req, res);
      if (path === '/api/migrate') return handleMigrate(req, res);
      if (path === '/api/template') return handleSetTemplate(req, res);
      if (path === '/api/build') return handleBuild(req, res);
      if (path === '/api/verify') return handleVerify(req, res);
    }

    if (path === '/api/zip') return handleZip(req, res, url);
    if (path === '/api/sites') return json(res, 200, await listSites());
    if (path === '/api/reuse') return json(res, 200, reuseMatrix(SITES));
    if (path === '/api/templates') {
      return json(res, 200, TEMPLATES.map((t) => ({
        id: t.id, label: t.label, pageType: t.pageType,
        sections: t.sections.map((s) => ({ archetype: s.archetype, required: s.required })),
        hasFlexibleZone: t.hasFlexibleZone
      })));
    }

    // Preview: serve a migrated site's static export under /preview/<host>/...
    if (path.startsWith('/preview/')) {
      const rest = path.slice('/preview/'.length);
      const slash = rest.indexOf('/');
      const host = slash === -1 ? rest : rest.slice(0, slash);
      const inner = slash === -1 ? '/' : rest.slice(slash);
      const base = join(SITES, host, 'site', 'out');
      // Contain traversal: the resolved path must stay inside the export.
      const target = normalize(join(base, inner));
      if (!target.startsWith(base)) return json(res, 403, { error: 'forbidden' });
      if (await serveFile(res, target, true)) return;
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not built yet — run Build in the studio first.');
    }

    // A static export references its assets from the site root (/media/..., /_next/...),
    // which breaks the moment it is served under /preview/<host>/. Resolve those root
    // requests back to the right export using the Referer of the iframe that asked.
    if (/^\/(media|assets|_next|favicon)/.test(path)) {
      const ref = req.headers.referer ?? '';
      const m = /\/preview\/([^/]+)/.exec(ref);

      const tryHost = async (host) => {
        const base = join(SITES, host, 'site', 'out');
        const target = normalize(join(base, path));
        return target.startsWith(base) && (await serveFile(res, target));
      };

      if (m && (await tryHost(m[1]))) return;

      // A font or image referenced from inside a stylesheet sends the STYLESHEET as its
      // Referer, not the page, so the /preview/<host>/ hint is absent exactly when a
      // fidelity capture needs it most. Asset filenames are content hashes, so scanning
      // the exports for the name is unambiguous — two sites sharing a name share the
      // bytes. This is a preview-server concern only; a deployed site serves from its
      // own root and never hits this path.
      if (existsSync(SITES)) {
        for (const host of await readdir(SITES)) {
          if (m && host === m[1]) continue;
          if (await tryHost(host)) return;
        }
      }
    }

    // Reports written to disk by the report stage.
    if (path.startsWith('/report/')) {
      const [, , host, file = 'report.html'] = path.split('/');
      if (await serveFile(res, join(SITES, host, '_migration', file))) return;
    }

    const staticPath = path === '/' ? '/index.html' : path;
    if (await serveFile(res, join(__dirname, 'public', normalize(staticPath)))) return;

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    // A crash in one handler previously killed the whole studio mid-session. Contain it.
    console.error(`[studio] ${req.method} ${path} failed:`, err?.message ?? err);
    if (!res.headersSent) json(res, 500, { error: String(err?.message ?? err) });
    else res.destroy();
  }
});

// Last line of defence: an async throw outside a handler should log, not exit.
process.on('uncaughtException', (err) => console.error('[studio] uncaught:', err?.message ?? err));
process.on('unhandledRejection', (err) => console.error('[studio] unhandled:', err?.message ?? err));

server.listen(PORT, () => {
  console.log(`\n  Underpin Studio  →  http://localhost:${PORT}\n`);
});
