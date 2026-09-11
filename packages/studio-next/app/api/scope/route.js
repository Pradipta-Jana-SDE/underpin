import { join } from 'node:path';
import { optionsFor } from '@underpin/importer/src/scope/options.js';
import { MigrationPlan } from '@underpin/schema';
import { dirFor, readJson, writeJson, fail } from '../../../lib/studio.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const globToRe = (g) =>
  new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');

/** Stage 3: record the operator's decisions as the scope contract every later stage reads. */
export async function POST(request) {
  const { siteUrl, decisions } = await request.json().catch(() => ({}));
  if (!siteUrl) return fail('siteUrl required');

  const out = dirFor(siteUrl);
  const d = readJson(join(out, 'discovery.json'));
  const fp = readJson(join(out, 'fingerprint.json'));
  if (!d || !fp) return fail('Run inspect first.');

  const chosen = [];
  for (const cap of fp.needsDecision) {
    const set = optionsFor(cap);
    if (!set) continue;
    const picked =
      set.options.find((o) => o.value === decisions?.[cap.id]) ??
      set.options.find((o) => o.recommended) ??
      set.options[0];
    chosen.push({
      id: cap.id, label: cap.label, detected: cap.detected ?? {}, evidence: cap.evidence ?? [],
      disposition: picked.value, urlPolicy: picked.urlPolicy ?? {}, redirectTarget: null,
      locales: cap.detected?.locales ?? [], note: picked.label
    });
  }

  const rules = chosen.flatMap((c) =>
    Object.entries(c.urlPolicy ?? {}).map(([glob, policy]) => ({
      re: globToRe(glob), policy, capability: c.id, glob
    }))
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

  return Response.json({ plan: { ...plan, inScopeUrls: [], excludedUrls: excluded.slice(0, 50) } });
}
