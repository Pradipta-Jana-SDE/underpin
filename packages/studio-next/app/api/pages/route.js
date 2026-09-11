import { join } from 'node:path';
import { groupUrlsByType } from '@underpin/importer/src/classify/index.js';
import { dirFor, readJson, fail } from '../../../lib/studio.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The page inventory, grouped by type.
 *
 * Classified from URL shape alone. The whole point of choosing pages is to avoid crawling
 * the ones nobody wants, so nothing is fetched to build this list.
 */
export async function POST(request) {
  const { siteUrl } = await request.json().catch(() => ({}));
  const plan = readJson(join(dirFor(siteUrl), 'migration.plan.json'));
  if (!plan) return fail('Agree scope first.');

  return Response.json({
    total: plan.inScopeUrls.length,
    excluded: plan.pages?.excluded ?? 0,
    groups: groupUrlsByType(plan.inScopeUrls),
    // Everything is selected unless the operator says otherwise; a picker that starts empty
    // makes the common case — migrate the whole site — the most work.
    selected: plan.selectedUrls ?? null
  });
}
