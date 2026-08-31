import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchRoute } from '../src/handlers.js';
import { burnWindows, loadSlo, renderCapacityTfvars, renderClassMap, renderK6 } from '../scripts/generate-slo.js';
import { ratioExpr, renderAlerts, renderLocals } from '../scripts/generate-slo.js';

const HERE = new URL('..', import.meta.url).pathname;

test('burn windows scale with the SLO window, multipliers do not', () => {
  // The Google reference: a 30-day window pages at 14.4x over 1h and tickets at
  // 6x over 6h. Those encode "2% of budget" and "5% of budget" respectively.
  const thirtyDays = burnWindows(30 * 86400);
  assert.equal(thirtyDays.fast.multiplier, 14.4);
  assert.equal(thirtyDays.fast.window, '1h');
  assert.equal(thirtyDays.slow.multiplier, 6);
  assert.equal(thirtyDays.slow.window, '6h');

  // A 3-day window is 1/10th, so the alert windows are 1/10th and the budget
  // fractions are preserved. Multipliers are invariant.
  const threeDays = burnWindows(3 * 86400);
  assert.equal(threeDays.fast.multiplier, 14.4);
  assert.equal(threeDays.fast.window, '6m');
  assert.equal(threeDays.slow.multiplier, 6);
  assert.equal(threeDays.slow.window, '36m');
});

test('a mix that does not sum to 1.0 is refused', () => {
  assert.throws(
    () => loadSlo(null, { service: 's', window: '30d', slos: [], capacity: {
      target_rps: 1000, mix: { read: 0.5, write: 0.1 }, cost_per_request: {},
    } }),
    /mix must sum to 1\.0/,
  );
});

test('an endpoint in two classes is refused', () => {
  assert.throws(
    () => loadSlo(null, { service: 's', window: '30d', capacity: null, slos: [{
      name: 'l', sli: 'class_threshold_ratio', objective: 99, tail_objective: 99.9,
      tail_multiplier: 3,
      classes: { fast: { threshold_ms: 50, endpoints: ['feed'] },
                 standard: { threshold_ms: 200, endpoints: ['feed'] } },
    }] }),
    /endpoint "feed" appears in more than one class/,
  );
});

test('regenerating the committed slo.yaml reproduces the committed outputs byte for byte', () => {
  const model = loadSlo(`${HERE}slo.yaml`);
  assert.equal(renderK6(model), readFileSync(`${HERE}k6/lib/slo.js`, 'utf8'));
  assert.equal(renderCapacityTfvars(model), readFileSync(`${HERE}terraform/capacity.auto.tfvars`, 'utf8'));
});

test('the committed slo.yaml is a 7-day window with 14m/84m burn alerting', () => {
  // 7d is the intersection of two hard limits, not a preference. Grafana's SLO
  // API refuses anything outside 7-32 days ("Use time window of at least 7 days
  // and at most 32 days"), and Grafana Cloud Free retains metrics for 14 days,
  // so a longer window could never be evaluated over the period it claims.
  const model = loadSlo(`${HERE}slo.yaml`);
  assert.equal(model.window, '7d');
  assert.equal(model.windowSeconds, 604800);
  assert.equal(model.burn.fast.window, '14m');
  assert.equal(model.burn.fast.forDuration, '70s');
  assert.equal(model.burn.slow.window, '84m');
  assert.equal(model.burn.slow.forDuration, '7m');
});

test('every generated burn duration is a duration the grafana provider accepts', () => {
  // 7d/30d scales 300s to 70s -- not a whole minute. The renderer must emit "70s"
  // and never a fraction like "1.17m", which the provider's regex rejects.
  const model = loadSlo(`${HERE}slo.yaml`);
  const valid = /^\d+(ms|s|m|h|d|w|y)$/;
  for (const burn of Object.values(model.burn)) {
    assert.match(burn.window, valid);
    assert.match(burn.forDuration, valid);
  }
});

test('every endpoint in slo.yaml maps to a route template that handlers.js serves', () => {
  const model = loadSlo(`${HERE}slo.yaml`);
  for (const [name, template] of Object.entries(model.endpoints)) {
    // Rebuild a concrete path from the template so matchRoute can be asked
    // whether this route still exists under that exact name.
    const concrete = template.replace(/:[^/]+/g, 'x');
    const method = template === '/items' || template === '/reports' ? 'POST' : 'GET';
    const hit = matchRoute(method, concrete);
    assert.ok(hit, `slo.yaml names endpoint "${name}" at ${template}, which handlers.js does not serve`);
    assert.equal(hit.template, template);
    assert.equal(hit.name, name);
  }
});

