import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

/**
 * Shared helpers for the studio's route handlers.
 *
 * The pipeline itself is imported as a library and is unchanged by the move to Next — these
 * are only the four things every handler needs: where a site's artefacts live, JSON on and
 * off disk, and the NDJSON stream the wizard reads progress from.
 */

// Route handlers run from the package root, so the workspace root is two levels up.
export const ROOT = resolve(process.cwd(), '..', '..');
export const SITES = join(ROOT, 'sites');

export const hostOf = (url) => new URL(url).host.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '-');
export const dirFor = (url) => join(SITES, hostOf(url));

export const readJson = (p, fb = null) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fb);
export const writeJson = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2));
};

/** A JSON error response, for the cases a handler refuses before doing any work. */
export const fail = (message, code = 400) => Response.json({ error: message }, { status: code });

/**
 * Runs `work` and streams whatever it sends as newline-delimited JSON.
 *
 * The wizard reads these events as they arrive, which is what makes a four-minute build
 * show real progress rather than a spinner. `work` receives a `send` function; throwing
 * inside it becomes a final `error` event rather than a dead connection, because a stream
 * that just stops leaves the UI waiting forever.
 */
export function ndjson(work) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      const send = (event) => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      try {
        await work(send);
      } catch (err) {
        send({ type: 'error', message: String(err?.message ?? err) });
      }
      controller.close();
    }
  });

  return new Response(body, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      // Next buffers by default behind some proxies; this is the same header the old
      // node:http server sent for the same reason.
      'x-accel-buffering': 'no'
    }
  });
}
