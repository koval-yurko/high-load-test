// src/config.js
// Forked from ecs-dynamodb-rps/service/src/config.js on 2026-09-20.
// A bug fixed here does not reach the sibling copy; fix both.

function num(env, key, dflt) {
  const raw = env[key];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number, got ${JSON.stringify(raw)}`);
  return n;
}

const flag = (env, key) => env[key] === '1';

export function loadConfig(env = process.env) {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const dbSsl = env.DB_SSL ?? 'require';
  if (dbSsl !== 'require' && dbSsl !== 'off') {
    throw new Error(`DB_SSL must be "require" or "off", got ${JSON.stringify(dbSsl)}`);
  }

  return {
    port: num(env, 'PORT', 8080),
    databaseUrl,
    // Knob 1. Terraform supplies it; the default is the binding-constraint value.
    poolMax: num(env, 'POOL_MAX', 5),
    // Just above the heavy class, so a saturated pool produces 5xx the
    // availability objective catches rather than an unbounded queue that shows
    // only as latency. Raised in plan 3 if the heavy threshold lands higher.
    poolConnectionTimeoutMs: num(env, 'POOL_CONNECTION_TIMEOUT_MS', 900),
    dbSsl,
    migrateOnBoot: flag(env, 'MIGRATE_ON_BOOT'),
    seedOnBoot: flag(env, 'SEED_ON_BOOT'),
    seedRows: num(env, 'SEED_ROWS', 50_000),
    seedFeeds: num(env, 'SEED_FEEDS', 16),
    feedPageSize: num(env, 'FEED_PAGE_SIZE', 20),
    // The calibrated cost knob. 0 => the aggregate returns immediately, so an
    // uncalibrated service never silently runs a workload nobody chose.
    reportScanRows: num(env, 'REPORT_SCAN_ROWS', 0),
    serviceName: env.OTEL_SERVICE_NAME ?? 'ecs-rds-postgres-pool',
    // The manual override for service.instance.id, used only when ECS task
    // metadata detection fails. It has to exist: the last-resort default in
    // buildResource is `local-<pid>`, and Node is pid 1 in every container, so
    // four tasks that all failed detection would collapse onto ONE series --
    // the exact failure service.instance.id is there to prevent. Normally
    // unset; detection supplies the task id.
    instanceIdFallback: env.OTEL_SERVICE_INSTANCE_ID || undefined,
    // Absent => no exporter is started and the recorders stay no-ops. That is
    // what lets every test run with no collector present.
    otlpEndpoint: env.OTLP_ENDPOINT || undefined,
    exportIntervalMs: num(env, 'OTEL_EXPORT_INTERVAL_MS', 15_000),
    // Same pattern: absent => no CloudWatch publisher and no AWS client.
    metricsNamespace: env.METRICS_NAMESPACE || undefined,
    metricsIntervalMs: num(env, 'METRICS_INTERVAL_MS', 10_000),
    region: env.AWS_REGION ?? 'eu-central-1',
  };
}
