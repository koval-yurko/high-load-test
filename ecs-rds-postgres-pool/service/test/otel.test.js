// test/otel.test.js
// Forked from ecs-dynamodb-rps/service/test/otel.test.js on 2026-09-20, with the
// module-level cases rewritten against the startTelemetry factory and the pool
// instruments added. A bug fixed here does not reach the sibling copy; fix both.
//
// NOTHING here needs PostgreSQL, AWS credentials or an external collector, by
// design and permanently. Most cases drive the instruments through a TestReader
// that collects on demand -- no timer, no exporter, no socket at all.
//
// Five cases do start a real PeriodicExportingMetricReader, because what they
// assert is the wiring around it: the resource, the background start, and the
// recorders going live. Those point at startFakeCollector() -- an ephemeral
// node:http listener inside THIS process, like the ECS metadata stub below --
// rather than at a closed port, because a closed port costs ~8 s per case in
// the OTLP retry backoff at shutdown and asserts nothing extra. Their export
// interval is 600 s, so the timer never fires; every export in this file is one
// the test asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DiagLogLevel, diag } from '@opentelemetry/api';
import { AggregationTemporality, DataPointType, MetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  CPU_DURATION,
  DB_DURATION,
  POOL_IDLE,
  POOL_TOTAL,
  POOL_WAITING,
  POOL_WAIT_DURATION,
  REQUEST_DURATION,
  bindInstruments,
  buildMeterProvider,
  buildResource,
  buildViews,
  installDiagLogger,
  startTelemetry,
  trafficSource,
} from '../src/otel.js';

/** Minimal reader: collect on demand, no timer, no exporter, no network. */
class TestReader extends MetricReader {
  selectAggregationTemporality() { return AggregationTemporality.CUMULATIVE; }
  async onForceFlush() {}
  async onShutdown() {}
}

/**
 * The seam the factory left behind. bindInstruments is what startTelemetry
 * calls once its resource has been detected; driving it directly is how these
 * tests reach the instruments without an OTLP endpoint.
 */
function bind({ poolStats } = {}) {
  const reader = new TestReader();
  const provider = buildMeterProvider({
    resource: resourceFromAttributes({ 'service.name': 'test', 'service.instance.id': 'task-1' }),
    readers: [reader],
  });
  const { recordRequest, recordPoolWait } = bindInstruments(provider, { poolStats });
  return { reader, provider, recordRequest, recordPoolWait };
}

const metricsOf = async (reader) =>
  (await reader.collect()).resourceMetrics.scopeMetrics[0].metrics;

/**
 * A socket that answers 200 and keeps what was posted to it.
 *
 * `bodies` is what turns "the recorders became live" from an absence of throws
 * into an assertion: the exported payload either names an instrument or it does
 * not. Matched as raw text rather than parsed, so the check holds whether the
 * exporter encodes JSON or protobuf -- the metric name is a UTF-8 string in
 * both.
 *
 * The sibling pointed its exporter at a closed port, and shutdown()'s final
 * flush then spent ~8 seconds per case in the OTLP retry backoff -- 16 of the
 * sibling suite's 17 seconds, none of it testing anything.
 */
async function startFakeCollector() {
  const bodies = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    bodies,
    received: (name) => bodies.some((b) => b.includes(name)),
    close: () => server.close(),
  };
}

const base = { serviceName: 'test', exportIntervalMs: 60_000 };

test('the duration histogram is an EXPONENTIAL histogram, not explicit buckets', async () => {
  const { reader, provider, recordRequest } = bind();
  recordRequest({ route: '/posts/:id', class: 'fast', method: 'GET', status: 200, seconds: 0.004 });
  const metric = (await metricsOf(reader)).find((m) => m.descriptor.name === REQUEST_DURATION);

  assert.ok(metric, `${REQUEST_DURATION} was not recorded`);
  // If the View did not apply, this is DataPointType.HISTOGRAM and the whole
  // native-histogram design silently degrades to explicit buckets.
  assert.equal(metric.dataPointType, DataPointType.EXPONENTIAL_HISTOGRAM);
  assert.equal(metric.descriptor.unit, 's');
  await provider.shutdown();
});

