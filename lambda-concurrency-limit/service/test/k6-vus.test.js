'use strict';
// Grafana Cloud k6 refuses an upload whose VU count passes 100 (E2004, an organization cap).
// k6 itself computes that count; this asks it, at default rates and at the highest rates plan 3
// uses (C = 100: about 404 RPS; discovery to 420; a 400 RPS spike; the noisy-neighbour defaults).
// It proves an upload is ACCEPTED (E2004), not that a run fits: a run works only while
// rate x client latency (requests in flight) stays <= the scenario's VUs (see loadtest.md).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const TESTS = path.join(__dirname, '..', '..', 'infra', 'k6', 'tests');
const hasK6 = spawnSync('k6', ['version']).status === 0;

function maxVUs(profile, env = {}) {
  const args = ['inspect', '--execution-requirements'];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(path.join(TESTS, `${profile}.js`));
  const r = spawnSync('k6', args, { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).maxVUs;
}

const CASES = [
  ['constant', {}], ['constant', { RATE: 404 }],
  ['discovery', {}], ['discovery', { START_RATE: 20, STEP_RPS: 20, MAX_RATE: 420 }],
  ['spike', {}], ['spike', { PEAK_RATE: 400 }],
  ['noisy-neighbour', {}], ['noisy-neighbour', { NORMAL_RATE: 10, NOISY_RATE: 60 }],
];

for (const [profile, env] of CASES) {
  test(`${profile} ${JSON.stringify(env)} stays within 100 VUs`, { skip: !hasK6 && 'k6 not installed' }, () => {
    const n = maxVUs(profile, env);
    assert.ok(n <= 100, `${profile} needs ${n} VUs`);
  });
}

test('vus() follows Little\'s law and the cap', async () => {
  const { vus, VU_CAP, MEAN_SECONDS } = await import(path.join(TESTS, 'lib', 'arrivals.js'));
  assert.equal(VU_CAP, 100);
  assert.ok(Math.abs(MEAN_SECONDS - 0.36) < 1e-9, `MEAN_SECONDS ${MEAN_SECONDS}`); // 0.7×0.3 + 0.25×0.4 + 0.05×1.0
  assert.deepEqual(vus(55), { preAllocatedVUs: 40, maxVUs: 40 });   // ceil(2 × 55 × 0.36)
  assert.deepEqual(vus(1), { preAllocatedVUs: 5, maxVUs: 5 });      // floor of 5
  assert.deepEqual(vus(404), { preAllocatedVUs: 100, maxVUs: 100 });
  assert.deepEqual(vus(60, 52), { preAllocatedVUs: 44, maxVUs: 44 });   // ceil(43.2)
  assert.deepEqual(vus(400, 80), { preAllocatedVUs: 80, maxVUs: 80 });
});

test('the load zone is Frankfurt, next to eu-central-1', async () => {
  globalThis.__ENV = {}; // env.js reads the k6 global
  const { CLOUD } = await import(path.join(TESTS, 'lib', 'env.js'));
  assert.deepEqual(CLOUD, { distribution: { frankfurt: { loadZone: 'amazon:de:frankfurt', percent: 100 } } });
});

function inspectOptions(profile, env = {}) {
  const args = ['inspect'];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(path.join(TESTS, `${profile}.js`));
  const r = spawnSync('k6', args, { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('rate_source is default without rate flags and explicit with one', { skip: !hasK6 && 'k6 not installed' }, () => {
  assert.equal(inspectOptions('constant').tags.rate_source, 'default');
  assert.equal(inspectOptions('constant', { RATE: 50 }).tags.rate_source, 'explicit');
});
