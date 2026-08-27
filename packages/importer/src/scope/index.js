import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { MigrationPlan } from '@underpin/schema';
import { optionsFor, recommendedFor } from './options.js';
import { pc } from '../util/log.js';

const globToRe = (glob) =>
  new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');

/** Applies a decision's URL policy to the inventory. Every excluded URL gets a policy. */
function applyPolicies(urls, decisions) {
  const rules = [];
  for (const d of decisions) {
    for (const [glob, policy] of Object.entries(d.urlPolicy ?? {})) {
      rules.push({ re: globToRe(glob), policy, capability: d.id, glob });
    }
  }
  const inScope = [];
  const excluded = [];
  for (const u of urls) {
    let path;
    try {
      path = new URL(u.loc).pathname;
    } catch {
      continue;
    }
    const hit = rules.find((r) => r.re.test(path));
    if (!hit || hit.policy === 'migrate') inScope.push(u.loc);
    else excluded.push({ url: u.loc, reason: `${hit.capability}: ${hit.glob}`, policy: hit.policy });
  }
  return { inScope, excluded };
}

function renderCapability(cap, set) {
  const lines = [];
  lines.push('');
  lines.push(`  ${pc.bold(set.question)}`);
  lines.push(`  ${pc.dim(`confidence ${cap.confidence} · ${cap.signalClasses.join(' + ')}`)}`);
  for (const e of cap.evidence) lines.push(`  ${pc.dim('· ' + e)}`);
  lines.push('');
  set.options.forEach((o, i) => {
    const tag = o.recommended ? pc.green(' (recommended)') : '';
    lines.push(`    ${pc.bold(String(i + 1))}  ${o.label}${tag}`);
    lines.push(`       ${pc.dim(o.detail)}`);
  });
  for (const u of set.unavailable ?? []) {
    lines.push(`    ${pc.dim('—  ' + u.label + '  [unavailable]')}`);
    lines.push(`       ${pc.dim(u.why)}`);
  }
  return lines.join('\n');
}

/**
 * Negotiates scope with the operator and writes the contract.
 *
 * Runs BEFORE extraction: crawling 142 product pages and then finding out nobody
 * wanted them wastes the most expensive stage of the pipeline.
 */
export async function negotiateScope({ discovery, fingerprint: fp, interactive = true, siteUrl }) {
  const decisions = [];
  const toDecide = fp.needsDecision.filter((c) => optionsFor(c));

  if (!toDecide.length) {
    console.log(pc.dim('\n  No capability needs a decision — everything detected is safe to migrate as-is.\n'));
  }

  const rl = interactive && stdin.isTTY ? readline.createInterface({ input: stdin, output: stdout }) : null;

  for (const cap of toDecide) {
    const set = optionsFor(cap);
    const rec = recommendedFor(cap);
    console.log(renderCapability(cap, set));

    let chosen = rec;
    if (rl) {
      const answer = (await rl.question(`    choose [1-${set.options.length}] (enter = recommended): `)).trim();
      if (answer) {
        const idx = Number(answer) - 1;
        if (Number.isInteger(idx) && set.options[idx]) chosen = set.options[idx];
        else console.log(pc.yellow(`    not a valid choice — using "${rec.label}"`));
      }
    } else {
      console.log(pc.dim(`    non-interactive → "${chosen.label}"`));
    }

    decisions.push({
      id: cap.id,
      label: cap.label,
      detected: cap.detected ?? {},
      evidence: cap.evidence ?? [],
      disposition: chosen.value,
      urlPolicy: chosen.urlPolicy ?? {},
      redirectTarget: null,
      locales: cap.detected?.locales ?? [],
      note: chosen.label
    });
  }
  rl?.close();

  const { inScope, excluded } = applyPolicies(discovery.urls, decisions);
  const exclusionReasons = {};
  for (const e of excluded) exclusionReasons[e.reason] = (exclusionReasons[e.reason] ?? 0) + 1;

  return MigrationPlan.parse({
    site: siteUrl,
    planVersion: 1,
    decidedAt: new Date().toISOString(),
    decidedBy: rl ? 'cli-interactive' : 'cli-defaults',
    capabilities: decisions,
    pages: {
      total: discovery.urls.length,
      inScope: inScope.length,
      excluded: excluded.length,
      exclusionReasons
    },
    inScopeUrls: inScope,
    excludedUrls: excluded
  });
}