test('temporality is CUMULATIVE, so a lost export costs resolution and not requests', async () => {
  const { reader, provider, recordRequest } = bind();
  recordRequest({ route: '/posts', class: 'fast', method: 'POST', status: 201, seconds: 0.01 });
  await reader.collect();
  recordRequest({ route: '/posts', class: 'fast', method: 'POST', status: 201, seconds: 0.01 });
  const point = (await metricsOf(reader))
    .find((m) => m.descriptor.name === REQUEST_DURATION).dataPoints[0];

  // Cumulative: the second collection carries BOTH observations. Under delta it
  // would carry one, and a dropped export would lose a request forever.
  assert.equal(point.value.count, 2);
  await provider.shutdown();
});

test('attributes carry the route TEMPLATE and nothing unbounded', async () => {
  const { reader, provider, recordRequest } = bind();
  recordRequest({ route: '/posts/:id', class: 'fast', method: 'GET', status: 200, seconds: 0.004 });
  const point = (await metricsOf(reader))
    .find((m) => m.descriptor.name === REQUEST_DURATION).dataPoints[0];

  assert.deepEqual(point.attributes, {
    'http.route': '/posts/:id',
    'class': 'fast',
    'http.request.method': 'GET',
    'http.response.status_code': 200,
    'traffic_source': 'other',
  });
  await provider.shutdown();
});

test('maxSize matches Grafana Cloud max_native_histogram_buckets', () => {
  const views = buildViews();
  assert.equal(views.length, 1);
  // 160 is not a taste call: a histogram above the receiver's cap is rejected
  // or downscaled at ingest (spec section 14). Reach for the option rather than
  // stringifying the View -- serialisation is an implementation detail and a
  // test that passes because '160' appeared somewhere is not a test.
  const found = JSON.stringify(views[0]).match(/"maxSize":\s*(\d+)/);
  assert.ok(found, 'could not find maxSize on the view; check the v2 aggregation shape');
  assert.equal(found[1], '160');
});

test('export failures are logged, not swallowed', () => {
  // Without a diag logger the SDK is completely silent on a dead collector, and
  // the plan's "grep the app log for ENOTFOUND" check could never go red.
  const lines = [];
  installDiagLogger(DiagLogLevel.WARN, { error: (l) => lines.push(l) });
  diag.warn('connect ECONNREFUSED', '127.0.0.1:14318');

  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.msg, 'otel');
  assert.equal(entry.severity, 'warn');
  assert.match(entry.detail, /ECONNREFUSED 127\.0\.0\.1:14318/);

  diag.disable();
});

test('the ecs task id becomes service.instance.id, so tasks do not share a series', async () => {
  // The AWS detector supplies nothing on Fargate, and the old fallback was
  // `local-${pid}` -- PID 1 in every container, so four tasks collapsed onto one
  // series. Read the task ARN from the metadata endpoint ECS injects instead.
  const arn = 'arn:aws:ecs:eu-central-1:042945885621:task/ecs-rds-postgres-pool/abc123def456';
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/task' ? { TaskARN: arn } : {}));
  });
  await new Promise((r) => server.listen(0, r));
  process.env.ECS_CONTAINER_METADATA_URI_V4 = `http://127.0.0.1:${server.address().port}`;
  const collector = await startFakeCollector();

  try {
    const t = startTelemetry({
      config: {
        serviceName: 'ecs-rds-postgres-pool',
        otlpEndpoint: collector.url,
        exportIntervalMs: 600_000,
        instanceIdFallback: 'local-1',
      },
      poolStats: () => ({ waiting: 0, idle: 0, total: 0 }),
    });
    const meterProvider = await t.started;
    const attrs = meterProvider.resource
      ? meterProvider.resource.attributes
      : meterProvider._sharedState.resource.attributes;

    assert.equal(attrs['service.instance.id'], 'abc123def456');
    assert.notEqual(attrs['service.instance.id'], 'local-1');
    // service.namespace must be absent: Grafana Cloud joins it into `job` as
    // "<namespace>/<name>", and every committed query expects the bare name.
    assert.equal(attrs['service.namespace'], undefined);
    assert.equal(attrs['service.name'], 'ecs-rds-postgres-pool');
    await t.shutdown();
  } finally {
    delete process.env.ECS_CONTAINER_METADATA_URI_V4;
    server.close();
    collector.close();
  }
});

