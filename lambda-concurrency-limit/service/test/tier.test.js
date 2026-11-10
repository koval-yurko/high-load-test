'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const lib = (f) => import(path.join(__dirname, '..', '..', 'infra', 'k6', 'tests', 'lib', f));

test('a 429 with x-throttle: apigw is rate limited by apigw', async () => {
  const { rateLimitedBy } = await lib('tier.js');
  assert.equal(rateLimitedBy(429, { 'x-throttle': 'apigw' }), 'apigw');
});

test('a 429 with x-throttle: waf is rate limited by waf', async () => {
  const { rateLimitedBy } = await lib('tier.js');
  assert.equal(rateLimitedBy(429, { 'x-throttle': 'waf' }), 'waf');
});

test('the header name matches in any case', async () => {
  const { rateLimitedBy } = await lib('tier.js');
  assert.equal(rateLimitedBy(429, { 'X-Throttle': 'waf' }), 'waf');
  assert.equal(rateLimitedBy(429, { 'x-throttle': 'waf' }), 'waf');
});

test('a 429 without x-throttle is not rate limited, and is not available', async () => {
  const { rateLimitedBy, isAvailable } = await lib('tier.js');
  assert.equal(rateLimitedBy(429, {}), null);
  assert.equal(rateLimitedBy(429, { 'x-throttle': 'other' }), null);
  assert.equal(isAvailable(429), false);
});

test('x-throttle on a non-429 status is ignored', async () => {
  const { rateLimitedBy } = await lib('tier.js');
  assert.equal(rateLimitedBy(500, { 'x-throttle': 'apigw' }), null);
});

test('isAvailable: 4xx other than 429 is available, 5xx and no response are not', async () => {
  const { isAvailable } = await lib('tier.js');
  assert.equal(isAvailable(200), true);
  assert.equal(isAvailable(404), true);
  assert.equal(isAvailable(500), false);
  assert.equal(isAvailable(0), false);
});

test('anonymousIp starts at 10.0.0.1 and rolls to the next /24 after 254', async () => {
  const { anonymousIp } = await lib('tier.js');
  assert.equal(anonymousIp(1), '10.0.0.1');
  assert.equal(anonymousIp(254), '10.0.0.254');
  assert.equal(anonymousIp(255), '10.0.1.1');
});

test('anonymousIp gives distinct addresses for distinct callers', async () => {
  const { anonymousIp } = await lib('tier.js');
  for (const n of [20, 600]) {
    const seen = new Set();
    for (let i = 1; i <= n; i++) seen.add(anonymousIp(i));
    assert.equal(seen.size, n);
  }
});

test('the caller counts are the spec sizes', async () => {
  const { ANON_CALLERS } = await lib('tier.js');
  assert.equal(ANON_CALLERS, 20);
});

test('the per-tier VU caps add up to at most the 100-VU cap', async () => {
  const { TIER_VU_CAP } = await lib('tier.js');
  const { VU_CAP } = await lib('arrivals.js');
  const total = Object.values(TIER_VU_CAP).reduce((a, b) => a + b, 0);
  assert.ok(total <= VU_CAP, `caps total ${total}`);
});
