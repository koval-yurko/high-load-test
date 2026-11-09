'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadSlo, SLO_PATH } = require('../scripts/generate-slo');

const lib = (f) => import(path.join(__dirname, '..', '..', 'infra', 'k6', 'tests', 'lib', f));

// Deterministic uniform source, so the statistics below do not flake.
function lcg(seed = 42) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

test('the 20-step cycle carries the slo.yaml mix exactly', async () => {
  const { CYCLE } = await lib('mix.js');
  const mix = loadSlo(SLO_PATH).mix;
  assert.equal(CYCLE.length, 20);
  for (const c of ['fast', 'standard', 'heavy'])
    assert.equal(CYCLE.filter((x) => x === c).length / 20, mix[c]);
});

test('thinning sends 1 in 4 at the target rate', async () => {
  const { shouldSend, iterationRate } = await lib('arrivals.js');
  assert.equal(iterationRate(55), 220);
  const rnd = lcg();
  let sent = 0;
  for (let i = 0; i < 200000; i++) if (shouldSend(rnd)) sent++;
  assert.ok(Math.abs(sent / 200000 - 0.25) < 0.005, `sent fraction ${sent / 200000}`);
});

test('thinned gaps are near-random: CV = sqrt(1 - p) = 0.866, against 0 for even arrivals', async () => {
  const { shouldSend } = await lib('arrivals.js');
  const rnd = lcg(7);
  const gaps = [];
  let last = -1;
  for (let slot = 0; slot < 400000; slot++) {
    if (!shouldSend(rnd)) continue;
    if (last >= 0) gaps.push(slot - last);
    last = slot;
  }
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
  assert.ok(Math.abs(sd / mean - Math.sqrt(0.75)) < 0.02, `CV ${sd / mean}`);
});
