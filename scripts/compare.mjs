import { chromium } from 'playwright';
const b = await chromium.launch();
const pairs = [
  ['orig',     'https://elementor.com/'],
  ['fidelity', 'http://localhost:4400/preview/elementor-fidelity/'],
  ['template', 'http://localhost:4400/preview/elementor.com/']
];
const errs = [];
for (const [name, url] of pairs) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(`${name}: ${m.text().slice(0, 110)}`); });
  await p.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `.shots/cmp-${name}.png` });
  console.log(`  cmp-${name}.png`);
  await ctx.close();
}
await b.close();
console.log(errs.length ? '\nissues:\n' + [...new Set(errs)].slice(0, 8).join('\n') : '\nno page errors');
