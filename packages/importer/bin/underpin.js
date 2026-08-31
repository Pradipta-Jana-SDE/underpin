#!/usr/bin/env node
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { discover } from '../src/discover/index.js';
import { fingerprint } from '../src/fingerprint/index.js';
import { negotiateScope } from '../src/scope/index.js';
import { extractSite, extractionStats, stratifiedSample } from '../src/extract/index.js';
import { classifyAll } from '../src/classify/index.js';
import { matchAll } from '../src/match/index.js';
import { generateSite } from '../src/generate/index.js';
import { generateFidelitySite } from '../src/generate/fidelity.js';
import { writeReport } from '../src/report/index.js';
import { writeFidelityReport } from '../src/report/fidelity.js';
import { resolveTargets, describeTargets } from '../src/generate/targets.js';
import { verifyBuild } from '../src/verify/index.js';
import { scorePages } from '../src/verify/score.js';
import { smokeCheck } from '../src/verify/animation.js';
import { reuseMatrix } from '../src/report/reuse.js';
import { createLlm } from '../src/llm/index.js';
import { log, pc } from '../src/util/log.js';

const argv = process.argv.slice(2);
const command = argv[0];
const positional = argv.slice(1).filter((a) => !a.startsWith('-'));
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const num = (n) => Number(opt(n, 0)) || null;

const HELP = `
${pc.bold('underpin')} — template-driven WordPress → React migration

  ${pc.bold('underpin run')} <url>           Everything: scope → extract → plan → build → report
  ${pc.bold('underpin discover')} <url>      Walk the discovery chain and print the evidence
  ${pc.bold('underpin scope')} <url>         Fingerprint capabilities and agree what to migrate
  ${pc.bold('underpin extract')} <url>       Extract content into the normalised IR
  ${pc.bold('underpin plan')} <url>          Classify pages and recommend templates
  ${pc.bold('underpin build')} <url>         Generate the React site
  ${pc.bold('underpin report')} <url>        Write the migration report and preview
  ${pc.bold('underpin verify')} <url>        Check the built export against the acceptance criteria
  ${pc.bold('underpin measure')} <url>       Score the built export against the live original
  ${pc.bold('underpin reuse')}                Which templates absorbed pages from more than one site

Options
  --yes            Take every recommended default; never prompt
  --limit <n>      Sample n pages, stratified across URL shapes
  --media <n>      Cap media/asset downloads
  --mode <m>       fidelity (default) | template
  --componentize   fidelity only: split each page into per-section components
  --score          verify: also measure the served export (needs --base)
  --base <url>     where the built export is served    (default: http://localhost:3000)
  --llm            use a model to name sections (optional; falls back to rules)
  --no-virgin      fidelity only: capture after the scroll pass (the old behaviour).
                   Use if a page's reveal animations leave content invisible.

Modes
  fidelity   Renders each page in a real browser and keeps the DOM, the site's own CSS
             and its animation scripts. Looks identical; nothing is shared between sites.
             Needs Playwright: npx playwright install chromium
  template   Rebuilds each page from a shared React component library. Templates are
             reusable across sites; the result is tidier than the original, not identical.

Pages built are the ones selected in the studio, if a selection exists. Otherwise every
in-scope URL, or a stratified sample of them when --limit is given.
  --out <dir>      Artefact directory            (default: ./sites/<host>)

The pipeline needs no API key. Rules resolve most pages; a model only shrinks the
review queue.
`;

function siteDir(siteUrl) {
  const host = new URL(siteUrl).host.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '-');
  return resolve(opt('out', join(process.cwd(), 'sites', host)));
}

function requireUrl() {
  const raw = positional[0];
  if (!raw) {
    console.error(pc.red('A site URL is required.'));
    console.log(HELP);
    process.exit(1);
  }
  try {
    return new URL(raw.startsWith('http') ? raw : `https://${raw}`).toString();
  } catch {
    console.error(pc.red(`Not a usable URL: ${raw}`));
    process.exit(1);
  }
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2));
};

