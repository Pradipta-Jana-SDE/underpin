import { serveFromExport } from '../../../lib/serve.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Serves a migrated site's static export under /preview/<host>/…
 *
 * Raw bytes, never rendered. The export is itself a Next.js app, and letting this app try to
 * interpret it is the same framework collision the capture layer already guards against —
 * two runtimes fighting over one DOM. Streaming the built files sidesteps it entirely.
 */
export async function GET(request, { params }) {
  const { path = [] } = await params;
  const [host, ...rest] = path;
  if (!host) return new Response('Not found', { status: 404 });

  const res = await serveFromExport(host, rest.join('/') || 'index.html');
  return res ?? new Response(`Nothing built for ${host} yet.`, { status: 404 });
}
