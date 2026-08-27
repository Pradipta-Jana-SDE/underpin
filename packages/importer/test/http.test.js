import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvesToSelf } from '../src/util/http.js';

// WordPress 301s unknown paths to the homepage. Reading that as "the route exists"
// produced a false WooCommerce detection on wordpress.org during development.
test('resolvesToSelf: 200 is presence', () => {
  assert.equal(resolvesToSelf('/shop/', { status: 200, location: null }), true);
});

test('resolvesToSelf: redirect to homepage is ABSENCE, not presence', () => {
  assert.equal(resolvesToSelf('/shop/', { status: 301, location: 'https://x.com/' }), false);
  assert.equal(resolvesToSelf('/shop/', { status: 302, location: '/' }), false);
});

test('resolvesToSelf: redirect that keeps the segment is presence', () => {
  assert.equal(resolvesToSelf('/shop', { status: 301, location: 'https://x.com/shop/' }), true);
});

test('resolvesToSelf: redirect to an unrelated path is absence', () => {
  assert.equal(resolvesToSelf('/cart/', { status: 301, location: '/blog/' }), false);
});

test('resolvesToSelf: 404 and network failure are absence', () => {
  assert.equal(resolvesToSelf('/cart/', { status: 404, location: null }), false);
  assert.equal(resolvesToSelf('/cart/', { status: 0, location: null }), false);
});