function need(out, files, siteUrl) {
  for (const f of files) {
    if (!existsSync(join(out, f))) {
      console.error(pc.red(`Missing ${f}.`));
      console.error(`Run ${pc.bold(`underpin run ${siteUrl}`)} to do every stage, or the earlier stage on its own.`);
      process.exit(1);
    }
  }
}

/* ------------------------------------------------------------------ stages */

async function stageDiscover(siteUrl) {
  log.step(1, `Discovering ${pc.bold(siteUrl)}`);
  const d = await discover(siteUrl);
  for (const c of d.chain) {
    if (c.step === 'robots.txt') c.found ? log.ok(`robots.txt · ${c.sitemaps} sitemap directive(s)`) : log.warn('robots.txt absent');
    else if (c.step === 'sitemap') c.urls ? log.ok(`sitemap ${c.url} · ${c.urls} URLs`) : log.dim(`sitemap ${c.url} · none`);
    else if (c.step === 'homepage_link_crawl') log.warn(`no sitemap — fell back to homepage link crawl · ${c.urls} URLs`);
    else if (c.step === 'rest')
      c.reachable
        ? log.ok(`REST API reachable${c.viaRestRoute ? ' (via ?rest_route=)' : ''}`)
        : log.warn('REST API unreachable — extraction renders instead');
  }
  if (d.blockedByRobots) log.dim(`${d.blockedByRobots} URL(s) excluded by robots.txt`);
  log.info(`${pc.bold(String(d.urls.length))} URLs in inventory`);
  return d;
}

async function stageFingerprint(d) {
  log.blank();
  log.step(2, 'Fingerprinting capabilities');
  const fp = await fingerprint(d);
  log.info(`builder: ${pc.bold(fp.builder ?? 'none detected')}`);
  if (!fp.capabilities.length) log.dim('nothing beyond a plain content site');
  for (const c of fp.capabilities) {
    const bar = c.confidence >= 0.4 ? pc.yellow('needs a decision') : pc.dim('below decision bar');
    log.info(`${c.label.padEnd(22)} ${String(c.confidence).padEnd(5)} ${bar}`);
    for (const e of c.evidence) log.dim(`  · ${e}`);
  }
  return fp;
}

async function stageScope(siteUrl, out, auto) {
  const d = await stageDiscover(siteUrl);
  const fp = await stageFingerprint(d);
  log.blank();
  log.step(3, 'Agreeing scope');
  const plan = await negotiateScope({ discovery: d, fingerprint: fp, interactive: !auto, siteUrl });

  mkdirSync(out, { recursive: true });
  writeJson(join(out, 'migration.plan.json'), plan);
  writeJson(join(out, 'discovery.json'), { ...d, urls: d.urls.slice(0, 5000) });
  writeJson(join(out, 'fingerprint.json'), fp);

  log.blank();
  log.info(`${pc.bold(String(plan.pages.inScope))} pages in scope · ${plan.pages.excluded} excluded`);
  for (const [reason, n] of Object.entries(plan.pages.exclusionReasons)) log.dim(`${String(n).padStart(5)}  ${reason}`);
  if (plan.pages.excluded) {
    const policies = [...new Set(plan.excludedUrls.map((e) => e.policy))];
    log.ok(`every excluded URL has a routing policy (${policies.join(', ')}) — no bare 404s`);
  }
  return plan;
}

