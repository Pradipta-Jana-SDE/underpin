import { serveFromExport } from '../../lib/serve.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Root-absolute asset requests coming out of a preview.
 *
 * A static export references its assets from the site root (`/assets/…`), which breaks the
 * moment it is served under `/preview/<host>/`. Rather than rewrite those paths — which
 * duplicates React's hoisted stylesheets and reorders the cascade — the request is resolved
 * back to the project it came from: the Referer first, then the cookie the preview set, since
 * an asset a stylesheet requests carries the stylesheet as its Referer rather than the page.
 */
export async function GET(request, { params }) {
  const { path = [] } = await params;
  const rel = path.join('/');

  const referer = request.headers.get('referer') ?? '';
  const fromRef = /\/preview\/([^/]+)/.exec(referer)?.[1];
  const fromCookie = request.cookies?.get?.('underpin_preview')?.value;
  const host = fromRef ?? (fromCookie ? decodeURIComponent(fromCookie) : null);
  if (!host) return new Response('Not found', { status: 404 });

  const res = await serveFromExport(host, rel, { rewriteHtml: false });
  return res ?? new Response('Not found', { status: 404 });
}
