// src/tracing.js
// Loaded with `node --import ./src/tracing.js src/server.js`. It has to run
// BEFORE server.js imports node:http and pg, which is why it is a preload and
// not part of startTelemetry (called from main(), after those imports).
//
// Order below is load-bearing: the loader hook, then the instrumentations, and
// only then anything that might import http or pg (otel.js's exporter does).
//
// With OTLP_ENDPOINT unset this does nothing at all -- no hook, no exporter --
// so tests and local runs need no collector.
import { register } from 'node:module';

if (process.env.OTLP_ENDPOINT) {
  register('import-in-the-middle/hook.mjs', import.meta.url);

  const { NodeTracerProvider, BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } =
    await import('@opentelemetry/sdk-trace-node');
  const { registerInstrumentations } = await import('@opentelemetry/instrumentation');
  const { HttpInstrumentation } = await import('@opentelemetry/instrumentation-http');
  const { PgInstrumentation } = await import('@opentelemetry/instrumentation-pg');
  const { BATCH, httpOptions, pgOptions } = await import('./tracing-options.js');

  registerInstrumentations({
    instrumentations: [new HttpInstrumentation(httpOptions()), new PgInstrumentation(pgOptions)],
  });

  // Safe to import now that the instrumentations are registered.
  const { loadConfig } = await import('./config.js');
  const { buildResource } = await import('./otel.js');
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');

  const config = loadConfig();
  const provider = new NodeTracerProvider({
    // The same resource as the metrics, so a trace and its series share service.instance.id.
    resource: await buildResource(config),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.traceSampleRatio) }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${config.otlpEndpoint}/v1/traces` }), BATCH),
    ],
  });
  provider.register();

  // ECS sends SIGTERM on stop; flush what is queued. Additional listener only:
  // server.js's own shutdown is unaffected.
  process.once('SIGTERM', () => { provider.shutdown().catch(() => {}); });
}
