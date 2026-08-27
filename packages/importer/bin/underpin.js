#!/usr/bin/env node
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { discover } from '../src/discover/index.js';
import { fingerprint } from '../src/fingerprint/index.js';
import { negotiateScope } from '../src/scope/index.js';
import { extractSite, extractionStats } from '../src/extract/index.js';
import { classifyAll } from '../src/classify/index.js';
import { matchAll } from '../src/match/index.js';
import { generateSite } from '../src/generate/index.js';
import { writeReport } from '../src/report/index.js';
import { verifyBuild } from '../src/verify/index.js';
import { reuseMatrix } from '../src/report/reuse.js';
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
  ${pc.bold('underpin reuse')}                Which templates absorbed pages from more than one site

Options
  --yes            Take every recommended default; never prompt
  --limit <n>      Sample n pages, stratified across URL shapes
  --media <n>      Cap media downloads
  --out <dir>      Artefact directory            (default: ./sites/<host>)

The pipeline needs no API key. Rules resolve most pages; a model only shrinks the
review queue. See docs/model-layer.md.
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
  const { routes } = readJson(join(out, 'generate-result.json'));
  log.blank();
  log.step(9, 'Verifying the export');
  const result = verifyBuild({ outDir: out, siteUrl, routes });
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
  need(out, ['template-plan.json', 'generate-result.json'], siteUrl);
  log.blank();
  log.step(8, 'Writing migration report');
  const paths = await writeReport(out, siteUrl);
  log.ok(`report  → ${pc.bold(paths.report.replace(process.cwd() + '/', ''))}`);
  log.ok(`preview → ${pc.bold(paths.preview.replace(process.cwd() + '/', ''))}`);
  return paths;
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
    case 'build':    await stageBuild(siteUrl, out, num('media')); break;
    case 'report':   await stageReport(siteUrl, out); break;
    case 'verify':   await stageVerify(siteUrl, out); break;
    case 'run':
      await stageScope(siteUrl, out, flag('yes'));
      await stageExtract(siteUrl, out, num('limit'));
      await stagePlan(siteUrl, out);
      await stageBuild(siteUrl, out, num('media'));
      await stageReport(siteUrl, out);
      await stageVerify(siteUrl, out);
      log.blank();
      log.ok(pc.bold('Migration complete.'));
      log.dim(`build the site:  cd "${join(out, 'site').replace(process.cwd() + '/', '')}" && npm install && npm run build`);
      break;
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
