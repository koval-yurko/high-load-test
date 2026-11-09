'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { render, renderGrafana, windowSeconds, loadSlo, SLO_PATH, OUT_PATH, GRAFANA_OUT_PATH } = require('../scripts/generate-slo');

const slo = loadSlo(SLO_PATH);

test('renders thresholds, objectives and mix from slo.yaml', () => {
  const out = render(slo);
  assert.match(out, /CLASS_THRESHOLD_MS = \{"fast":300,"standard":400,"heavy":1000\}/);
  assert.match(out, /LATENCY_RATE = 0\.95;/);
  assert.match(out, /AVAILABILITY_RATE = 0\.99;/);
  assert.match(out, /MIX = \{"fast":0\.7,"standard":0\.25,"heavy":0\.05\}/);
});

test('the mix sums to 1', () => {
  const sum = Object.values(slo.mix).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `mix sums to ${sum}`);
});

test('the committed lib/slo.js is what slo.yaml generates', () => {
  assert.equal(fs.readFileSync(OUT_PATH, 'utf8'), render(slo));
});

test('a missing class threshold is refused', () => {
  const bad = structuredClone(slo);
  bad.slos[0].classes.fast.threshold_ms = null;
  assert.throws(() => render(bad), /fast/);
});

test('renderGrafana writes what the alert rules and panels read', () => {
  const g = JSON.parse(renderGrafana(loadSlo(SLO_PATH)));
  assert.equal(g.availability_objective, 0.99);
  assert.equal(g.latency_objective, 0.95);
  assert.deepEqual(g.class_threshold_ms, { fast: 300, standard: 400, heavy: 1000 });
  assert.deepEqual(g.class_route, { fast: '/items/{pk}/{sk}', standard: '/feeds/{pk}', heavy: '/reports/{pk}' });
  assert.deepEqual(g.burn, { fast: { factor: 14.4, window_seconds: 3600 }, slow: { factor: 6, window_seconds: 21600 } });
});

test('windowSeconds reads m and h, and refuses anything else', () => {
  assert.equal(windowSeconds('30m'), 1800);
  assert.equal(windowSeconds('6h'), 21600);
  assert.throws(() => windowSeconds('1d'), /window/);
});

test('a burn factor that can never fire is refused', () => {
  const slo = loadSlo(SLO_PATH);
  slo.slos.find((s) => s.name === 'availability').burn.fast.factor = 100; // 100 × 1% = 100%
  assert.throws(() => renderGrafana(slo), /can never fire/);
});

test('the committed slo.json is current', () => {
  assert.equal(fs.readFileSync(GRAFANA_OUT_PATH, 'utf8'), renderGrafana(loadSlo(SLO_PATH)));
});
