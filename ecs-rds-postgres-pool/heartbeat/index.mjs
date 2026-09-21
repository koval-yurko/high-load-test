// Forked from ecs-dynamodb-rps/heartbeat/index.mjs on 2026-09-21.
// A bug fixed here does not reach the sibling copy; fix both.
// Idle population for the SLI. Between load tests nothing calls the service and
// /healthz is excluded by selector, so the class ratio would be no-data and no
// error budget would accrue. EventBridge Scheduler invokes this once a minute
// (terraform/heartbeat.tf) purely so the burn-rate alerts have something to burn.
//
// One request per LATENCY CLASS, not per route: fast, standard and heavy each
// need a population of their own, or the class the alert fires on is the one
// with no data. The Grafana synthetic checks this replaced only covered fast and
// standard.
//
// Zero dependencies on purpose -- global fetch is in nodejs22.x, so the whole
// deployment package is this file and `archive_file` needs no build step.

// One route per latency class, so the SLI series for every class stays alive
// between load tests -- infra/grafana/canary.tf alerts when one goes absent.
// Feed 1 and post 1 exist because prisma/seed.js numbers feeds from 1 and inserts
// posts with an autoincrement primary key starting at 1.
const ROUTES = [
  { route: '/posts/1', method: 'GET' }, // fast     -> getPost
  { route: '/feeds/1/posts', method: 'GET' }, // standard -> feed
  { route: '/posts', method: 'POST', body: '{}' }, // fast     -> createPost
  { route: '/reports', method: 'POST', body: '{"feedId":1}' }, // heavy    -> report
];

// Well under the Lambda's 30s timeout, and under the ALB's 60s idle timeout, so
// a hung target costs one slow beat rather than pinning the invocation.
const REQUEST_TIMEOUT_MS = 5000;

// A later change keys traffic_source on this, to separate the heartbeat from k6
// in the SLI. Changing it changes that split.
const USER_AGENT = 'heartbeat/1.0';

async function beat(baseUrl, { route, method, body }) {
  const started = Date.now();
  try {
    const res = await fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        'User-Agent': USER_AGENT,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // Drain the body so the socket is released rather than left for the GC.
    await res.arrayBuffer();
    return { route, status: res.status, ms: Date.now() - started };
  } catch (err) {
    // Never rethrow. A 500 or a timeout is a fact about the service, and the SLI
    // already records it; failing the invocation on top of that would turn a
    // service blip into a Lambda error alarm pointing at the wrong thing.
    return { route, status: 0, ms: Date.now() - started, error: String(err && err.message ? err.message : err) };
  }
}

export async function handler() {
  const baseUrl = process.env.BASE_URL;
  if (!baseUrl) {
    // This one DOES throw: without a target the invocation did nothing at all,
    // and that is a deployment bug, not a service blip.
    throw new Error('BASE_URL is not set; the heartbeat has no target');
  }

  const results = await Promise.all(ROUTES.map((r) => beat(baseUrl.replace(/\/+$/, ''), r)));
  const ok = results.filter((r) => r.status >= 200 && r.status < 300).length;

  console.log(JSON.stringify({ msg: 'heartbeat', baseUrl, ok, total: results.length, results }));

  return { ok, results };
}
