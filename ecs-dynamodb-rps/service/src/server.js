// src/server.js
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { loadConfig } from './config.js';
import { createRepo } from './dynamo.js';
import { createHandlers, matchRoute } from './handlers.js';
import { RETRY_AFTER_SECONDS, SHED_STATUS, startAdmission } from './admission.js';
import { startEluPublisher } from './cloudwatch.js';
import { recordRequest, startOtel } from './otel.js';
import { createTimer } from './timing.js';

const MAX_BODY_BYTES = 16 * 1024;

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('invalid json'); }
}

/**
 * `admission` is optional: absent (SHED_ELU_THRESHOLD unset) means no gate at all.
 */
export function createServer({ handlers, admission }) {
  return http.createServer(async (req, res) => {
    // First line: as close to "the event loop reached this request" as Node
    // allows. Everything before it -- accept queue, header parse -- is
    // invisible to the process by construction. See spec section 11.
    const startedAt = performance.now();
    const timer = createTimer();
    const path = req.url.split('?')[0];
    const route = matchRoute(req.method, path);
    // Unmatched paths collapse to one bounded label value. Recording req.url
    // here would let any internet scanner mint new time series.
    const template = route ? route.template : 'unmatched';

    res.on('finish', () => recordRequest({
      route: template,
      method: req.method,
      status: res.statusCode,
      durationSeconds: (performance.now() - startedAt) / 1000,
      // Mapped to a closed set inside recordRequest; the raw value never reaches
      // the histogram, so an internet scanner cannot mint a time series.
      userAgent: req.headers['user-agent'],
      // Read on finish, when every mark is complete. /healthz touches no timer,
      // so this is {} there and no phase series is minted for it.
      phases: timer.phases(),
    }));

    const send = (status, body) => {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };

    if (!route) return send(404, { error: 'no route' });

    // Admission gate (spike-response spec §6). Placed AFTER matchRoute and the
    // 'finish' listener, so a shed request is recorded with its real route label
    // and status 429 -- not as 'unmatched' -- and Grafana's GOOD selector
    // (!~"5..") scores it (spec §7). That ordering costs nothing §6.2 forbids:
    // matchRoute is a handful of regexes with no I/O, and the requirement is no
    // database work and ~1 ms. BEFORE body reading and the handler, which is
    // where the database work is. An unmatched path is not gated: its 404 is
    // already as cheap as a 429. /healthz is never shed (src/admission.js).
    if (admission?.shouldShed(route)) {
      res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
      return send(SHED_STATUS, { error: 'overloaded' });
    }

    try {
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      const result = await handlers[route.name]({ params: route.params, body, timer });
      send(result.status, result.body);
    } catch (err) {
      send(500, { error: err.message });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const repo = createRepo(config);
  // Started before the listener so no request is served unrecorded.
  const otel = config.otlpEndpoint
    ? await startOtel({ ...config, instanceIdFallback: `local-${process.pid}` })
    : null;
  // Same gate as OTel: no METRICS_NAMESPACE, no publisher and no AWS client.
  // Started before the listener so the first overload is already being sampled.
  const metrics = config.metricsNamespace ? startEluPublisher(config) : null;
  // Same gate again: no SHED_ELU_THRESHOLD, no admission gate, sampler or timer.
  // Started before the listener so the first overload is already being measured.
  const admission = config.shedEluThreshold !== undefined ? startAdmission(config) : null;
  const server = createServer({ handlers: createHandlers({ repo, config }), admission });
  // The ALB's idle_timeout is 60s (terraform/alb.tf). AWS requires the target's keep-alive to
  // exceed the load balancer's idle timeout, or the ALB can dispatch a request onto a connection
  // Node is simultaneously closing, which surfaces as a 502 that burns error budget the service
  // never actually spent. Node's own default (5s) is far under 60s — do not remove these without
  // also raising the ALB's idle_timeout to stay below them.
  server.keepAliveTimeout = 65_000;   // must exceed the ALB's idle_timeout (60s)
  server.headersTimeout   = 66_000;   // must exceed keepAliveTimeout
  server.listen(config.port, () => console.log(JSON.stringify({ msg: 'listening', ...config })));
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => server.close(async () => {
      // ECS sends SIGTERM then waits stopTimeout. Flushing here is worth doing:
      // at 1000 RPS an unflushed 15s interval is 15,000 requests missing from
      // the window. Counters are cumulative, but only for a task still alive to
      // send them.
      if (otel) await otel.shutdown().catch(() => {});
      // No final flush: a scaling alarm has no use for the last ELU sample of a
      // task that is already leaving.
      metrics?.stop();
      admission?.stop();
      repo.destroy();
      process.exit(0);
    }));
  }
}
