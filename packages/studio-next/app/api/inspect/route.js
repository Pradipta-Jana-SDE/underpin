import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { discover } from '@underpin/importer/src/discover/index.js';
import { fingerprint } from '@underpin/importer/src/fingerprint/index.js';
import { optionsFor } from '@underpin/importer/src/scope/options.js';
import { dirFor, hostOf, writeJson, ndjson, fail } from '../../../lib/studio.js';

// Playwright, the filesystem and a long-lived stream: all Node, none of it static.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Stages 1 and 2: discover and fingerprint, returning the questions a human must answer. */
export async function POST(request) {
  const { url } = await request.json().catch(() => ({}));
  if (!url) return fail('A site URL is required.');

  let siteUrl;
  try {
    siteUrl = new URL(url.startsWith('http') ? url : `https://${url}`).toString();
  } catch {
    return fail(`Not a usable URL: ${url}`);
  }

  return ndjson(async (send) => {
    send({ type: 'stage', stage: 'discover', label: 'Walking the discovery chain' });
    const d = await discover(siteUrl);
    for (const c of d.chain) send({ type: 'chain', ...c });
    send({
      type: 'discovered',
      urls: d.urls.length,
      blockedByRobots: d.blockedByRobots,
      rest: d.rest,
      viaLinkCrawl: d.viaLinkCrawl
    });

    send({ type: 'stage', stage: 'fingerprint', label: 'Fingerprinting what the site actually runs' });
    const fp = await fingerprint(d);

    const questions = fp.needsDecision
      .map((cap) => {
        const set = optionsFor(cap);
        if (!set) return null;
        return {
          id: cap.id,
          label: cap.label,
          confidence: cap.confidence,
          signalClasses: cap.signalClasses ?? [],
          evidence: cap.evidence ?? [],
          detected: cap.detected ?? {},
          question: set.question,
          options: set.options.map((o) => ({
            value: o.value, label: o.label, detail: o.detail, recommended: Boolean(o.recommended)
          })),
          unavailable: set.unavailable ?? []
        };
      })
      .filter(Boolean);

    const out = dirFor(siteUrl);
    mkdirSync(out, { recursive: true });
    writeJson(join(out, 'discovery.json'), { ...d, urls: d.urls.slice(0, 5000) });
    writeJson(join(out, 'fingerprint.json'), fp);

    send({
      type: 'done',
      siteUrl,
      host: hostOf(siteUrl),
      builder: fp.builder,
      capabilities: fp.capabilities,
      questions,
      urls: d.urls.length
    });
  });
}