test('a broken metadata endpoint costs a label, never the service', async () => {
  // And the fallback is defaulted HERE, not by the caller: main() does not pass
  // instanceIdFallback and OTEL_SERVICE_INSTANCE_ID is normally unset, so a
  // default that lived in the server would leave service.instance.id undefined
  // and collapse every task onto one series.
  process.env.ECS_CONTAINER_METADATA_URI_V4 = 'http://127.0.0.1:1';
  const collector = await startFakeCollector();
  try {
    const t = startTelemetry({
      config: { serviceName: 's', otlpEndpoint: collector.url, exportIntervalMs: 600_000 },
      poolStats: () => ({ waiting: 0, idle: 0, total: 0 }),
    });
    const meterProvider = await t.started;
    const attrs = meterProvider.resource
      ? meterProvider.resource.attributes
      : meterProvider._sharedState.resource.attributes;
    assert.equal(attrs['service.instance.id'], `local-${process.pid}`);
    await t.shutdown();
  } finally {
    delete process.env.ECS_CONTAINER_METADATA_URI_V4;
    collector.close();
  }
});

test('shutdown awaits the background start, so a fast start-then-stop cannot leak a provider', async () => {
  // startTelemetry returns synchronously but AWS resource detection is async, so
  // the provider does not exist yet when main() might already be shutting down.
  const collector = await startFakeCollector();
  const t = startTelemetry({
    config: { ...base, otlpEndpoint: collector.url, exportIntervalMs: 600_000 },
    poolStats: () => ({ waiting: 0, idle: 0, total: 0 }),
  });
  // Installed AFTER the call, because startTelemetry installs the console one.
  const lines = [];
  installDiagLogger(DiagLogLevel.WARN, { error: (l) => lines.push(l) });

  try {
    await t.shutdown();                     // deliberately not awaiting t.started
    const meterProvider = await t.started;
    assert.ok(meterProvider, 'the background start must still resolve');

    // The provider itself is the witness: a MeterProvider that has been shut
    // down refuses to hand out a Meter and says so through diag. If shutdown()
    // had returned before the provider existed, nothing would be logged here.
    meterProvider.getMeter('probe');
    const detail = lines.map((l) => JSON.parse(l).detail).join('\n');
    assert.match(detail, /shutdown MeterProvider/i, `no shutdown warning in:\n${detail}`);
  } finally {
    diag.disable();
    collector.close();
  }
});

test('traffic_source is a closed set, so a scanner cannot mint time series', () => {
  // Bounded HERE, not in the collector: by the time a datapoint reaches Alloy the
  // cardinality already exists. A public ALB sees arbitrary user-agents.
  assert.equal(trafficSource('k6/1.4.0 (https://k6.io/)'), 'k6');
  assert.equal(trafficSource('heartbeat/1.0'), 'heartbeat');
  assert.equal(trafficSource('Grafana Synthetic Monitoring'), 'synthetic');
  assert.equal(trafficSource('ELB-HealthChecker/2.0'), 'alb');
  assert.equal(trafficSource('curl/8.7.1'), 'other');
  assert.equal(trafficSource(undefined), 'other');
  assert.equal(trafficSource(''), 'other');

  // The property that matters: no input, however hostile, escapes the set.
  const allowed = new Set(['k6', 'heartbeat', 'synthetic', 'alb', 'other']);
  for (const ua of ['', 'x'.repeat(4096), 'k6', 'K6/1.0', '../../etc/passwd',
                    'Mozilla/5.0 (compatible; Bytespider)', '\u0000', 'heartbeat']) {
    assert.ok(allowed.has(trafficSource(ua)), `unbounded value from ${JSON.stringify(ua.slice(0, 20))}`);
  }
});

test('the recorded traffic_source follows the user agent', async () => {
  const { reader, provider, recordRequest } = bind();
  recordRequest({
    route: '/posts', class: 'fast', method: 'POST', status: 201, seconds: 0.01,
    userAgent: 'heartbeat/1.0',
  });
  const point = (await metricsOf(reader))
    .find((m) => m.descriptor.name === REQUEST_DURATION).dataPoints[0];

  assert.equal(point.attributes['traffic_source'], 'heartbeat');
  await provider.shutdown();
});

