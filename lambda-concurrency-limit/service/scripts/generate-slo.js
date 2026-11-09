'use strict';
// slo.yaml is the single source; this writes the k6 side and the Grafana side.
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const ROOT = path.join(__dirname, '..', '..');
const SLO_PATH = path.join(ROOT, 'slo.yaml');
const OUT_PATH = path.join(ROOT, 'infra', 'k6', 'tests', 'lib', 'slo.js');
const GRAFANA_OUT_PATH = path.join(ROOT, 'infra', 'grafana', 'slo.json');
const CLASSES = ['fast', 'standard', 'heavy'];

const loadSlo = (p) => YAML.parse(fs.readFileSync(p, 'utf8'));

function windowSeconds(text) {
  const m = /^(\d+)([mh])$/.exec(String(text));
  if (!m) throw new Error(`slo.yaml: burn window must look like 30m or 6h, got ${JSON.stringify(text)}`);
  return Number(m[1]) * (m[2] === 'h' ? 3600 : 60);
}

function renderGrafana(slo) {
  const lat = slo.slos.find((s) => s.name === 'latency-classes');
  const avail = slo.slos.find((s) => s.name === 'availability');
  const budget = 1 - avail.objective / 100;
  const burn = {};
  for (const [k, b] of Object.entries(avail.burn)) {
    if (!(b.factor * budget < 1)) throw new Error(`slo.yaml: burn ${k} factor ${b.factor} × budget ${budget} ≥ 1, so the alert can never fire`);
    burn[k] = { factor: b.factor, window_seconds: windowSeconds(b.window) };
  }
  const out = {
    availability_objective: avail.objective / 100,
    latency_objective: lat.objective / 100,
    class_threshold_ms: Object.fromEntries(CLASSES.map((c) => [c, lat.classes[c].threshold_ms])),
    // "GET /items/{pk}/{sk}" -> "/items/{pk}/{sk}", the API Gateway Resource dimension.
    class_route: Object.fromEntries(CLASSES.map((c) => [c, lat.classes[c].route.split(' ')[1]])),
    burn,
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

function render(slo) {
  const lat = slo.slos.find((s) => s.name === 'latency-classes');
  const avail = slo.slos.find((s) => s.name === 'availability');
  const ms = {};
  for (const c of CLASSES) {
    const t = lat.classes[c]?.threshold_ms;
    if (!(t > 0)) throw new Error(`slo.yaml: class ${c} has no threshold_ms`);
    ms[c] = t;
  }
  const mix = Object.fromEntries(CLASSES.map((c) => [c, slo.mix[c]]));
  return `// GENERATED from slo.yaml by npm run slo:generate. Do not edit by hand.
// Thresholds frozen: ${lat.frozen === true}.
export const CLASS_THRESHOLD_MS = ${JSON.stringify(ms)};
export const LATENCY_RATE = ${lat.objective / 100};
export const AVAILABILITY_RATE = ${avail.objective / 100};
export const MIX = ${JSON.stringify(mix)};

// The gates for the samples matching one tag selector, e.g. 'window:measured'. Only
// judged users add samples to slo_met and slo_available (lib/request.js).
export function gate(selector) {
  return {
    [\`slo_met{\${selector}}\`]: [\`rate>=\${LATENCY_RATE}\`],
    [\`slo_available{\${selector}}\`]: [\`rate>=\${AVAILABILITY_RATE}\`],
    // An arrival-rate run that runs out of VUs delivers less than its rate and then
    // passes at that lower rate. Such a run is not a measurement. Refuse it.
    dropped_iterations: ['count==0'],
    // Reported, not gated: a threshold that cannot fail makes k6 print the sub-metric.
    [\`http_req_duration{class:fast,\${selector}}\`]: ['p(95)>=0', 'p(99)>=0'],
    [\`http_req_duration{class:standard,\${selector}}\`]: ['p(95)>=0', 'p(99)>=0'],
    [\`http_req_duration{class:heavy,\${selector}}\`]: ['p(95)>=0', 'p(99)>=0'],
    [\`rate_limited{\${selector}}\`]: ['rate>=0'],
  };
}
`;
}

if (require.main === module) {
  const slo = loadSlo(SLO_PATH);
  const outputs = [[OUT_PATH, render(slo)], [GRAFANA_OUT_PATH, renderGrafana(slo)]];
  if (process.argv.includes('--check')) {
    let stale = false;
    for (const [p, out] of outputs) {
      const current = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
      if (current !== out) { console.error(`${p} is stale: run npm run slo:generate`); stale = true; }
    }
    if (stale) process.exit(1);
  } else {
    for (const [p, out] of outputs) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, out);
      console.log(`wrote ${p}`);
    }
  }
}

module.exports = { render, renderGrafana, windowSeconds, loadSlo, SLO_PATH, OUT_PATH, GRAFANA_OUT_PATH };
