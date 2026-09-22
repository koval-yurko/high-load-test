// Forked from ecs-dynamodb-rps/infra/k6/tests/lib/request.js on 2026-09-21.
// A bug fixed here does not reach the sibling copy; fix both.

import http from 'k6/http';
import exec from 'k6/execution';
import { Rate } from 'k6/metrics';
import { pick } from './mix.js';
import { CLASS_THRESHOLD_MS, TAIL_MULTIPLIER } from './slo.js';

// k6 records ONLY what a client can observe. Phase timings and pool-wait time
// are emitted by the service into OpenTelemetry and read from Grafana.
// Nothing in the service exists for this file's benefit.
export const sloMet = new Rate('slo_met');
export const sloMetTail = new Rate('slo_met_tail');

// The seeded range this profile must stay inside. These mirror
// service/src/config.js's SEED_FEEDS (default 16) and SEED_ROWS (default
// 50000) -- the counts prisma/seed.js used to build this environment's data,
// not a measured capacity number.
const SEED_FEEDS = 16;
const SEED_ROWS = 50000;

// Kind -> class. This MUST agree with src/handlers.js's ROUTE_CLASS and with
// infra/grafana/classmap.json: all three are one mapping written down three
// times, and test/generate-slo.test.js asserts two of them against each other.
// An id outside the seeded range returns 404, which the availability objective
// counts as good -- and which measures nothing.
const CLASS_OF = { read: 'fast', write: 'fast', feed: 'standard', report: 'heavy' };
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function doRequest(baseUrl) {
  const i = exec.scenario.iterationInTest;
  const kind = pick(i);
  const cls = CLASS_OF[kind];
  const tags = { class: cls, kind };
  const feedId = 1 + (i % SEED_FEEDS);
  const postId = 1 + (i % SEED_ROWS);

  let res;
  if (kind === 'read') {
    res = http.get(`${baseUrl}/posts/${postId}`, { tags });
  } else if (kind === 'feed') {
    res = http.get(`${baseUrl}/feeds/${feedId}/posts`, { tags });
  } else if (kind === 'write') {
    res = http.post(`${baseUrl}/posts`, '{}', { headers: JSON_HEADERS, tags });
  } else {
    res = http.post(`${baseUrl}/reports`, JSON.stringify({ feedId }), { headers: JSON_HEADERS, tags });
  }

  // The primary SLI: did THIS request meet the threshold for ITS class?
  const ok = res.status >= 200 && res.status < 300;
  const limit = CLASS_THRESHOLD_MS[cls];
  sloMet.add(ok && res.timings.duration < limit, tags);
  sloMetTail.add(ok && res.timings.duration < limit * TAIL_MULTIPLIER, tags);

  return res;
}