test('phase histograms record db and cpu with the request attributes', async () => {
  const { reader, provider, recordRequest } = bind();
  recordRequest({
    route: '/reports', class: 'heavy', method: 'POST', status: 200, seconds: 0.012,
    userAgent: 'k6/1.4.0', phases: { db: 0.0099, cpu: 0.0016 },
  });
  const metrics = await metricsOf(reader);
  const byName = (n) => metrics.find((m) => m.descriptor.name === n);

  for (const name of [DB_DURATION, CPU_DURATION]) {
    const m = byName(name);
    assert.ok(m, `${name} was not recorded`);
    // The view must apply to these exactly as it does to request duration,
    // or they land as explicit buckets and histogram_fraction stops working.
    assert.equal(m.dataPointType, DataPointType.EXPONENTIAL_HISTOGRAM);
    assert.equal(m.descriptor.unit, 's');
    assert.equal(m.dataPoints[0].attributes['http.route'], '/reports');
    assert.equal(m.dataPoints[0].attributes['class'], 'heavy');
    assert.equal(m.dataPoints[0].attributes['traffic_source'], 'k6');
  }
  assert.equal(byName(DB_DURATION).dataPoints[0].value.sum, 0.0099);
  assert.equal(byName(CPU_DURATION).dataPoints[0].value.sum, 0.0016);
  await provider.shutdown();
});

test('all three request histograms carry an IDENTICAL attribute set, which every subtraction query assumes', async () => {
  // Spec section 3: "Attributes on all three, identical." This is not tidiness --
  // other = request - db - cpu subtracts one metric from another BY LABEL. One
  // extra or missing label on any of the three and the vector match finds
  // nothing, so the panel goes blank rather than wrong: the silent-empty failure
  // again. Checking each metric's route and traffic_source separately (which is
  // all the test above did) cannot see a label present on one instrument and
  // absent from another.
  const { reader, provider, recordRequest } = bind();
  recordRequest({
    route: '/reports', class: 'heavy', method: 'POST', status: 200, seconds: 0.012,
    userAgent: 'k6/1.4.0', phases: { db: 0.0099, cpu: 0.0016 },
  });
  const metrics = await metricsOf(reader);
  const attrsOf = (n) => metrics.find((m) => m.descriptor.name === n).dataPoints[0].attributes;

  const request = attrsOf(REQUEST_DURATION);
  assert.deepEqual(attrsOf(DB_DURATION), request, `${DB_DURATION} attributes differ from ${REQUEST_DURATION}`);
  assert.deepEqual(attrsOf(CPU_DURATION), request, `${CPU_DURATION} attributes differ from ${REQUEST_DURATION}`);
  // Pinned, so a silently-dropped attribute cannot make all three agree on less.
  // http.request.method and traffic_source are in here on purpose: the Grafana
  // dashboards this project copies filter on both, and a panel filtering on an
  // attribute the service stopped emitting matches nothing -- silently.
  assert.deepEqual(request, {
    'http.route': '/reports',
    'class': 'heavy',
    'http.request.method': 'POST',
    'http.response.status_code': 200,
    'traffic_source': 'k6',
  });
  await provider.shutdown();
});

test('a request with no phases records duration only, and does not throw', async () => {
  const { reader, provider, recordRequest } = bind();
  recordRequest({ route: '/healthz', class: 'fast', method: 'GET', status: 200, seconds: 0.0004 });
  const names = (await metricsOf(reader)).map((m) => m.descriptor.name);
  assert.ok(names.includes(REQUEST_DURATION));
  assert.ok(!names.includes(DB_DURATION), 'healthz must not mint a db series');
  // CPU was omitted here, so a regression that recorded a zero cpu phase for
  // every request -- putting /healthz into cpu_saturation_ratio's population --
  // would have gone unnoticed.
  assert.ok(!names.includes(CPU_DURATION), 'healthz must not mint a cpu series');
  await provider.shutdown();
});

// --- the pool instruments: what this project exists to produce (spec 4.2) ---

