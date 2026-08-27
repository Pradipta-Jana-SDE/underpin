import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The falsifiability test for "templates can be reused across multiple websites".
 *
 * A template that only ever absorbs pages from the site it was written against has not
 * been shown to be reusable — it has been shown to fit one site. Running this on
 * yourself before an interviewer does is the difference between a claim and evidence.
 */
export function reuseMatrix(sitesDir) {
  if (!existsSync(sitesDir)) return { sites: [], templates: [], reused: 0, total: 0 };

  const sites = readdirSync(sitesDir).filter((d) => existsSync(join(sitesDir, d, 'template-plan.json')));
  const usage = new Map();

  for (const site of sites) {
    const plan = JSON.parse(readFileSync(join(sitesDir, site, 'template-plan.json'), 'utf8'));
    for (const m of plan) {
      if (!usage.has(m.chosen)) usage.set(m.chosen, {});
      const row = usage.get(m.chosen);
      row[site] = (row[site] ?? 0) + 1;
    }
  }

  const templates = [...usage.entries()]
    .map(([id, bySite]) => {
      const siteCount = Object.keys(bySite).length;
      const pages = Object.values(bySite).reduce((a, b) => a + b, 0);
      return { id, bySite, siteCount, pages, reused: siteCount > 1 };
    })
    .sort((a, b) => b.siteCount - a.siteCount || b.pages - a.pages);

  return {
    sites,
    templates,
    reused: templates.filter((t) => t.reused).length,
    total: templates.length
  };
}
