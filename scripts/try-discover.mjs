#!/usr/bin/env node
// Scratch harness: run the discovery chain against a real site and print the evidence.
import { discover } from '../packages/importer/src/discover/index.js';
const site = process.argv[2];
if (!site) { console.error('usage: node scripts/try-discover.mjs <url>'); process.exit(1); }
const t = Date.now();
const r = await discover(site);
console.log('site   :', r.origin);
console.log('urls   :', r.urls.length, r.viaLinkCrawl ? '(homepage link crawl)' : '(sitemap)');
console.log('robots :', r.robots.present ? `present · ${r.robots.sitemaps.length} sitemap directive(s) · ${r.robots.disallow.length} disallow` : 'absent');
console.log('blocked:', r.blockedByRobots);
console.log('rest   :', JSON.stringify(r.rest));
console.log('chain  :');
for (const c of r.chain) console.log('    ', JSON.stringify(c));
console.log('sample :');
for (const u of r.urls.slice(0, 6)) console.log('    ', u.loc);
console.log('elapsed:', ((Date.now() - t) / 1000).toFixed(1) + 's');

// --- fingerprint
const { fingerprint } = await import('../packages/importer/src/fingerprint/index.js');
console.log('\n--- fingerprint');
const f = await fingerprint(r);
console.log('builder    :', f.builder);
console.log('namespaces :', f.restNamespaces.join(', ') || '(none exposed)');
console.log('hreflang   :', f.hreflangs.join(', ') || '(none)');
console.log('capabilities:');
for (const c of f.capabilities) {
  console.log(`   ${c.id.padEnd(14)} conf=${String(c.confidence).padEnd(5)} ${JSON.stringify(c.detected)}`);
  for (const e of c.evidence) console.log(`      · ${e}`);
}
console.log('needs a human decision:', f.needsDecision.map(d=>d.id).join(', ') || '(none)');