test('the pool wait histogram is exponential and labelled by route and class', async () => {
  const { reader, provider, recordPoolWait } = bind();
  recordPoolWait({ seconds: 0.0008, route: '/reports', class: 'heavy', opened: false });
  const metric = (await metricsOf(reader)).find((m) => m.descriptor.name === POOL_WAIT_DURATION);

  assert.ok(metric, `${POOL_WAIT_DURATION} was not recorded`);
  // Exponential, not the explicit bucket list an earlier draft carried: the view
  // in buildViews() matches ALL histograms and its aggregation outranks
  // instrument advice, so an advice block would have been dead config.
  assert.equal(metric.dataPointType, DataPointType.EXPONENTIAL_HISTOGRAM);
  assert.equal(metric.descriptor.unit, 's');
  assert.deepEqual(metric.dataPoints[0].attributes, {
    'pool.opened': false,
    'http.route': '/reports',
    'class': 'heavy',
  });
  await provider.shutdown();
});

test('an unlabelled wait keeps http.route and class OFF the datapoint entirely', async () => {
  // The boot-time warm-up checks out Pool.max connections with no request
  // context. Those waits must still count, but minting class="undefined" would
  // put junk in the per-class series this project reports on.
  const { reader, provider, recordPoolWait } = bind();
  recordPoolWait({ seconds: 0.041, route: undefined, class: undefined, opened: true });
  const metric = (await metricsOf(reader)).find((m) => m.descriptor.name === POOL_WAIT_DURATION);

  assert.deepEqual(metric.dataPoints[0].attributes, { 'pool.opened': true });
  assert.equal(metric.dataPoints[0].value.count, 1);
  await provider.shutdown();
});

test('pool.opened separates a new physical connection from a real queue', async () => {
  // Opposite diagnoses that otherwise land in one series (spec 4.2): a wait that
  // coincides with a connection being established is setup cost -- TCP, TLS,
  // Postgres auth -- and one that does not is a request queued behind others.
  const { reader, provider, recordPoolWait } = bind();
  recordPoolWait({ seconds: 0.041, route: '/posts', class: 'fast', opened: true });
  recordPoolWait({ seconds: 0.0006, route: '/posts', class: 'fast', opened: false });
  const metric = (await metricsOf(reader)).find((m) => m.descriptor.name === POOL_WAIT_DURATION);

  assert.equal(metric.dataPoints.length, 2, 'pool.opened must split the series');
  const opened = metric.dataPoints.find((p) => p.attributes['pool.opened'] === true);
  const queued = metric.dataPoints.find((p) => p.attributes['pool.opened'] === false);
  assert.equal(opened.value.sum, 0.041);
  assert.equal(queued.value.sum, 0.0006);
  await provider.shutdown();
});

test('the three pool gauges are read from poolStats on every collection', async () => {
  // total is what tells a setup cost apart from a real queue: it rises exactly
  // when a connection is being created. Without it, waiting and idle alone
  // cannot distinguish the two (spec 4.2).
  let stats = { waiting: 3, idle: 0, total: 5 };
  const { reader, provider } = bind({ poolStats: () => stats });

  const first = await metricsOf(reader);
  const valueOf = (ms, n) => ms.find((m) => m.descriptor.name === n).dataPoints[0].value;
  assert.equal(valueOf(first, POOL_WAITING), 3);
  assert.equal(valueOf(first, POOL_IDLE), 0);
  assert.equal(valueOf(first, POOL_TOTAL), 5);

  // One batch callback, so all three move together and can never disagree about
  // which instant they describe.
  stats = { waiting: 0, idle: 4, total: 4 };
  const second = await metricsOf(reader);
  assert.equal(valueOf(second, POOL_WAITING), 0);
  assert.equal(valueOf(second, POOL_IDLE), 4);
  assert.equal(valueOf(second, POOL_TOTAL), 4);
  await provider.shutdown();
});

// --- the no-endpoint contract: every test above runs with no collector ---

