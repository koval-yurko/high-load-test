// test/config.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('applies defaults when env is empty', () => {
  const c = loadConfig({});
  assert.equal(c.port, 8080);
  assert.equal(c.tableName, 'items');
  assert.equal(c.pbkdf2Iterations, 0);
  assert.equal(c.feedPageSize, 20);
  assert.equal(c.itemTtlSeconds, 3600);
  assert.equal(c.dynamoEndpoint, undefined);
  assert.equal(c.region, 'eu-central-1');
});

test('reads values from env', () => {
  const c = loadConfig({ PORT: '3000', TABLE_NAME: 't', PBKDF2_ITERATIONS: '1200' });
  assert.equal(c.port, 3000);
  assert.equal(c.tableName, 't');
  assert.equal(c.pbkdf2Iterations, 1200);
});

test('AWS_REGION overrides the default region', () => {
  const c = loadConfig({ AWS_REGION: 'us-east-1' });
  assert.equal(c.region, 'us-east-1');
});

test('rejects a non-numeric numeric field', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
});

test('rejects a negative iteration count', () => {
  assert.throws(() => loadConfig({ PBKDF2_ITERATIONS: '-1' }), /PBKDF2_ITERATIONS/);
});

test('otel config has safe defaults and is disabled without an endpoint', () => {
  const off = loadConfig({});
  assert.equal(off.otlpEndpoint, undefined);
  assert.equal(off.exportIntervalMs, 15000);
  assert.equal(off.serviceName, 'ecs-dynamodb-rps');

  const on = loadConfig({ OTLP_ENDPOINT: 'http://collector.local:4318', OTEL_EXPORT_INTERVAL_MS: '5000' });
  assert.equal(on.otlpEndpoint, 'http://collector.local:4318');
  assert.equal(on.exportIntervalMs, 5000);
});

test('cloudwatch metrics publisher is disabled without a namespace', () => {
  const off = loadConfig({});
  assert.equal(off.metricsNamespace, undefined);
  assert.equal(off.metricsIntervalMs, 10000);

  const on = loadConfig({ METRICS_NAMESPACE: 'ecs-dynamodb-rps', METRICS_INTERVAL_MS: '5000' });
  assert.equal(on.metricsNamespace, 'ecs-dynamodb-rps');
  assert.equal(on.metricsIntervalMs, 5000);
});

test('an empty namespace counts as absent', () => {
  assert.equal(loadConfig({ METRICS_NAMESPACE: '' }).metricsNamespace, undefined);
});

test('rejects a non-numeric metrics interval', () => {
  assert.throws(() => loadConfig({ METRICS_INTERVAL_MS: 'soon' }), /METRICS_INTERVAL_MS/);
});
