function num(env, key, dflt) {
  const raw = env[key];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number, got ${JSON.stringify(raw)}`);
  return n;
}

/** Absent => undefined (feature off). Present => a fraction in (0, 1]. */
function fraction(env, key) {
  const raw = env[key];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) throw new Error(`${key} must be a number in (0, 1], got ${JSON.stringify(raw)}`);
  return n;
}

export function loadConfig(env = process.env) {
  return {
    port: num(env, 'PORT', 8080),
    tableName: env.TABLE_NAME ?? 'items',
    region: env.AWS_REGION ?? 'eu-central-1',
    pbkdf2Iterations: num(env, 'PBKDF2_ITERATIONS', 0),
    feedPageSize: num(env, 'FEED_PAGE_SIZE', 20),
    itemTtlSeconds: num(env, 'ITEM_TTL_SECONDS', 3600),
    dynamoEndpoint: env.DYNAMO_ENDPOINT || undefined,
    serviceName: env.OTEL_SERVICE_NAME ?? 'ecs-dynamodb-rps',
    // Absent => no exporter is started and recordRequest stays a no-op. That is
    // what lets every unit and integration test run with no collector present.
    otlpEndpoint: env.OTLP_ENDPOINT || undefined,
    exportIntervalMs: num(env, 'OTEL_EXPORT_INTERVAL_MS', 15_000),
    // Same pattern as otlpEndpoint: absent => no CloudWatch publisher and no AWS
    // client is created, so tests need no AWS. The metric's ServiceName dimension
    // is serviceName above; the alarm in infra/main/autoscaling.tf must match both.
    metricsNamespace: env.METRICS_NAMESPACE || undefined,
    // 10s, not 1s: 1s publishing is ~$16/month in PutMetricData requests and the
    // 20s alarm period only needs two datapoints per period (spec §5).
    metricsIntervalMs: num(env, 'METRICS_INTERVAL_MS', 10_000),
    // Admission control (spike-response spec §6). Absent => no gate, no sampler
    // and no timer, like the two exporters above. ELU is a fraction, so 0 would
    // shed everything and >1 would shed nothing while looking enabled. The value
    // comes from var.shed_elu_threshold in infra/main, which must stay strictly
    // above the ELU scale-out thresholds (spec §6.1, test/admission.test.js).
    shedEluThreshold: fraction(env, 'SHED_ELU_THRESHOLD'),
  };
}