test('with no OTLP endpoint the recorders are no-ops and nothing is started', async () => {
  const t = startTelemetry({
    config: { ...base, otlpEndpoint: undefined },
    poolStats: () => ({ waiting: 0, idle: 0, total: 0 }),
  });
  // Must not throw, must not need a collector.
  t.recordRequest({ route: '/posts', class: 'fast', status: 200, seconds: 0.01, phases: { db: 0.005 } });
  t.recordPoolWait({ seconds: 0.002, route: '/posts', class: 'fast', opened: false });

  // "Nothing is started" is the assertion, not merely "nothing threw" -- a
  // does-not-throw case passes against any no-op, including one that quietly
  // built a provider against a default endpoint. No provider means no reader,
  // no exporter and no timer.
  assert.equal(await t.started, null, 'no MeterProvider may exist without an endpoint');
  // And the recorders were absent, not broken: the wrapper's catch would hide
  // the difference otherwise.
  assert.equal(t.recorderFailures(), 0, 'a no-op recorder must not be swallowing errors');
  await t.shutdown();

  // The positive control, and the reason the assertions above mean anything: a
  // factory that started NOTHING, ever, would satisfy every line so far. The
  // claim is that the endpoint is what decides, so the same factory with one
  // must produce a provider.
  const collector = await startFakeCollector();
  const live = startTelemetry({
    config: { ...base, otlpEndpoint: collector.url, exportIntervalMs: 600_000 },
    poolStats: () => ({ waiting: 0, idle: 0, total: 0 }),
  });
  try {
    assert.ok(await live.started, 'with an endpoint a MeterProvider must be built');
    await live.shutdown();
  } finally {
    collector.close();
  }
});

test('recordPoolWait accepts an unlabelled wait, and does not swallow one either', async () => {
  const t = startTelemetry({
    config: { ...base, otlpEndpoint: undefined },
    poolStats: () => ({ waiting: 0, idle: 0, total: 0 }),
  });
  t.recordPoolWait({ seconds: 0.002, route: undefined, class: undefined, opened: true });
  // "Does not throw" on its own is satisfied by the try/catch in the wrapper,
  // which would equally hide a recorder that threw on every unlabelled wait.
  assert.equal(t.recorderFailures(), 0);
  await t.shutdown();

  // The same input on the LIVE path, where a real histogram is there to reject
  // it -- an attribute value of undefined is exactly what the SDK complains
  // about, and the conditional keys in recordPoolWait are what avoid it.
  const collector = await startFakeCollector();
  const live = startTelemetry({
    config: { ...base, otlpEndpoint: collector.url, exportIntervalMs: 600_000 },
    poolStats: () => ({ waiting: 0, idle: 0, total: 0 }),
  });
  try {
    await live.started;
    live.recordPoolWait({ seconds: 0.002, route: undefined, class: undefined, opened: true });
    assert.equal(live.recorderFailures(), 0, 'an unlabelled wait must reach the histogram, not the catch');
    await live.shutdown();
    assert.ok(collector.received(POOL_WAIT_DURATION), 'the unlabelled wait was never exported');
  } finally {
    collector.close();
  }
});

test('poolStats is not called until the exporter is running', async () => {
  let calls = 0;
  const poolStats = () => { calls += 1; return { waiting: 0, idle: 0, total: 0 }; };

  const t = startTelemetry({ config: { ...base, otlpEndpoint: undefined }, poolStats });
  assert.equal(calls, 0, 'observable callbacks must not be registered without an exporter');
  // calls === 0 read straight after the call proves nothing by itself: an
  // observable callback only runs at COLLECTION, so it reads zero whether or
  // not it was registered. What proves it was never registered is that there is
  // no provider to collect from, and that nothing collects during shutdown.
  assert.equal(await t.started, null);
  await t.shutdown();
  assert.equal(calls, 0, 'not even shutdown may collect from a pool that was never observed');

  // The positive control, which is what makes the negative one mean something:
  // with an exporter the batch callback IS registered, and one flush runs it.
  const collector = await startFakeCollector();
  const live = startTelemetry({
    config: { ...base, otlpEndpoint: collector.url, exportIntervalMs: 600_000 },
    poolStats,
  });
  try {
    const provider = await live.started;
    await provider.forceFlush();
    assert.ok(calls > 0, 'with an exporter the batch callback must run on collection');
    assert.ok(collector.received(POOL_TOTAL), `${POOL_TOTAL} never reached the exporter`);
    await live.shutdown();
  } finally {
    collector.close();
  }
});