async function stageExtract(siteUrl, out, limit) {
  need(out, ['migration.plan.json'], siteUrl);
  const plan = readJson(join(out, 'migration.plan.json'));
  const discovery = readJson(join(out, 'discovery.json'));
  const fp = readJson(join(out, 'fingerprint.json'));

  log.blank();
  log.step(4, `Extracting ${limit ? `a ${limit}-page sample of ` : ''}${plan.inScopeUrls.length} in-scope pages`);
  log.dim(`scope: ${plan.capabilities.map((c) => `${c.id}=${c.disposition}`).join(' · ') || 'no capability decisions'}`);

  const t0 = Date.now();
  const { siteIr, pages, failed } = await extractSite({
    origin: new URL(siteUrl).origin,
    plan,
    discovery: { ...discovery, builder: fp.builder },
    limit,
    onProgress: (done, total) => {
      if (done % 5 === 0 || done === total) process.stdout.write(`\r   ${done}/${total} pages…   `);
    }
  });
  process.stdout.write('\r'.padEnd(30) + '\r');

  const stats = extractionStats(pages);
  log.info(`brand   : ${siteIr.brand.colors.primary ?? '(none)'} · ${siteIr.brand.fonts.heading ?? '?'} / ${siteIr.brand.fonts.body ?? '?'} ${pc.dim(`(${siteIr.brand.sources.colors})`)}`);
  log.info(`nav     : ${siteIr.nav.primary.length} items · locations: ${siteIr.locations.length} · logo: ${siteIr.brand.logo.default ? 'found' : pc.yellow('missing')}`);
  log.info(`shell   : ${siteIr.shell.headerSelector ?? 'undetected'} / ${siteIr.shell.footerSelector ?? 'undetected'} ${pc.dim(`conf ${siteIr.shell.confidence}`)}`);
  log.info(`${pc.bold(String(stats.pages))} pages · ${stats.sections} sections · ${stats.media} media ${pc.dim(`(${((Date.now() - t0) / 1000).toFixed(1)}s)`)}`);
  log.info(`decided : ${Object.entries(stats.byDecidedBy).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  log.info(`shapes  : ${Object.entries(stats.byArchetype).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  if (stats.lowConfidence) log.warn(`${stats.lowConfidence} section(s) below 0.6 confidence → review queue`);
  if (stats.incompleteCapture) log.warn(`${stats.incompleteCapture} carousel section(s) may be missing slides`);
  if (failed.length) log.fail(`${failed.length} page(s) failed to fetch`);

  writeJson(join(out, 'site.ir.json'), siteIr);
  writeJson(join(out, 'ir', 'pages.json'), pages);
  writeJson(join(out, 'extraction-stats.json'), { ...stats, failed });
  return { siteIr, pages };
}

async function stagePlan(siteUrl, out) {
  need(out, ['ir/pages.json', 'site.ir.json'], siteUrl);
  const pages = readJson(join(out, 'ir', 'pages.json'));
  const siteIr = readJson(join(out, 'site.ir.json'));

  log.blank();
  log.step(5, `Classifying ${pages.length} pages`);
  const classifications = await classifyAll(pages, { nav: siteIr.nav.primary }, null);
  const byType = {};
  for (const c of classifications) byType[c.type] = (byType[c.type] ?? 0) + 1;
  log.info(Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' · '));
  const byStage = {};
  for (const c of classifications) byStage[`stage${c.stage}`] = (byStage[`stage${c.stage}`] ?? 0) + 1;
  log.dim(`resolved at: ${Object.entries(byStage).sort().map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  const review = classifications.filter((c) => c.needsReview);
  if (review.length) log.warn(`${review.length} page(s) below the confidence bar → human review`);

  log.blank();
  log.step(6, 'Recommending templates');
  const matches = matchAll(pages, classifications);
  const avg = Math.round(matches.reduce((a, m) => a + m.matchConfidence, 0) / (matches.length || 1));
  const byTemplate = {};
  for (const m of matches) byTemplate[m.chosen] = (byTemplate[m.chosen] ?? 0) + 1;
  for (const [t, n] of Object.entries(byTemplate).sort((a, b) => b[1] - a[1])) log.info(`${String(n).padStart(3)} × ${t}`);
  log.dim(`average match confidence ${avg}% · ${matches.filter((m) => m.matchConfidence >= 70).length}/${matches.length} at or above 70%`);

  writeJson(join(out, 'classifications.json'), classifications);
  writeJson(join(out, 'template-plan.json'), matches);
  return { classifications, matches };
}

async function stageBuildFidelity(siteUrl, out, mediaLimit, limit) {
  need(out, ['migration.plan.json'], siteUrl);
  const plan = readJson(join(out, 'migration.plan.json'));
  const appDir = join(out, 'site');
  const targets = resolveTargets(plan, { limit });

  log.blank();
  log.step(7, `Generating an exact-fidelity React site`);
  log.dim('Renders each page in a real browser, keeps its CSS and animation scripts.');

  // Off unless asked for, even when a key is present: a demo has to be reproducible, and
  // the rules already name every section.
  const llm = createLlm({ enabled: flag('llm') });
  if (flag('llm')) {
    (llm.available ? log.info : log.warn)(
      llm.available ? `naming sections with ${llm.model}` : `model layer unavailable (${llm.reason}) — using rules`
    );
  }
  if (targets.source === 'selected') log.info(`building the ${targets.urls.length} pages selected in the studio`);

  const result = await generateFidelitySite({
    outDir: appDir, siteUrl, plan, urls: targets.urls, mediaLimit,
    componentize: flag('componentize'),
    virgin: !flag('no-virgin'),
    llm,
    onProgress: (ev) => {
      if (ev.type === 'stage') { process.stdout.write('\r'.padEnd(60) + '\r'); log.info(ev.label); }
      else if (ev.type === 'progress') process.stdout.write(`\r   rendered ${ev.done}/${ev.total}   `);
      else if (ev.type === 'assets') process.stdout.write(`\r   mirrored ${ev.done}/${ev.total} assets   `);
    }
  });
  process.stdout.write('\r'.padEnd(60) + '\r');

  log.info(`${result.routes.length} pages captured${flag('componentize') ? ' · split into section components' : ''}`);
  log.info(`assets: ${result.media.downloaded} mirrored · ${result.media.failed.length} failed`);
  if (result.captureFailures.length) log.warn(`${result.captureFailures.length} page(s) failed to render`);
  writeJson(join(out, 'generate-result.json'), result);
  log.ok(`site → ${pc.bold(appDir.replace(process.cwd() + '/', ''))}`);
  return result;
}

async function stageBuild(siteUrl, out, mediaLimit) {
  need(out, ['migration.plan.json', 'site.ir.json', 'ir/pages.json', 'template-plan.json'], siteUrl);
  const plan = readJson(join(out, 'migration.plan.json'));
  const siteIr = readJson(join(out, 'site.ir.json'));
  const pages = readJson(join(out, 'ir', 'pages.json'));
  const matches = readJson(join(out, 'template-plan.json'));
  const appDir = join(out, 'site');

  log.blank();
  log.step(7, `Generating React site`);
  const result = await generateSite({
    outDir: appDir, siteIr, pages, plan, matches, mediaLimit,
    onProgress: (phase, n) => { if (phase === 'media') log.dim(`re-hosting ${n} media file(s)…`); }
  });

  log.info(`${result.routes.length} routes · one JSON record per page`);
  log.info(`media: ${result.media.downloaded} downloaded · ${result.media.skipped} cached · ${result.media.failed.length} failed`);
  if (result.warnings.length) log.warn(`${result.warnings.length} page(s) carry leftover content — blocks a production build until reviewed`);
  else log.ok('no leftover content — every extracted section renders somewhere');
  log.ok(`site → ${pc.bold(appDir.replace(process.cwd() + '/', ''))}`);
  writeJson(join(out, 'generate-result.json'), result);

  // The report describes this build, so it is regenerated with it. Leaving a stale
  // report on disk next to a fresh export is worse than having none — it reads as
  // current and quietly reports the previous run's numbers.
  await writeReport(out, siteUrl);
  return result;
}

async function stageVerify(siteUrl, out) {
  need(out, ['generate-result.json'], siteUrl);
  const generated = readJson(join(out, 'generate-result.json'));
  const { routes } = generated;
  log.blank();
  log.step(9, 'Verifying the export');
  const result = verifyBuild({ outDir: out, siteUrl, routes, generated });
  if (!result.built) {
    log.warn('no export yet — build the site first, then re-run verify');
    log.dim(`cd "${join(out, 'site').replace(process.cwd() + '/', '')}" && npm install && npm run build`);
    return result;
  }
  for (const c of result.checks) {
    (c.pass ? log.ok : log.fail)(`${c.label.padEnd(46)} ${pc.dim(c.detail)}`);
  }
  writeJson(join(out, '_migration', 'verify.json'), result);
  log.blank();
  (result.passed ? log.ok : log.fail)(
    result.passed ? pc.bold('All acceptance checks passed.') : pc.bold('Some acceptance checks failed — see above.')
  );
  return result;
}

async function stageReport(siteUrl, out) {
  // Dispatch on what the build actually produced rather than on the flags of this
  // invocation, so `underpin report <url>` describes the export that is on disk.
  need(out, ['generate-result.json'], siteUrl);
  const mode = readJson(join(out, 'generate-result.json'))?.mode ?? 'template';
  if (mode === 'template') need(out, ['template-plan.json'], siteUrl);

  log.blank();
  log.step(8, 'Writing migration report');
  const paths = mode === 'fidelity' ? await writeFidelityReport(out, siteUrl) : await writeReport(out, siteUrl);
  log.ok(`report  → ${pc.bold(paths.report.replace(process.cwd() + '/', ''))}`);
  log.ok(`preview → ${pc.bold(paths.preview.replace(process.cwd() + '/', ''))}`);
  return paths;
}

/**
 * Stage 10: the checks that need the site running.
 *
 * Everything in `verify` reads files. These two load the built pages in a browser — one
 * compares them pixel by pixel against the live original, the other asks whether the
 * site's own scripts actually booted. Separate stage because it needs the export served
 * somewhere, which is a thing the operator does, not something this tool should assume.
 */
async function stageMeasure(siteUrl, out, base) {
  need(out, ['generate-result.json'], siteUrl);
  const generated = readJson(join(out, 'generate-result.json'));
  const paths = generated.routes.map((r) => r.path);

  log.blank();
  log.step(10, 'Measuring the built export against the original');
  log.dim(`serving from ${base} — start it with: cd "${join(out, 'site').replace(process.cwd() + '/', '')}" && npx serve out -l 3000`);

  const score = await scorePages({
    origin: new URL(siteUrl).origin,
    migratedBase: base,
    paths,
    outDir: out,
    onProgress: ({ done, total, path, width }) =>
      process.stdout.write(`\r   scoring ${done}/${total}  ${path} @ ${width}px      `)
  });
  process.stdout.write('\r'.padEnd(60) + '\r');

  if (score.skipped) {
    log.warn(`visual score skipped — ${score.reason}`);
  } else {
    // Two numbers, side by side, never averaged: they answer different questions and a
    // blend hides the one a reviewer needs to see.
    const o = score.overall;
    const pct = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
    log.info(`design fidelity  ${pct(o.visual)}`);
    log.info(`content fidelity ${pct(o.text)}`);
    log.info(`node coverage    ${pct(o.nodes)}`);
    // Never let a mean over the pages that loaded pass for a score of the migration.
    if (o.measured < o.total) {
      log.warn(`measured ${o.measured}/${o.total} page-widths — the rest did not render:`);
      for (const f of o.failed.slice(0, 4)) log.dim(`     ${f.path} @ ${f.width}px — ${f.error}`);
    } else {
      log.dim(`measured all ${o.total} page-widths`);
    }
  }

  const smoke = await smokeCheck({ migratedBase: base, paths });
  writeJson(join(out, '_migration', 'smoke.json'), smoke);
  if (smoke.skipped) {
    log.warn(`animation smoke check skipped — ${smoke.reason}`);
  } else {
    for (const pg of smoke.pages) {
      const s = pg.scripts;
      const detail = s ? `${s.ran}/${s.total} scripts ran` : 'no replay counter';
      (pg.pass ? log.ok : log.fail)(`${pg.path.padEnd(30)} ${pc.dim(detail)}`);
      for (const r of pg.reasons ?? []) log.dim(`     ${r}`);
    }
  }

  await stageReport(siteUrl, out);
  return { score, smoke };
}

/* -------------------------------------------------------------------- main */

async function main() {
  if (!command || flag('help') || command === 'help') return console.log(HELP);

  if (command === 'reuse') {
    const dir = resolve(opt('out', join(process.cwd(), 'sites')));
    const m = reuseMatrix(dir);
    if (!m.sites.length) {
      console.error(pc.red(`No migrated sites found under ${dir}.`));
      process.exit(1);
    }
    log.step(0, 'Template reuse across migrated sites');
    log.dim('A template that only ever fits the site it was written for is not reusable.');
    log.blank();
    const w = Math.max(...m.templates.map((t) => t.id.length), 8) + 2;
    console.log('   ' + 'template'.padEnd(w) + m.sites.map((s) => s.slice(0, 16).padEnd(18)).join('') + 'verdict');
    for (const t of m.templates) {
      console.log(
        '   ' + t.id.padEnd(w) +
        m.sites.map((s) => String(t.bySite[s] ?? 0).padEnd(18)).join('') +
        (t.reused ? pc.green('reused') : pc.yellow('one site only'))
      );
    }
    log.blank();
    log.info(`${pc.bold(`${m.reused}/${m.total}`)} templates absorbed pages from more than one site`);
    if (m.reused < m.total) {
      log.dim('Templates matching a single site are not yet evidence of reuse — migrate a site');
      log.dim('with those page types, or fold the template into a more general one.');
    }
    return;
  }

  const siteUrl = requireUrl();
  const out = siteDir(siteUrl);

  switch (command) {
    case 'discover': await stageDiscover(siteUrl); break;
    case 'scope':    await stageScope(siteUrl, out, flag('yes')); break;
    case 'extract':  await stageExtract(siteUrl, out, num('limit')); break;
    case 'plan':     await stagePlan(siteUrl, out); break;
    case 'build':
      opt('mode', 'fidelity') !== 'template'
        ? await stageBuildFidelity(siteUrl, out, num('media'), num('limit'))
        : await stageBuild(siteUrl, out, num('media'));
      break;
    case 'report':   await stageReport(siteUrl, out); break;
    case 'verify':
      await stageVerify(siteUrl, out);
      if (flag('score')) await stageMeasure(siteUrl, out, opt('base', 'http://localhost:3000'));
      break;
    case 'measure':  await stageMeasure(siteUrl, out, opt('base', 'http://localhost:3000')); break;
    case 'run': {
      const fidelity = opt('mode', 'fidelity') !== 'template';
      await stageScope(siteUrl, out, flag('yes'));
      if (fidelity) {
        // Fidelity mode needs no IR: it keeps each page as rendered rather than reading
        // it for meaning, so extraction, classification and matching are all skipped.
        // The report is not skipped — a build with no artefact beside it is a site
        // ripper rather than an engineering deliverable.
        await stageBuildFidelity(siteUrl, out, num('media'), num('limit'));
        await stageReport(siteUrl, out);
      } else {
        await stageExtract(siteUrl, out, num('limit'));
        await stagePlan(siteUrl, out);
        await stageBuild(siteUrl, out, num('media'));
        await stageReport(siteUrl, out);
      }
      await stageVerify(siteUrl, out);
      log.blank();
      log.ok(pc.bold('Migration complete.'));
      log.dim(`build the site:  cd "${join(out, 'site').replace(process.cwd() + '/', '')}" && npm install && npm run build`);
      break;
    }
    default:
      console.error(pc.red(`Unknown command: ${command}`));
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(pc.red('\nFailed: ') + (err?.stack ?? err));
  process.exit(1);
});
