import { test } from 'node:test';
import assert from 'node:assert/strict';
import { negotiateScope } from '../src/scope/index.js';
import { optionsFor, recommendedFor } from '../src/scope/options.js';

const discovery = {
  urls: [
    { loc: 'https://x.com/' },
    { loc: 'https://x.com/services/roofing/' },
    { loc: 'https://x.com/product/widget/' },
    { loc: 'https://x.com/cart/' },
    { loc: 'https://x.com/checkout/' },
    { loc: 'https://x.com/my-account/' }
  ]
};
const woo = {
  id: 'woocommerce', label: 'WooCommerce', confidence: 1,
  signalClasses: ['rest'], evidence: ['REST namespace wc/v3'],
  detected: { products: 1 }
};

test('scope contract routes every excluded URL — never a bare 404', async () => {
  const plan = await negotiateScope({
    discovery, fingerprint: { needsDecision: [woo] }, interactive: false, siteUrl: 'https://x.com'
  });
  assert.equal(plan.pages.excluded, 3, 'cart, checkout and my-account are excluded');
  for (const e of plan.excludedUrls) {
    assert.ok(['410', 'redirect', 'proxy_to_legacy'].includes(e.policy),
      `${e.url} was excluded with no routing policy`);
  }
});

test('static catalogue keeps products in scope but drops the cart', async () => {
  const plan = await negotiateScope({
    discovery, fingerprint: { needsDecision: [woo] }, interactive: false, siteUrl: 'https://x.com'
  });
  assert.ok(plan.inScopeUrls.includes('https://x.com/product/widget/'));
  assert.ok(!plan.inScopeUrls.includes('https://x.com/cart/'));
  assert.ok(plan.inScopeUrls.includes('https://x.com/services/roofing/'));
});

test('every capability offers a recommendation so --yes is always defined', () => {
  for (const id of ['woocommerce', 'membership', 'lms', 'booking', 'multilingual', 'blog', 'search']) {
    const rec = recommendedFor({ id, detected: {}, evidence: [] });
    assert.ok(rec, `${id} has no recommended disposition`);
    assert.ok(rec.label, `${id} recommendation has no label`);
  }
});

test('irreversible capabilities name what the system will NOT do', () => {
  // A user who wanted rebuilt auth must learn it here, not at review.
  for (const id of ['woocommerce', 'membership']) {
    const set = optionsFor({ id, detected: {}, evidence: [] });
    assert.ok(set.unavailable.length > 0, `${id} hides its limitations`);
    assert.ok(set.unavailable.every((u) => u.why), `${id} states a limit without a reason`);
  }
});