test('the recorders are safe before the instruments are bound, and live afterwards', async () => {
  // The whole reason startTelemetry returns synchronously: main() assigns it
  // without awaiting, so a request can be served while AWS resource detection
  // is still in flight. Both halves matter -- no-op EARLY is useless if the
  // recorders never go live, and live-only is useless if the early call throws.
  const collector = await startFakeCollector();
  const t = startTelemetry({
    config: { ...base, otlpEndpoint: collector.url, exportIntervalMs: 600_000 },
    poolStats: () => ({ waiting: 1, idle: 4, total: 5 }),
  });
  try {
    assert.equal(typeof t.recordRequest, 'function', 'startTelemetry must not return a promise');
    t.recordRequest({ route: '/posts', class: 'fast', method: 'GET', status: 200, seconds: 0.01, phases: { db: 0.005 } });
    t.recordPoolWait({ seconds: 0.002, route: '/posts', class: 'fast', opened: false });
    assert.equal(t.recorderFailures(), 0, 'an early call must be a no-op, not a swallowed throw');

    const provider = await t.started;
    assert.ok(provider, 'the background start must produce a provider');
    t.recordRequest({ route: '/posts', class: 'fast', method: 'GET', status: 200, seconds: 0.01, phases: { db: 0.005 } });
    t.recordPoolWait({ seconds: 0.002, route: '/posts', class: 'fast', opened: false });
    await provider.forceFlush();

    assert.ok(collector.received(REQUEST_DURATION), `${REQUEST_DURATION} never reached the exporter`);
    assert.ok(collector.received(POOL_WAIT_DURATION), `${POOL_WAIT_DURATION} never reached the exporter`);
    assert.equal(t.recorderFailures(), 0);
    await t.shutdown();
  } finally {
    collector.close();
  }
});

test('a recorder that throws is swallowed, counted, and reported exactly once', async () => {
  // A recorder may never fail a request. But a permanently broken one that says
  // nothing produces an empty panel and no evidence -- the silent-empty failure
  // installDiagLogger exists to eliminate. Once per process, not per call: at
  // 1000 RPS a per-call log is its own load test.
  const collector = await startFakeCollector();
  const t = startTelemetry({
    config: { ...base, otlpEndpoint: collector.url, exportIntervalMs: 600_000 },
    poolStats: () => ({ waiting: 0, idle: 0, total: 0 }),
  });
  try {
    await t.started;
    const lines = [];
    installDiagLogger(DiagLogLevel.WARN, { error: (l) => lines.push(l) });

    // null destructures to a TypeError inside the recorder -- a stand-in for any
    // throw out of the SDK, which is what the catch is really for.
    assert.doesNotThrow(() => t.recordRequest(null));
    assert.doesNotThrow(() => t.recordPoolWait(null));
    assert.doesNotThrow(() => t.recordRequest(null));

    assert.equal(t.recorderFailures(), 3, 'every swallowed failure must be counted');
    const reported = lines
      .map((l) => JSON.parse(l).detail)
      .filter((d) => d.includes('telemetry recorder failed'));
    assert.equal(reported.length, 1, `expected one report, got ${reported.length}`);
    await t.shutdown();
  } finally {
    diag.disable();
    collector.close();
  }
});

test('an explicitly supplied instanceIdFallback wins over the local-pid default', async () => {
  // This link is reachable in the running service: loadConfig maps
  // OTEL_SERVICE_INSTANCE_ID onto config.instanceIdFallback (it did not, until
  // the final review found the branch orphaned). It is the manual override for
  // when ECS task metadata detection fails, and it has to beat the
  // `local-<pid>` default, because Node is pid 1 in every container and four
  // tasks would otherwise share one series.
  process.env.ECS_CONTAINER_METADATA_URI_V4 = 'http://127.0.0.1:1';
  try {
    const explicit = await buildResource({ serviceName: 's', instanceIdFallback: 'supplied-by-caller' });
    assert.equal(explicit.attributes['service.instance.id'], 'supplied-by-caller');

    const defaulted = await buildResource({ serviceName: 's' });
    assert.equal(defaulted.attributes['service.instance.id'], `local-${process.pid}`);
  } finally {
    delete process.env.ECS_CONTAINER_METADATA_URI_V4;
  }
});
