import { join } from 'node:path';
import { dirFor, readJson, writeJson, fail } from '../../../lib/studio.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Records which pages the operator actually wants. Only these are ever crawled. */
export async function POST(request) {
  const { siteUrl, urls } = await request.json().catch(() => ({}));
  const out = dirFor(siteUrl);
  const plan = readJson(join(out, 'migration.plan.json'));
  if (!plan) return fail('Agree scope first.');
  if (!Array.isArray(urls) || !urls.length) return fail('Select at least one page.');

  const inScope = new Set(plan.inScopeUrls);
  const selected = urls.filter((u) => inScope.has(u));
  plan.selectedUrls = selected;
  plan.pages = { ...plan.pages, selected: selected.length };
  writeJson(join(out, 'migration.plan.json'), plan);

  return Response.json({ selected: selected.length, of: plan.inScopeUrls.length });
}
