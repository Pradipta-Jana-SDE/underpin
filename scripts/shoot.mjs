import { chromium } from 'playwright';
const OUT = '.shots';
const b = await chromium.launch();
const errors = [];

async function shot(name, { path: url, width = 1440, height = 950, steps = async () => {} }) {
  const ctx = await b.newContext({ viewport: { width, height }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  await steps(page);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log(`  ${name}.png`);
  await ctx.close();
}

const S = 'http://localhost:4400';

await shot('01-source', { path: S });

await shot('02-findings', {
  path: S,
  steps: async (p) => {
    await p.fill('#url', 'https://elementor.com');
    await p.click('#btnInspect');
    await p.waitForSelector('#findStats .stat', { timeout: 90000 });
    await p.waitForTimeout(600);
  }
});

await shot('03-scope', {
  path: S,
  steps: async (p) => {
    await p.fill('#url', 'https://elementor.com');
    await p.click('#btnInspect');
    await p.waitForSelector('#findStats .stat', { timeout: 90000 });
    await p.click('#btnToScope');
    await p.waitForTimeout(400);
  }
});

// The migrated site itself, at mobile and desktop.
await shot('05-migrated-desktop', { path: `${S}/preview/elementor.com/`, width: 1440, height: 950 });
await shot('06-migrated-mobile', { path: `${S}/preview/elementor.com/`, width: 390, height: 850 });
await shot('07-report', { path: `${S}/report/elementor.com/report.html`, width: 1440, height: 950 });

await b.close();
console.log(errors.length ? `\nCONSOLE ERRORS:\n${errors.join('\n')}` : '\nno console errors');
