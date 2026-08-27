import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 950 }, colorScheme: 'dark' });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(e.message.slice(0, 100)));
p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 100)); });
await p.goto('http://localhost:4400/', { waitUntil: 'networkidle' });
await p.fill('#url', 'https://kinsta.com');
await p.click('#btnInspect');
await p.waitForSelector('#findStats .stat', { timeout: 120000 });
await p.click('#btnToScope');
await p.waitForTimeout(400);
await p.click('#btnToPages');
await p.waitForSelector('#pageGroups .pgroup', { timeout: 60000 });
await p.waitForTimeout(600);
await p.screenshot({ path: '.shots/picker.png' });
const info = await p.evaluate(() => ({
  groups: document.querySelectorAll('.pgroup').length,
  count: document.getElementById('pickCount').textContent
}));
console.log('  groups rendered:', info.groups, '|', info.count);
console.log(errs.length ? '  errors: ' + [...new Set(errs)].slice(0,3).join(' | ') : '  no console errors');
await b.close();
