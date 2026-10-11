// src/tracing-options.js
// The decisions the tracing preload makes, kept apart from the preload so they
// can be tested without a loader hook or a collector. Imports only routes.js,
// which imports nothing: the preload must not pull pg in before the
// instrumentation is registered.
import { matchRoute, ROUTE_CLASS } from './routes.js';

/**
 * 100% sampling at hundreds of rps is thousands of spans a second; the SDK
 * default queue (2048) would drop silently. Sized for it, flushed every second.
 */
export const BATCH = { maxQueueSize: 8192, maxExportBatchSize: 1024, scheduledDelayMillis: 1000 };

const pathOf = (req) => (typeof req?.url === 'string' ? req.url.split('?')[0] : null);

/** ALB health checks are not requests anyone debugs, and would dominate idle volume. */
export function ignoreIncoming(req) {
  return pathOf(req) === '/healthz';
}

/**
 * The auto-instrumented server span is named just "GET" and carries the raw
 * path. This gives it the route TEMPLATE (never the concrete id) and the SLO
 * class, so TraceQL can filter by class. Runs on every request: it must not throw.
 */
export function serverRequestHook(span, req) {
  const path = pathOf(req);
  if (path === null || typeof req.method !== 'string') return;
  const route = matchRoute(req.method, path);
  if (!route) return;
  span.updateName(`${req.method} ${route.template}`);
  span.setAttribute('http.route', route.template);
  const cls = ROUTE_CLASS[route.name];
  if (cls) span.setAttribute('class', cls);
}

export function httpOptions() {
  return {
    ignoreIncomingRequestHook: ignoreIncoming,
    // The OTLP exporter and the CloudWatch publisher would otherwise show up as
    // client spans every few seconds.
    ignoreOutgoingRequestHook: () => true,
    requestHook: serverRequestHook,
  };
}

// Explicit rather than default: with it on, every span would carry the bound
// parameter values, including 1 KB post bodies. Statement text only.
export const pgOptions = { enhancedDatabaseReporting: false };
