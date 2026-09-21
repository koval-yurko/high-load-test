// src/otel.js
// Forked from ecs-dynamodb-rps/service/src/otel.js on 2026-09-20, restructured
// into the startTelemetry factory, plus the pool instruments added below.
// A bug fixed here does not reach the sibling copy; fix both.
//
// All OpenTelemetry wiring lives here so server.js keeps one responsibility and
// so the exporter can be swapped per platform (ECS timer vs Lambda flush-on-end)
// without touching request handling. The SLI contract is the histogram; the
// transport is an implementation detail.
//
// WHY A FACTORY, where the sibling had module-level state. The sibling kept its
// three histograms in module-level `let`s that `bindHistogram` assigned, and a
// module-level `recordRequest` that was a no-op until it ran. That shape has one
// set of instruments per PROCESS: a second startOtel silently rebinds the first
// one's recorder. Here the instruments are closures created by bindInstruments
// and handed back, so two telemetry objects cannot reach into each other -- and
// the "no-op until bound" property, which is what lets every other test in this
// service run with no collector, is kept deliberately (see startTelemetry).
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
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';

/** OpenTelemetry semantic convention name and unit. Do not localise either. */
export const REQUEST_DURATION = 'http.server.request.duration';
export const DB_DURATION = 'http.server.db.duration';
export const CPU_DURATION = 'http.server.cpu.duration';

/** The pool instruments. THE metric this project exists to produce (spec 4.2). */
export const POOL_WAIT_DURATION = 'db.pool.wait.duration';
export const POOL_WAITING = 'db.pool.waiting';
export const POOL_IDLE = 'db.pool.idle';
export const POOL_TOTAL = 'db.pool.total';

const METER_NAME = 'ecs-rds-postgres-pool';

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
 *
 * NOTE the instrumentType filter: HISTOGRAM, which is EVERY histogram this
 * service creates, the pool wait one included. See its comment in
 * bindInstruments for why that rules out per-instrument bucket advice.
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
 * This is provenance, not SLO logic: no threshold, no ratio, no verdict. It is
 * what decides whether load-generator traffic belongs in the SLO population,
 * and that decision cannot be made retroactively, so the label must be right
 * BEFORE the first load test.
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
 * Creates every instrument on `meterProvider` and returns the two recorders
 * that write to them. This is the seam the sibling's `bindHistogram` occupied,
 * with the module-level `let`s replaced by closures: nothing here outlives the
 * returned object.
 *
 * `poolStats` is optional only so a test can bind the histograms without one.
 * startTelemetry always passes it.
 */
