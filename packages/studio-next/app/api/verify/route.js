import { join } from 'node:path';
import { verifyBuild } from '@underpin/importer/src/verify/index.js';
import { dirFor, readJson, writeJson, fail } from '../../../lib/studio.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Stage 9: the acceptance checks, re-run on demand against what is on disk. */
export async function POST(request) {
  const { siteUrl } = await request.json().catch(() => ({}));
  const out = dirFor(siteUrl);
  const gen = readJson(join(out, 'generate-result.json'));
  if (!gen) return fail('Build the site first.');

  const verify = verifyBuild({ outDir: out, siteUrl, routes: gen.routes, generated: gen });
  writeJson(join(out, '_migration', 'verify.json'), verify);
  return Response.json(verify);
}
