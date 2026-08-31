// src/otel.js
// All OpenTelemetry wiring lives here so server.js keeps one responsibility and
// so the exporter can be swapped per platform (ECS timer vs Lambda flush-on-end)
// without touching request handling. The SLI contract is the histogram; the
// transport is an implementation detail.
import {
  AggregationTemporality,
  AggregationType,
  InstrumentType,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { DiagLogLevel, diag } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { detectResources, resourceFromAttributes } from '@opentelemetry/resources';
import { awsEcsDetector } from '@opentelemetry/resource-detector-aws';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';

/** OpenTelemetry semantic convention name and unit. Do not localise either. */
export const REQUEST_DURATION = 'http.server.request.duration';
const METER_NAME = 'ecs-dynamodb-rps-ceiling';

/**
 * Exponential buckets, not explicit ones. This is what lets Grafana apply the
 * class thresholds at QUERY time via histogram_fraction -- change a threshold
 * and nothing is rebuilt or redeployed. maxSize is 160 to match Grafana Cloud's
 * max_native_histogram_buckets exactly; above the cap, ingest downscales.
 *
 * sdk-metrics v2 dropped the `View` CLASS from the public surface entirely --
 * `MeterProviderOptions.views` is typed `ViewOptions[]`, i.e. plain objects. So
 * this returns option objects, not `new View(...)`: the class is unimportable
 * (`Named export 'View' not found`) and constructing one would also convert
 * `aggregation` into an internal Aggregation instance that no longer carries a
 * readable `maxSize`.
 */
export function buildViews() {
  return [{
    instrumentType: InstrumentType.HISTOGRAM,
    aggregation: { type: AggregationType.EXPONENTIAL_HISTOGRAM, options: { maxSize: 160, recordMinMax: true } },
  }];
}

export function buildMeterProvider({ resource, readers }) {
  return new MeterProvider({ resource, readers, views: buildViews() });
}

let histogram = null;

export function bindHistogram(meterProvider) {
  histogram = meterProvider.getMeter(METER_NAME).createHistogram(REQUEST_DURATION, {
    unit: 's',
    description: 'Duration of inbound HTTP requests, callback start to response finish.',
  });
}

/**
 * Where a request came from, as a CLOSED set of five values.
 *
 * The bounding has to happen here, before the value ever reaches the histogram.
 * The obvious alternative -- record `user_agent.original` verbatim and let the
 * collector map it -- puts an unbounded attribute on a public-internet ALB: one
 * time series per scanner user-agent, against a 10,000 active-series ceiling.
 * The collector cannot save us, because the cardinality already exists by the
 * time it sees the datapoint.
 *
 * This is provenance, not SLO logic: no threshold, no ratio, no verdict (S3).
 * It is what spec section 17.1 -- whether load-generator traffic belongs in the
 * SLO population -- has to be decided on, and that decision cannot be made
 * retroactively, so the label must be right BEFORE the first load test.
 */
export function trafficSource(userAgent) {
  const ua = userAgent ?? '';
  if (ua.startsWith('k6/')) return 'k6';
  if (ua.startsWith('heartbeat/')) return 'heartbeat';
  if (ua.includes('Synthetic')) return 'synthetic';
  if (ua.startsWith('ELB-HealthChecker/')) return 'alb';
  return 'other';
}

/**
 * The ONLY thing the service records. No threshold comparison, no verdict, no
 * ratio -- the objective is applied in Grafana (spec S3). A no-op until
 * bindHistogram runs, so unit tests need no OpenTelemetry setup at all.
 */
export function recordRequest({ route, method, status, durationSeconds, userAgent }) {
  if (!histogram) return;
  histogram.record(durationSeconds, {
    'http.route': route,
    'http.request.method': method,
    'http.response.status_code': status,
    'traffic_source': trafficSource(userAgent),
  });
}

/**
 * OpenTelemetry swallows export failures by default: nothing in this stack reads
 * OTEL_LOG_LEVEL (that belongs to NodeSDK, which we deliberately do not use), so
 * without a diag logger a dead collector produces ZERO output. The first symptom
 * would be an empty Grafana panel, which looks exactly like no traffic.
 *
 * That also makes a check impossible to fail: the plan verifies the app can
 * reach the collector by grepping this service's logs for ENOTFOUND/ECONNREFUSED,
 * and a silent SDK makes that grep come back clean whether or not the collector
 * exists. Emitting JSON keeps it greppable and matches the one line the server
 * already logs at boot.
 *
 * WARN, not DEBUG: at 1000 RPS an info-level SDK is its own load test.
 */
export function installDiagLogger(level = DiagLogLevel.WARN, sink = console) {
  const emit = (severity) => (message, ...args) =>
    sink.error(JSON.stringify({ msg: 'otel', severity, detail: `${message} ${args.join(' ')}`.trim() }));
  diag.setLogger({
    verbose: emit('verbose'), debug: emit('debug'), info: emit('info'),
    warn: emit('warn'), error: emit('error'),
  }, level);
}

/**
 * The ECS task id, for service.instance.id.
 *
 * @opentelemetry/resource-detector-aws supplies nothing here -- verified empty
 * both locally AND on Fargate -- so the fallback was `local-${process.pid}`, and
 * the app is PID 1 in every container. Four tasks all reported instance="local-1"
 * and collapsed onto ONE series, which silently corrupts the ratio the moment
 * autoscaling engages.
 *
 * Reads the task ARN from the metadata endpoint ECS injects into every task and
 * takes its last segment. Never throws and never hangs: a failure here must cost
 * label resolution, not the service.
 */
async function ecsTaskInstanceId() {
  const base = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!base) return undefined;
  try {
    const res = await fetch(`${base}/task`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return undefined;
    const arn = (await res.json())?.TaskARN;
    return typeof arn === 'string' ? arn.split('/').pop() : undefined;
  } catch {
    return undefined;
  }
}

export async function startOtel(config) {
  // Before anything can fail. See installDiagLogger: without this, it fails silently.
  installDiagLogger();

  // service.instance.id is what keeps four tasks from colliding on one series:
  // Prometheus's OTLP translation maps it to `instance`. Detected once at boot
  // from the ECS task metadata endpoint -- never per request.
  const detected = detectResources({ detectors: [awsEcsDetector] });
  if (typeof detected.waitForAsyncAttributes === 'function') await detected.waitForAsyncAttributes();

  const resource = detected.merge(resourceFromAttributes({
    // NO service.namespace. Grafana Cloud's OTLP translation joins namespace and
    // name into `job` as "<namespace>/<name>", so setting both to the same string
    // produced job="ecs-dynamodb-rps-ceiling/ecs-dynamodb-rps-ceiling" and every
    // query written against job="ecs-dynamodb-rps-ceiling" matched nothing --
    // silently, which is the failure mode this whole design exists to remove.
    'service.name': config.serviceName,
    'service.instance.id': detected.attributes['service.instance.id']
      ?? await ecsTaskInstanceId()
      ?? config.instanceIdFallback,
  }));

  const reader = new PeriodicExportingMetricReader({
    exportIntervalMillis: config.exportIntervalMs,
    exporter: new OTLPMetricExporter({
      url: `${config.otlpEndpoint}/v1/metrics`,
      // Explicit, never defaulted (spec S6): if the collector is down or the
      // event loop is blocked past the knee, the next successful export carries
      // full cumulative state. Delta would lose those requests permanently.
      temporalityPreference: AggregationTemporality.CUMULATIVE,
    }),
  });

  const meterProvider = buildMeterProvider({ resource, readers: [reader] });
  bindHistogram(meterProvider);

  // Two instrumentations, both metrics-only -- no tracer provider is registered,
  // so span creation is a no-op tracer.
  //
  // AwsInstrumentation gives DynamoDB call counts, errors and SDK RETRIES, which
  // is how throttling presents before it becomes errors. It does NOT fix
  // attribution: like the Server-Timing `db` phase it wraps an await, so it
  // absorbs event-loop queueing the same way and inflates under load. CloudWatch
  // SuccessfulRequestLatency stays the DB-bound discriminator (spec section 11).
  //
  // RuntimeNodeInstrumentation emits nodejs.eventloop.delay, superseding the
  // /stats poll -- which stays anyway, because the k6 scripts are frozen.
  //
  // NOT registered: @opentelemetry/auto-instrumentations-node. It pulls in
  // instrumentation for libraries this service does not use and adds context
  // propagation the metrics path does not need, against a 250us/request budget.
  registerInstrumentations({
    meterProvider,
    instrumentations: [new AwsInstrumentation(), new RuntimeNodeInstrumentation()],
  });

  return { meterProvider, shutdown: () => meterProvider.shutdown() };
}
