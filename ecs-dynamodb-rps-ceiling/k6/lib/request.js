import http from 'k6/http';
import exec from 'k6/execution';
import { Rate, Trend } from 'k6/metrics';
import { pick } from './mix.js';
import { CLASS_THRESHOLD_MS, TAIL_MULTIPLIER } from './slo.js';

export const sloMet = new Rate('slo_met');
export const sloMetTail = new Rate('slo_met_tail');
export const dbMs = new Trend('db_ms', true);
export const cpuMs = new Trend('cpu_ms', true);
export const appMs = new Trend('app_ms', true);
export const elDelay = new Trend('el_delay_p99_ms', true);

const PARTITIONS = 50;
const ITEMS_PER_PARTITION = 20;
const pad = (n) => String(n).padStart(2, '0');

const CLASS_OF = { read: 'fast', write: 'fast', feed: 'standard', report: 'heavy' };
const JSON_HEADERS = { 'Content-Type': 'application/json' };

function parseServerTiming(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(',')) {
    const m = /([a-zA-Z_]+);dur=([\d.]+)/.exec(part.trim());
    if (m) out[m[1]] = parseFloat(m[2]);
  }
  return out;
}

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

  // Server-side attribution: which resource is the ceiling?
  const st = parseServerTiming(res.headers['Server-Timing']);
  if (st.db !== undefined) dbMs.add(st.db, tags);
  if (st.cpu !== undefined) cpuMs.add(st.cpu, tags);
  // app = total in-handler wall time. other = app - db - cpu is the
  // unattributed remainder (SDK signing, marshalling, JSON serialization),
  // which at 0.25 vCPU is a large fraction of the per-request budget.
  if (st.app !== undefined) appMs.add(st.app, tags);

  return res;
}

export function pollStats(baseUrl) {
  const res = http.get(`${baseUrl}/stats`, { tags: { class: 'stats' } });
  if (res.status === 200) {
    const body = res.json();
    if (body && body.eventLoopDelayMs) elDelay.add(body.eventLoopDelayMs.p99);
  }
}
