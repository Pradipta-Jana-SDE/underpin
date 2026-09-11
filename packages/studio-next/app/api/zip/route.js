import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { zipDirectory } from '../../../lib/zip.js';
import { SITES, fail } from '../../../lib/studio.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 600;

/**
 * The generated project as a downloadable archive.
 *
 * Source only — `node_modules` and `.next` rebuild from package.json and would multiply the
 * download by two orders of magnitude. A fidelity export needs nothing vendored: it depends
 * on next, react and react-dom, so unzip and `npm install` is the whole story.
 */
export async function GET(request) {
  const host = new URL(request.url).searchParams.get('site');
  if (!host) return fail('site required');

  // The host comes off a query string, so it must not be able to address anything but its
  // own directory under sites/.
  if (!/^[a-z0-9.-]+$/i.test(host) || host.includes('..')) return fail('bad site');

  const dir = join(SITES, host, 'site');
  if (!existsSync(dir)) return fail('Nothing generated for that site yet.', 404);

  const { buffer, count } = zipDirectory(dir, { ignore: ['node_modules', '.next'] });

  return new Response(buffer, {
    headers: {
      'content-type': 'application/zip',
      'content-length': String(buffer.length),
      'content-disposition': `attachment; filename="${host}-nextjs.zip"`,
      // Surfaced so the caller can say how big the archive is without unzipping it.
      'x-file-count': String(count)
    }
  });
}
