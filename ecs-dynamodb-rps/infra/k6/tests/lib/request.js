import http from 'k6/http';
import exec from 'k6/execution';
import { Rate } from 'k6/metrics';
import { pick } from './mix.js';
import { CLASS_THRESHOLD_MS, TAIL_MULTIPLIER } from './slo.js';

// k6 records ONLY what a client can observe. Phase timings and event-loop lag
// are emitted by the service into OpenTelemetry and read from Grafana -- see
// docs/superpowers/specs/2026-08-31-ecs-dynamodb-rps-ceiling-attribution-via-metrics-design.md.
// Nothing in the service exists for this file's benefit.
export const sloMet = new Rate('slo_met');
export const sloMetTail = new Rate('slo_met_tail');

const PARTITIONS = 50;
const ITEMS_PER_PARTITION = 20;
const pad = (n) => String(n).padStart(2, '0');

const CLASS_OF = { read: 'fast', write: 'fast', feed: 'standard', report: 'heavy' };
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function doRequest(baseUrl) {
  const i = exec.scenario.iterationInTest;
  const kind = pick(i);
  const cls = CLASS_OF[kind];
  const tags = { class: cls, kind };
  const feed = `feed-${pad(i % PARTITIONS)}`;

  let res;
  if (kind === 'read') {
    res = http.get(`${baseUrl}/items/${feed}/item-${pad(i % ITEMS_PER_PARTITION)}`, { tags });
  } else if (kind === 'feed') {
    res = http.get(`${baseUrl}/feeds/${feed}`, { tags });
  } else if (kind === 'write') {
    res = http.post(`${baseUrl}/items`, '{}', { headers: JSON_HEADERS, tags });
  } else {
    res = http.post(`${baseUrl}/reports`, JSON.stringify({ pk: feed }), { headers: JSON_HEADERS, tags });
  }

  // The primary SLI: did THIS request meet the threshold for ITS class?
  const ok = res.status >= 200 && res.status < 300;
  const limit = CLASS_THRESHOLD_MS[cls];
  sloMet.add(ok && res.timings.duration < limit, tags);
  sloMetTail.add(ok && res.timings.duration < limit * TAIL_MULTIPLIER, tags);

  return res;
}
