// test/admission.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AggregationTemporality, MetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { REQUEST_DURATION, bindHistogram, buildMeterProvider } from '../src/otel.js';
import { createAdmission, shouldShed } from '../src/admission.js';
import { matchRoute } from '../src/handlers.js';
import { createServer } from '../src/server.js';

const ITEMS = matchRoute('POST', '/items');
const HEALTH = matchRoute('GET', '/healthz');

/** A sampler whose next reading the test sets. */
function fakeSampler(value) {
  const s = { value, calls: 0, sample() { s.calls += 1; return s.value; } };
  return s;
}

/** Handlers that do nothing but record that they were reached. */
function recordingHandlers() {
  const calls = [];
  const handler = (name) => async () => { calls.push(name); return { status: 200, body: { name } }; };
  return {
    calls,
    handlers: {
      health: handler('health'), feed: handler('feed'), getItem: handler('getItem'),
      putItem: handler('putItem'), report: handler('report'),
    },
  };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, r));
  return (p) => `http://localhost:${server.address().port}${p}`;
}

// --- the pure decision -------------------------------------------------------

test('ELU above the threshold sheds', () => {
  assert.equal(shouldShed({ elu: 0.95, threshold: 0.92, route: ITEMS }), true);
});

test('ELU below the threshold admits', () => {
  assert.equal(shouldShed({ elu: 0.5, threshold: 0.92, route: ITEMS }), false);
});

test('ELU exactly at the threshold admits: shedding starts when ELU EXCEEDS it', () => {
  assert.equal(shouldShed({ elu: 0.92, threshold: 0.92, route: ITEMS }), false);
});

test('/healthz is never shed, however busy the task is', () => {
  // The ALB must not be told a task is unhealthy because it is busy -- that
  // would deregister capacity at the exact moment it is needed.
  assert.equal(shouldShed({ elu: 1, threshold: 0.92, route: HEALTH }), false);
});

// --- the wrapper that owns the sampler ---------------------------------------

test('the admission gate reads a cached ELU, refreshed by its own sampler', () => {
  const sampler = fakeSampler(0.95);
  const admission = createAdmission({ threshold: 0.92, sampler });
  // Before the first refresh nothing has been measured: admit.
  assert.equal(admission.shouldShed(ITEMS), false);
  admission.refresh();
  assert.equal(admission.elu, 0.95);
  assert.equal(admission.shouldShed(ITEMS), true);
  // Deciding does not sample: per-request sampling over microsecond windows is noise.
  admission.shouldShed(ITEMS);
  admission.shouldShed(ITEMS);
  assert.equal(sampler.calls, 1);
  sampler.value = 0.4;
  admission.refresh();
  assert.equal(admission.shouldShed(ITEMS), false);
});

test('start() refreshes on an unref\'d timer and stop() clears it', () => {
  const admission = createAdmission({ threshold: 0.92, sampler: fakeSampler(0.1), intervalMs: 50 });
  admission.start();
  assert.ok(admission.timer, 'no timer after start()');
  assert.equal(admission.timer.hasRef(), false, 'the admission timer must not keep the process alive');
  admission.stop();
  assert.equal(admission.timer, null);
});

// --- the gate in the server --------------------------------------------------

test('a shed request is a 429 with Retry-After: 1 and touches no handler or repository', async (t) => {
  const { calls, handlers } = recordingHandlers();
  const admission = createAdmission({ threshold: 0.92, sampler: fakeSampler(0.99) });
  admission.refresh();
  const server = createServer({ handlers, admission });
  t.after(() => server.close());
  const url = await listen(server);

  for (const [path, init] of [
    ['/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
    ['/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"pk":"feed-00"}' }],
    ['/feeds/feed-00', undefined],
    ['/items/feed-00/item-00', undefined],
  ]) {
    const res = await fetch(url(path), init);
    assert.equal(res.status, 429, `${path} was not shed`);
    assert.equal(res.headers.get('retry-after'), '1');
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await res.json(), { error: 'overloaded' });
  }
  // The handlers are the only path to the repository, so no handler call means no DB work.
  assert.deepEqual(calls, []);
});

test('/healthz still answers 200 while every other route is shed', async (t) => {
  const { calls, handlers } = recordingHandlers();
  const admission = createAdmission({ threshold: 0.92, sampler: fakeSampler(1) });
  admission.refresh();
  const server = createServer({ handlers, admission });
  t.after(() => server.close());
  const url = await listen(server);

  assert.equal((await fetch(url('/healthz'))).status, 200);
  assert.deepEqual(calls, ['health']);
});

test('below the threshold the request reaches its handler', async (t) => {
  const { calls, handlers } = recordingHandlers();
  const admission = createAdmission({ threshold: 0.92, sampler: fakeSampler(0.3) });
  admission.refresh();
  const server = createServer({ handlers, admission });
  t.after(() => server.close());
  const url = await listen(server);

  assert.equal((await fetch(url('/items'), { method: 'POST', body: '{}' })).status, 200);
  assert.deepEqual(calls, ['putItem']);
});