test('every class member is a declared endpoint', () => {
  const model = loadSlo(`${HERE}slo.yaml`);
  const slo = model.slos.find((s) => s.sli === 'class_threshold_ratio');
  for (const cls of Object.values(slo.classes)) {
    for (const endpoint of cls.endpoints) {
      assert.ok(model.endpoints[endpoint], `class references undeclared endpoint "${endpoint}"`);
    }
  }
});

test('the class map is keyed by route template, not endpoint name', () => {
  const map = JSON.parse(renderClassMap(loadSlo(`${HERE}slo.yaml`)));
  assert.deepEqual(map, {
    '/items/:pk/:sk': 'fast',
    '/items': 'fast',
    '/feeds/:pk': 'standard',
    '/reports': 'heavy',
  });
  // /healthz and /stats are absent on purpose: they are emitted but unclassified,
  // and the SLO query excludes them by selector (spec S15).
  assert.equal(map['/healthz'], undefined);
});

test('alert rules query native histograms and carry the derived burn windows', () => {
  const out = renderAlerts(loadSlo(`${HERE}slo.yaml`));

  // The whole point of native histograms: thresholds applied at query time.
  assert.match(out, /histogram_fraction\(0, 0\.05,/);   // fast     50ms
  assert.match(out, /histogram_fraction\(0, 0\.2,/);    // standard 200ms
  assert.match(out, /histogram_fraction\(0, 0\.8,/);    // heavy    800ms

  // Derived from window: 7d, not copied from a 30-day reference.
  assert.match(out, /\[14m\]/);
  assert.match(out, /\[84m\]/);
  assert.doesNotMatch(out, /\[1h\]/);
  assert.doesNotMatch(out, /\[6h\]/);

  // The k6-era series must be gone entirely, not merely unused.
  assert.doesNotMatch(out, /slo_met/);
  assert.doesNotMatch(out, /http_req_failed/);

  // Scoped by job, which OTLP derives from service.name -- not by a --tag a run
  // can forget to pass.
  assert.match(out, /job="ecs-dynamodb-rps-ceiling"/);

  // Health checks outnumber real traffic between runs by 1.5x to 6x.
  assert.match(out, /http_route!~"\/healthz\|\/stats"/);
});

test('grafana/locals.tf is generated, so the SLO objective cannot drift from slo.yaml', () => {
  // grafana_slo's objective and window used to be typed into grafana/slo.tf by
  // hand -- the same numbers as slo.yaml, in a file slo:check never read. They
  // are generated now, so this is a byte-identity check like every other output.
  const doc = loadSlo(`${HERE}slo.yaml`);
  assert.equal(renderLocals(doc), readFileSync(`${HERE}grafana/locals.tf`, 'utf8'));
});

test('the generated locals carry slo.yaml\'s objective and window verbatim', () => {
  const doc = loadSlo(`${HERE}slo.yaml`);
  const out = renderLocals(doc);
  assert.match(out, /slo_objective = 0\.99\n/);
  assert.match(out, /slo_window    = "7d"\n/);
  // And slo.tf must READ them rather than restate them.
  const sloTf = readFileSync(`${HERE}grafana/slo.tf`, 'utf8');
  assert.match(sloTf, /value  = local\.slo_objective/);
  assert.match(sloTf, /window = local\.slo_window/);
  assert.doesNotMatch(sloTf, /value  = 0\.99/);
});

test('the SLO query is the same ratio the burn rules read', () => {
  // Same population, or grafana_slo and its own alerts measure different things.
  const doc = loadSlo(`${HERE}slo.yaml`);
  const body = ratioExpr(doc, { range: '$__rate_interval', job: '${var.project}' })
    .split('\n').map((line) => `    ${line}`).join('\n');
  assert.ok(
    readFileSync(`${HERE}grafana/locals.tf`, 'utf8').includes(`<<-PROMQL\n${body}\n  PROMQL`),
    'grafana/locals.tf no longer matches ratioExpr(doc, { range: "$__rate_interval" })',
  );
});