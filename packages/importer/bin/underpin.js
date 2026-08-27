#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { discover } from '../src/discover/index.js';
import { fingerprint } from '../src/fingerprint/index.js';
import { negotiateScope } from '../src/scope/index.js';
import { extractSite, extractionStats } from '../src/extract/index.js';
import { readFileSync, existsSync } from 'node:fs';
import { log, pc } from '../src/util/log.js';

const argv = process.argv.slice(2);
const command = argv[0];
const positional = argv.slice(1).filter((a) => !a.startsWith('-'));
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const HELP = `
${pc.bold('underpin')} — template-driven WordPress → React migration

  ${pc.bold('underpin discover')} <url>      Walk the discovery chain and print the evidence
  ${pc.bold('underpin scope')} <url>         Discover, fingerprint capabilities, agree scope
  ${pc.bold('underpin extract')} <url>       Extract content into the normalised IR (needs a scope contract)

Options
  --yes            Take every recommended default; never prompt
  --limit <n>      Extract only the first n pages (use while iterating)
  --out <dir>      Where to write artefacts        (default: ./sites/<host>)
  --help

The pipeline runs with no API key. Rules resolve most pages; a model only shrinks
the review queue. See docs/model-layer.md.
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

async function runDiscover(siteUrl) {
  log.step(1, `Discovering ${pc.bold(siteUrl)}`);
  const d = await discover(siteUrl);
  for (const c of d.chain) {
    if (c.step === 'robots.txt') {
      c.found ? log.ok(`robots.txt · ${c.sitemaps} sitemap directive(s)`) : log.warn('robots.txt absent');
    } else if (c.step === 'sitemap') {
      c.urls ? log.ok(`sitemap ${c.url} · ${c.urls} URLs`) : log.dim(`sitemap ${c.url} · none`);
    } else if (c.step === 'homepage_link_crawl') {
      log.warn(`no sitemap found — fell back to homepage link crawl · ${c.urls} URLs`);
    } else if (c.step === 'rest') {
      c.reachable
        ? log.ok(`REST API reachable${c.viaRestRoute ? ' (via ?rest_route=)' : ''}`)
        : log.warn('REST API unreachable — extraction will render instead');
    }
  }
  if (d.blockedByRobots) log.dim(`${d.blockedByRobots} URL(s) excluded by robots.txt`);
  log.info(`${pc.bold(String(d.urls.length))} URLs in inventory`);
  return d;
}

async function runFingerprint(d) {
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

async function main() {
  if (!command || flag('help') || command === 'help') return console.log(HELP);

  if (command === 'discover') {
    const siteUrl = requireUrl();
    await runDiscover(siteUrl);
    return;
  }

  if (command === 'scope') {
    const siteUrl = requireUrl();
    const out = siteDir(siteUrl);
    const d = await runDiscover(siteUrl);
    const fp = await runFingerprint(d);

    log.blank();
    log.step(3, 'Agreeing scope');
    const plan = await negotiateScope({
      discovery: d,
      fingerprint: fp,
      interactive: !flag('yes'),
      siteUrl
    });

    mkdirSync(out, { recursive: true });
    const planPath = join(out, 'migration.plan.json');
    writeFileSync(planPath, JSON.stringify(plan, null, 2));
    writeFileSync(
      join(out, 'discovery.json'),
      JSON.stringify({ ...d, urls: d.urls.slice(0, 5000) }, null, 2)
    );
    writeFileSync(join(out, 'fingerprint.json'), JSON.stringify(fp, null, 2));

    log.blank();
    log.info(`${pc.bold(String(plan.pages.inScope))} pages in scope · ${plan.pages.excluded} excluded`);
    for (const [reason, n] of Object.entries(plan.pages.exclusionReasons)) log.dim(`${String(n).padStart(5)}  ${reason}`);
    if (plan.pages.excluded) {
      const policies = [...new Set(plan.excludedUrls.map((e) => e.policy))];
      log.ok(`every excluded URL has a routing policy (${policies.join(', ')}) — no bare 404s`);
    }
    log.blank();
    log.ok(`scope contract → ${pc.bold(planPath.replace(process.cwd() + '/', ''))}`);
    return;
  }

  if (command === 'extract') {
    const siteUrl = requireUrl();
    const out = siteDir(siteUrl);
    const planPath = join(out, 'migration.plan.json');
    if (!existsSync(planPath)) {
      console.error(pc.red(`No scope contract at ${planPath}`));
      console.error(`Run ${pc.bold(`underpin scope ${siteUrl}`)} first — scope is agreed before extraction,`);
      console.error('so we never spend the expensive crawl on pages nobody wanted.');
      process.exit(1);
    }
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const discovery = JSON.parse(readFileSync(join(out, 'discovery.json'), 'utf8'));
    const fp = JSON.parse(readFileSync(join(out, 'fingerprint.json'), 'utf8'));
    const limit = Number(opt('limit', 0)) || null;

    log.step(4, `Extracting ${limit ? `${limit} of ` : ''}${plan.inScopeUrls.length} in-scope pages`);
    log.dim(`scope agreed ${plan.decidedAt} · ${plan.capabilities.map((c) => `${c.id}=${c.disposition}`).join(' · ') || 'no capability decisions'}`);

    const t0 = Date.now();
    const { siteIr, pages, failed } = await extractSite({
      origin: new URL(siteUrl).origin,
      plan,
      discovery: { ...discovery, builder: fp.builder },
      limit,
      onProgress: (done, total, url, r) => {
        if (done % 5 === 0 || done === total) {
          process.stdout.write(`\r   ${done}/${total} pages…`);
        }
        if (!r.ok) log.warn(`\n   ${url} → ${r.error}`);
      }
    });
    process.stdout.write('\r');

    const stats = extractionStats(pages);
    log.blank();
    log.step(5, 'Site-level extraction');
    log.info(`brand colours : ${siteIr.brand.colors.primary ?? '(none found)'} · ${siteIr.brand.colors.palette.length} in palette ${pc.dim(`(${siteIr.brand.sources.colors})`)}`);
    log.info(`fonts         : ${siteIr.brand.fonts.heading ?? '?'} / ${siteIr.brand.fonts.body ?? '?'} ${pc.dim(`(${siteIr.brand.sources.fonts})`)}`);
    log.info(`logo          : ${siteIr.brand.logo.default ? 'found' : pc.yellow('not found')}`);
    log.info(`navigation    : ${siteIr.nav.primary.length} top-level items`);
    log.info(`locations     : ${siteIr.locations.length} ${pc.dim(`(${siteIr.brand.sources.contact})`)}`);
    log.info(`shell         : header=${siteIr.shell.headerSelector ?? 'undetected'} footer=${siteIr.shell.footerSelector ?? 'undetected'} ${pc.dim(`conf ${siteIr.shell.confidence}`)}`);

    log.blank();
    log.step(6, 'Page extraction');
    log.info(`${pc.bold(String(stats.pages))} pages · ${stats.sections} sections · ${stats.media} media`);
    log.info(`boundaries    : ${Object.entries(stats.byDecidedBy).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
    log.info(`archetypes    : ${Object.entries(stats.byArchetype).sort((a,b)=>b[1]-a[1]).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
    if (stats.lowConfidence) log.warn(`${stats.lowConfidence} section(s) below 0.6 confidence → human review queue`);
    if (stats.incompleteCapture) log.warn(`${stats.incompleteCapture} carousel section(s) may be missing slides — needs a render pass`);
    if (failed.length) log.fail(`${failed.length} page(s) failed to fetch`);

    mkdirSync(join(out, 'ir'), { recursive: true });
    writeFileSync(join(out, 'site.ir.json'), JSON.stringify(siteIr, null, 2));
    writeFileSync(join(out, 'ir', 'pages.json'), JSON.stringify(pages, null, 2));
    writeFileSync(join(out, 'extraction-stats.json'), JSON.stringify({ ...stats, failed }, null, 2));
    log.blank();
    log.ok(`IR written → ${pc.bold(join(out, 'ir', 'pages.json').replace(process.cwd() + '/', ''))} ${pc.dim(`(${((Date.now()-t0)/1000).toFixed(1)}s)`)}`);
    return;
  }

  console.error(pc.red(`Unknown command: ${command}`));
  console.log(HELP);
  process.exit(1);
}

main().catch((err) => {
  console.error(pc.red('\nFailed: ') + (err?.stack ?? err));
  process.exit(1);
});