test('without an admission gate nothing is shed (SHED_ELU_THRESHOLD absent)', async (t) => {
  const { calls, handlers } = recordingHandlers();
  const server = createServer({ handlers });
  t.after(() => server.close());
  const url = await listen(server);

  assert.equal((await fetch(url('/feeds/feed-00'))).status, 200);
  assert.deepEqual(calls, ['feed']);
});

test('a shed request is recorded with status 429 and its real route label (spec §7)', async (t) => {
  class TestReader extends MetricReader {
    selectAggregationTemporality() { return AggregationTemporality.CUMULATIVE; }
    async onForceFlush() {}
    async onShutdown() {}
  }
  const reader = new TestReader();
  const provider = buildMeterProvider({
    resource: resourceFromAttributes({ 'service.name': 'test', 'service.instance.id': 'task-1' }),
    readers: [reader],
  });
  bindHistogram(provider);
  t.after(() => provider.shutdown());

  const { handlers } = recordingHandlers();
  const admission = createAdmission({ threshold: 0.92, sampler: fakeSampler(0.99) });
  admission.refresh();
  const server = createServer({ handlers, admission });
  t.after(() => server.close());
  const url = await listen(server);

  const res = await fetch(url('/items'), { method: 'POST', body: '{}' });
  await res.arrayBuffer();
  // recordRequest runs on 'finish', which can land just after the client has the response.
  await new Promise((r) => setImmediate(r));

  const { resourceMetrics } = await reader.collect();
  const metric = resourceMetrics.scopeMetrics[0].metrics.find((m) => m.descriptor.name === REQUEST_DURATION);
  const points = metric.dataPoints.map((p) => [p.attributes['http.route'], p.attributes['http.response.status_code']]);
  // The route label, not 'unmatched': the collector maps it to a latency class,
  // and Grafana's GOOD selector (!~"5..") then counts the 429 as good.
  assert.deepEqual(points, [['/items', 429]]);
});

// --- spec §6.1 invariant: shed ABOVE scale-out --------------------------------

const INFRA = new URL('../../infra/main/', import.meta.url).pathname;

/** The text of one top-level HCL block, found by header and closed by brace counting. */
function hclBlock(text, header) {
  const start = text.indexOf(header);
  assert.notEqual(start, -1, `could not find ${header}`);
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  assert.fail(`unterminated block ${header}`);
}

const numbers = (block, key) =>
  [...block.matchAll(new RegExp(`^\\s*${key}\\s*=\\s*(-?[0-9.]+)`, 'gm'))].map((m) => Number(m[1]));

test('every configured ELU scale-out threshold sits strictly below the shed threshold (spec §6.1)', () => {
  // Shedding LOWERS event-loop utilization -- that is what it is for -- so it
  // clamps ELU at roughly the shed threshold. A scale-out step at or above it
  // would never fire, and the service would shed forever on one task while
  // looking healthy. Read from the Terraform, never from literals here, so a
  // tuning pass that inverts the order fails this test instead of a load run.
  const autoscaling = readFileSync(`${INFRA}autoscaling.tf`, 'utf8');
  const alarm = hclBlock(autoscaling, 'resource "aws_cloudwatch_metric_alarm" "elu_high"');
  const policy = hclBlock(autoscaling, 'resource "aws_appautoscaling_policy" "elu"');

  const alarmThresholds = numbers(alarm, 'threshold');
  const bounds = numbers(policy, 'metric_interval_lower_bound');
  // Guard against passing vacuously: a reformat that the parse no longer sees
  // must fail here, not silently compare against nothing.
  assert.equal(alarmThresholds.length, 1, `expected one alarm threshold, parsed ${alarmThresholds}`);
  assert.equal(bounds.length, 2, `expected two step lower bounds, parsed ${bounds}`);

  // Step bounds are RELATIVE to the alarm threshold.
  const [alarmThreshold] = alarmThresholds;
  const scaleOut = [alarmThreshold, ...bounds.map((b) => alarmThreshold + b)];

  // The shed threshold actually deployed: dev.tfvars if it overrides, else the default.
  const variables = readFileSync(`${INFRA}variables.tf`, 'utf8');
  const defaults = numbers(hclBlock(variables, 'variable "shed_elu_threshold"'), 'default');
  assert.equal(defaults.length, 1, `expected one shed_elu_threshold default, parsed ${defaults}`);
  const overrides = numbers(readFileSync(`${INFRA}dev.tfvars`, 'utf8'), 'shed_elu_threshold');
  const shed = overrides.length ? overrides.at(-1) : defaults[0];

  for (const t of scaleOut) {
    assert.ok(t < shed, `scale-out threshold ${t} is not strictly below the shed threshold ${shed} (spec §6.1)`);
  }
});
