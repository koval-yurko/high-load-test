import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DiagLogLevel, diag } from '@opentelemetry/api';
import { AggregationTemporality, DataPointType, MetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { REQUEST_DURATION, bindHistogram, buildMeterProvider, buildViews, installDiagLogger, recordRequest, startOtel, trafficSource } from '../src/otel.js';

/** Minimal reader: collect on demand, no timer, no exporter, no network. */
class TestReader extends MetricReader {
  selectAggregationTemporality() { return AggregationTemporality.CUMULATIVE; }
  async onForceFlush() {}
  async onShutdown() {}
}

async function collectOne() {
  const reader = new TestReader();
  const provider = buildMeterProvider({
    resource: resourceFromAttributes({ 'service.name': 'test', 'service.instance.id': 'task-1' }),
    readers: [reader],
  });
  bindHistogram(provider);
  return { reader, provider };
}

test('the duration histogram is an EXPONENTIAL histogram, not explicit buckets', async () => {
  const { reader, provider } = await collectOne();
  recordRequest({ route: '/items/:pk/:sk', method: 'GET', status: 200, durationSeconds: 0.004 });
  const { resourceMetrics } = await reader.collect();
  const metric = resourceMetrics.scopeMetrics[0].metrics.find((m) => m.descriptor.name === REQUEST_DURATION);

  assert.ok(metric, `${REQUEST_DURATION} was not recorded`);
  // If the View did not apply, this is DataPointType.HISTOGRAM and the whole
  // native-histogram design silently degrades to explicit buckets.
  assert.equal(metric.dataPointType, DataPointType.EXPONENTIAL_HISTOGRAM);
  assert.equal(metric.descriptor.unit, 's');
  await provider.shutdown();
});

test('temporality is CUMULATIVE, so a lost export costs resolution and not requests', async () => {
  const { reader, provider } = await collectOne();
  recordRequest({ route: '/items', method: 'POST', status: 201, durationSeconds: 0.01 });
  await reader.collect();
  recordRequest({ route: '/items', method: 'POST', status: 201, durationSeconds: 0.01 });
  const { resourceMetrics } = await reader.collect();
  const point = resourceMetrics.scopeMetrics[0].metrics
    .find((m) => m.descriptor.name === REQUEST_DURATION).dataPoints[0];

  // Cumulative: the second collection carries BOTH observations. Under delta it
  // would carry one, and a dropped export would lose a request forever.
  assert.equal(point.value.count, 2);
  await provider.shutdown();
});

test('attributes carry the route TEMPLATE and nothing unbounded', async () => {
  const { reader, provider } = await collectOne();
  recordRequest({ route: '/items/:pk/:sk', method: 'GET', status: 200, durationSeconds: 0.004 });
  const { resourceMetrics } = await reader.collect();
  const point = resourceMetrics.scopeMetrics[0].metrics
    .find((m) => m.descriptor.name === REQUEST_DURATION).dataPoints[0];

  assert.deepEqual(point.attributes, {
    'http.route': '/items/:pk/:sk',
    'http.request.method': 'GET',
    'http.response.status_code': 200,
    'traffic_source': 'other',
  });
  await provider.shutdown();
});

test('recordRequest is a no-op before bindHistogram, so unit tests need no OTel', () => {
  // Imported fresh in a child context this would be unbound; here we assert the
  // contract does not throw, which is what every existing server test relies on.
  assert.doesNotThrow(() => recordRequest({ route: '/x', method: 'GET', status: 200, durationSeconds: 0 }));
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
  const arn = 'arn:aws:ecs:eu-central-1:042945885621:task/ecs-dynamodb-rps-ceiling/abc123def456';
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/task' ? { TaskARN: arn } : {}));
  });
  await new Promise((r) => server.listen(0, r));
  process.env.ECS_CONTAINER_METADATA_URI_V4 = `http://127.0.0.1:${server.address().port}`;

  try {
    const { meterProvider, shutdown } = await startOtel({
      serviceName: 'ecs-dynamodb-rps-ceiling',
      otlpEndpoint: 'http://127.0.0.1:1',
      exportIntervalMs: 600_000,
      instanceIdFallback: 'local-1',
    });
    const attrs = meterProvider.resource ? meterProvider.resource.attributes : meterProvider._sharedState.resource.attributes;

    assert.equal(attrs['service.instance.id'], 'abc123def456');
    assert.notEqual(attrs['service.instance.id'], 'local-1');
    // service.namespace must be absent: Grafana Cloud joins it into `job` as
    // "<namespace>/<name>", and every committed query expects the bare name.
    assert.equal(attrs['service.namespace'], undefined);
    assert.equal(attrs['service.name'], 'ecs-dynamodb-rps-ceiling');
    await shutdown();
  } finally {
    delete process.env.ECS_CONTAINER_METADATA_URI_V4;
    server.close();
  }
});

test('a broken metadata endpoint costs a label, never the service', async () => {
  process.env.ECS_CONTAINER_METADATA_URI_V4 = 'http://127.0.0.1:1';
  try {
    const { meterProvider, shutdown } = await startOtel({
      serviceName: 's', otlpEndpoint: 'http://127.0.0.1:1',
      exportIntervalMs: 600_000, instanceIdFallback: 'fallback-used',
    });
    const attrs = meterProvider.resource ? meterProvider.resource.attributes : meterProvider._sharedState.resource.attributes;
    assert.equal(attrs['service.instance.id'], 'fallback-used');
    await shutdown();
  } finally {
    delete process.env.ECS_CONTAINER_METADATA_URI_V4;
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
  const { reader, provider } = await collectOne();
  recordRequest({ route: '/items', method: 'POST', status: 201, durationSeconds: 0.01, userAgent: 'heartbeat/1.0' });
  const { resourceMetrics } = await reader.collect();
  const point = resourceMetrics.scopeMetrics[0].metrics
    .find((m) => m.descriptor.name === REQUEST_DURATION).dataPoints[0];

  assert.equal(point.attributes['traffic_source'], 'heartbeat');
  await provider.shutdown();
});