export function bindInstruments(meterProvider, { poolStats } = {}) {
  const meter = meterProvider.getMeter(METER_NAME);

  const histogram = meter.createHistogram(REQUEST_DURATION, {
    unit: 's',
    description: 'Duration of inbound HTTP requests, callback start to response finish.',
  });
  const dbHistogram = meter.createHistogram(DB_DURATION, {
    unit: 's',
    description:
      'Wall-clock inside the SQL statement, summed per request. INCLUDES event-loop queueing '
      + 'by construction -- it brackets an await, so its clock runs while the resolved promise '
      + 'waits behind other work. Not a PostgreSQL latency, and not a pool wait either: '
      + 'compare it against db.pool.wait.duration and against Performance Insights to see '
      + 'which of the three queues in series moved.',
  });
  const cpuHistogram = meter.createHistogram(CPU_DURATION, {
    unit: 's',
    description:
      'Wall-clock in synchronous CPU work, summed per request. Uncontaminated -- it brackets '
      + 'no await. rate(_sum) is CPU-seconds per wall-second; against the task vCPU allocation '
      + 'that ratio is saturation.',
  });

  // Pool wait, per class. THE metric this project exists to produce (spec 4.2).
  //
  // NO `advice: { explicitBucketBoundaries: [...] }`. It would be dead config:
  // buildViews() installs a view matching ALL histograms and forcing an
  // exponential aggregation, and a view's aggregation outranks instrument
  // advice, so the list would sit in this file looking live and changing
  // nothing. The exponential histogram also serves the intent better -- a
  // healthy checkout from a warm pool is sub-millisecond and the interesting
  // range is the two decades above it, which it resolves automatically -- and
  // it keeps the reason the request histograms are exponential: thresholds are
  // applied at QUERY time, so changing one rebuilds and redeploys nothing.
  // Do not re-add the advice block.
  const poolWait = meter.createHistogram(POOL_WAIT_DURATION, {
    unit: 's',
    description: 'Time a request waited to check a connection out of the pool.',
  });

  // Three gauges, read from the pool on each export tick. `total` is what tells
  // a setup cost apart from a real queue: it rises exactly when a connection is
  // being created -- TCP, TLS, Postgres auth -- which otherwise lands in the
  // same number as "queued behind four other requests" (spec 4.2).
  //
  // ONE batch callback for all three, so they can never disagree about which
  // instant they describe. Registered only when a poolStats is supplied, which
  // is also what keeps it unregistered when there is no exporter: startTelemetry
  // does not reach this function at all in that case.
  if (typeof poolStats === 'function') {
    const waiting = meter.createObservableGauge(POOL_WAITING, {
      description: 'Requests currently queued for a connection.',
    });
    const idle = meter.createObservableGauge(POOL_IDLE, {
      description: 'Connections currently idle in the pool.',
    });
    const total = meter.createObservableGauge(POOL_TOTAL, {
      description: 'Connections the pool currently holds.',
    });
    meter.addBatchObservableCallback((observer) => {
      const s = poolStats();
      observer.observe(waiting, s.waiting);
      observer.observe(idle, s.idle);
      observer.observe(total, s.total);
    }, [waiting, idle, total]);
  }

  return {
    /**
     * The ONLY thing the service records about a request. No threshold
     * comparison, no verdict, no ratio -- the objective is applied in Grafana.
     */
    recordRequest({ route, class: cls, method, status, seconds, userAgent, phases }) {
      // One attribute object, shared by all three instruments. Identical labels
      // are what let a query subtract one from another without a join that
      // silently drops series. http.request.method and traffic_source stay even
      // though nothing in this project's own SLI reads them: the Grafana
      // dashboards forked from the sibling filter on both, and a panel
      // filtering on an attribute the service stopped emitting matches nothing.
      const attrs = {
        'http.route': route,
        'class': cls,
        'http.request.method': method,
        'http.response.status_code': status,
        'traffic_source': trafficSource(userAgent),
      };
      histogram.record(seconds, attrs);
      // Absent, not zero. /healthz does no measured work and must not mint a
      // series a later query would read as "the database answered instantly".
      if (phases?.db !== undefined) dbHistogram.record(phases.db, attrs);
      if (phases?.cpu !== undefined) cpuHistogram.record(phases.cpu, attrs);
    },

    recordPoolWait({ seconds, route, class: cls, opened }) {
      const attrs = { 'pool.opened': Boolean(opened) };
      // Unlabelled waits still count -- a checkout from the boot-time pre-warm
      // has no request context. Omitting the keys keeps them out of the
      // per-class series rather than minting an "undefined" class.
      if (route) attrs['http.route'] = route;
      if (cls) attrs['class'] = cls;
      poolWait.record(seconds, attrs);
    },
  };
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

/**
 * The resource every datapoint is stamped with. Async, because AWS detection is.
 *
 * `instanceIdFallback` is defaulted HERE rather than at the call site: an
 * undefined service.instance.id collapses every task onto one series -- exactly
 * the failure ecsTaskInstanceId exists to prevent. It comes from
 * OTEL_SERVICE_INSTANCE_ID via loadConfig and is normally unset; the
 * `local-<pid>` default below is a last resort, and a poor one, because Node is
 * pid 1 in every container.
 */
export async function buildResource(config) {
  // service.instance.id is what keeps four tasks from colliding on one series:
  // Prometheus's OTLP translation maps it to `instance`. Detected once at boot
  // from the ECS task metadata endpoint -- never per request.
  const detected = detectResources({ detectors: [awsEcsDetector] });
  if (typeof detected.waitForAsyncAttributes === 'function') await detected.waitForAsyncAttributes();

  return detected.merge(resourceFromAttributes({
    // NO service.namespace. Grafana Cloud's OTLP translation joins namespace and
    // name into `job` as "<namespace>/<name>", so setting both to the same string
    // produced job="<name>/<name>" and every query written against job="<name>"
    // matched nothing -- silently, which is the failure mode this whole design
    // exists to remove.
    'service.name': config.serviceName,
    'service.instance.id': detected.attributes['service.instance.id']
      ?? await ecsTaskInstanceId()
      ?? config.instanceIdFallback
      ?? `local-${process.pid}`,
  }));
}

const noop = () => {};

/**
 * Starts telemetry and returns the recorders SYNCHRONOUSLY.
 *
 * Not async, although everything inside it is: main() assigns the result without
 * awaiting, and a request could be served before AWS resource detection has
 * finished. Returning a promise would make every call site await a thing that
 * must never be able to delay a request. Instead the object exists immediately
 * and its recorders are no-ops until the instruments are bound -- the sibling's
 * "no-op before bindHistogram" property, kept rather than reinvented.
 *
 * With no `config.otlpEndpoint` nothing is started at all: no exporter, no
 * provider, no observable callback, and so `poolStats` is never called. That is
 * what lets every test in this service run with no collector, no AWS credentials
 * and no PostgreSQL.
 *
 * `shutdown()` awaits the background start before shutting the provider down, so
 * a fast start-then-stop cannot leak a provider or reject. `started` is exposed
 * for that reason and for the tests; main() does not need it.
 */
export function startTelemetry({ config, poolStats }) {
  if (!config?.otlpEndpoint) {
    return {
      recordRequest: noop,
      recordPoolWait: noop,
      recorderFailures: () => 0,
      started: Promise.resolve(null),
      shutdown: async () => {},
    };
  }

  // Before anything can fail. See installDiagLogger: without this, it fails silently.
  installDiagLogger();

  let recorders = null;
  // Held OUTSIDE the IIFE on purpose. If the provider is built and a later step
  // -- registerInstrumentations -- throws, the catch below resolves `started` to
  // null, and a shutdown() that closed only the resolved value would leave a
  // PeriodicExportingMetricReader attached to a live provider, exporting for the
  // rest of the process. shutdown() closes what was CREATED, not what was
  // returned.
  let provider = null;

  // Swallowed recorder failures are counted and reported ONCE. Correct that a
  // recorder may never fail a request -- an OpenTelemetry hiccup becoming a 5xx
  // would burn the availability budget this project is trying to measure -- but
  // a silently broken recorder produces an empty panel and no evidence, which is
  // the exact failure installDiagLogger exists to eliminate. Once, not per call:
  // at 1000 RPS a per-call log is its own load test. The counter lives in this
  // closure rather than at module scope, so the "no module-level mutable state"
  // property of the restructure holds; a process starts one telemetry object.
  let recorderFailures = 0;
  const onRecorderError = (err) => {
    recorderFailures += 1;
    if (recorderFailures === 1) {
      diag.error('telemetry recorder failed; metrics from this process are incomplete',
        err?.message ?? String(err));
    }
  };

  const started = (async () => {
    const resource = await buildResource(config);

    const reader = new PeriodicExportingMetricReader({
      exportIntervalMillis: config.exportIntervalMs,
      exporter: new OTLPMetricExporter({
        url: `${config.otlpEndpoint}/v1/metrics`,
        // Explicit, never defaulted: if the collector is down or the event loop
        // is blocked past the knee, the next successful export carries full
        // cumulative state. Delta would lose those requests permanently.
        temporalityPreference: AggregationTemporality.CUMULATIVE,
      }),
    });

    provider = buildMeterProvider({ resource, readers: [reader] });
    recorders = bindInstruments(provider, { poolStats });

    // ONE instrumentation, metrics-only -- no tracer provider is registered, so
    // span creation would be a no-op regardless.
    //
    // RuntimeNodeInstrumentation emits nodejs.eventloop.delay and the v8js.*
    // family. That is where event-loop lag comes from; this service exposes no
    // /stats endpoint and no Server-Timing header.
    //
    // NOT registered: @opentelemetry/instrumentation-pg. The number this project
    // needs is the time spent WAITING for a connection, which is a property of
    // the pool and not of any statement, and pg instrumentation does not report
    // it. src/pool.js wraps checkout itself and feeds recordPoolWait, which is
    // also the only path that can attribute a wait to a route and class.
    //
    // NOT registered: @opentelemetry/auto-instrumentations-node. It pulls in
    // instrumentation for libraries this service does not use and adds context
    // propagation the metrics path does not need, against a 250us/request budget.
    registerInstrumentations({
      meterProvider: provider,
      instrumentations: [new RuntimeNodeInstrumentation()],
    });

    return provider;
  })().catch((err) => {
    // A telemetry start that fails must cost telemetry, never the service: the
    // recorders simply stay no-ops. Logged through diag so it is greppable
    // alongside export failures.
    diag.error('telemetry start failed', err?.message ?? String(err));
    return null;
  });

  return {
    started,
    /** Swallowed recorder failures so far. Reported once through diag; see above. */
    recorderFailures: () => recorderFailures,
    // Delegating wrappers, not `recorders.recordRequest` directly: the recorders
    // do not exist yet when this object is built, and between this synchronous
    // return and `started` resolving a request may already be served. Nothing
    // here may throw: an OpenTelemetry hiccup becoming a 5xx would burn the
    // availability budget this project is trying to measure.
    recordRequest(args) {
      try { recorders?.recordRequest(args); } catch (err) { onRecorderError(err); }
    },
    recordPoolWait(args) {
      try { recorders?.recordPoolWait(args); } catch (err) { onRecorderError(err); }
    },
    /**
     * Awaits the background start, then closes whatever was actually created.
     * Task 9 calls this from the SIGTERM handler, so the provider's own
     * shutdown -- which CAN reject, e.g. on a final export to a dead collector
     * -- is guarded too: an unhandled rejection during container stop would be
     * a crash in the one path that is supposed to be orderly.
     */
    async shutdown() {
      await started;                       // resolves to null on failure, never rejects
      if (!provider) return;
      try {
        await provider.shutdown();
      } catch (err) {
        diag.error('telemetry shutdown failed', err?.message ?? String(err));
      }
    },
  };
}
