import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgresql://u:p@h:5432/d' };

test('defaults match the environment-variable contract', () => {
  const c = loadConfig(base);
  assert.equal(c.port, 8080);
  assert.equal(c.poolMax, 5);
  assert.equal(c.poolConnectionTimeoutMs, 900);
  assert.equal(c.dbSsl, 'require');
  assert.equal(c.feedPageSize, 20);
  assert.equal(c.reportScanRows, 0);
  assert.equal(c.seedRows, 50_000);
  assert.equal(c.seedFeeds, 16);
  assert.equal(c.migrateOnBoot, false);
  assert.equal(c.seedOnBoot, false);
  assert.equal(c.serviceName, 'ecs-rds-postgres-pool');
});

test('DATABASE_URL is required', () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
});

test('absent OTLP_ENDPOINT and METRICS_NAMESPACE read as undefined, not empty string', () => {
  const c = loadConfig({ ...base, OTLP_ENDPOINT: '', METRICS_NAMESPACE: '' });
  assert.equal(c.otlpEndpoint, undefined);
  assert.equal(c.metricsNamespace, undefined);
});

test('a negative number is rejected by name', () => {
  assert.throws(() => loadConfig({ ...base, POOL_MAX: '-1' }), /POOL_MAX/);
});

test('DB_SSL accepts only require or off', () => {
  assert.equal(loadConfig({ ...base, DB_SSL: 'off' }).dbSsl, 'off');
  assert.throws(() => loadConfig({ ...base, DB_SSL: 'maybe' }), /DB_SSL/);
});

test('OTEL_SERVICE_INSTANCE_ID reaches the config as instanceIdFallback', () => {
  // src/otel.js has always read config.instanceIdFallback, but loadConfig never
  // produced it, so the branch was unreachable in the running service and the
  // test that covered it proved nothing about production. It is wired rather
  // than deleted because the last-resort default is `local-<pid>` and Node is
  // pid 1 in every container: without an override, four tasks whose metadata
  // detection failed would share one service.instance.id.
  assert.equal(loadConfig(base).instanceIdFallback, undefined,
    'normally unset -- ECS task metadata detection supplies the id');
  assert.equal(loadConfig({ ...base, OTEL_SERVICE_INSTANCE_ID: '' }).instanceIdFallback, undefined,
    'empty reads as absent, not as an empty instance id');
  assert.equal(loadConfig({ ...base, OTEL_SERVICE_INSTANCE_ID: 'task-7' }).instanceIdFallback, 'task-7');
});

test('region defaults to eu-central-1 and AWS_REGION overrides it', () => {
  assert.equal(loadConfig(base).region, 'eu-central-1');
  assert.equal(loadConfig({ ...base, AWS_REGION: 'us-east-1' }).region, 'us-east-1');
});
