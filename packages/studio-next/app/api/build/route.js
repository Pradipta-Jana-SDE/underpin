import { join } from 'node:path';
import { generateFidelitySite } from '@underpin/importer/src/generate/fidelity.js';
import { writeFidelityReport } from '@underpin/importer/src/report/fidelity.js';
import { verifyBuild } from '@underpin/importer/src/verify/index.js';
import { createLlm } from '@underpin/importer/src/llm/index.js';
import { dirFor, hostOf, readJson, writeJson, ndjson, fail } from '../../../lib/studio.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Capture opens a real browser for every selected page, so this is minutes, not seconds.
export const maxDuration = 3600;

/**
 * Stages 7 to 9: capture and generate, report, verify.
 *
 * Fidelity is the default because it is what opening this tool asks for — the same site, in
 * React, without WordPress. Template mode stays on the CLI.
 */
export async function POST(request) {
  const {
    siteUrl, componentize = true, mediaLimit = null, virgin = true, llm = false
  } = await request.json().catch(() => ({}));

  const out = dirFor(siteUrl);
  const plan = readJson(join(out, 'migration.plan.json'));
  if (!plan) return fail('Nothing to build yet — run discovery and scope first.');

  return ndjson(async (send) => {
    send({
      type: 'stage',
      stage: 'generate',
      label: 'Rendering each page in a real browser and re-hosting its assets'
    });

    const result = await generateFidelitySite({
      outDir: join(out, 'site'),
      siteUrl,
      plan,
      mediaLimit,
      componentize,
      virgin,
      llm: createLlm({ enabled: llm }),
      onProgress: (ev) => send(ev)
    });

    writeJson(join(out, 'generate-result.json'), result);
    send({
      type: 'generated',
      routes: result.routes.length,
      routeList: result.routes.map((r) => ({ path: r.path, url: r.url })),
      media: result.media,
      mode: result.mode ?? 'fidelity',
      parity: result.parity ?? null,
      // A page the origin refused is the difference between a thin migration and a broken
      // one, and it is the operator's problem to act on — usually by waiting out a rate
      // limit. Reported alongside the successes rather than buried in the report file.
      captureFailures: result.captureFailures ?? []
    });

    send({ type: 'stage', stage: 'report', label: 'Writing the migration report' });
    await writeFidelityReport(out, siteUrl);
    const report = readJson(join(out, '_migration', 'report.json'), { counts: {}, rows: [] });
    send({ type: 'report', counts: report.counts, rows: report.rows });

    send({ type: 'stage', stage: 'verify', label: 'Checking the export against the acceptance criteria' });
    const verify = verifyBuild({ outDir: out, siteUrl, routes: result.routes, generated: result });
    writeJson(join(out, '_migration', 'verify.json'), verify);
    send({ type: 'verify', verify });

    send({ type: 'done', host: hostOf(siteUrl) });
  });
}
