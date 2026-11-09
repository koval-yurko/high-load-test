import http from 'k6/http';
import exec from 'k6/execution';
import { Rate } from 'k6/metrics';
import { classOf } from './mix.js';
import { CLASS_THRESHOLD_MS } from './slo.js';
import { BASE_URL, KEYS, SEED } from './env.js';

// k6 is the only SLI (spec decision 5). Only judged users add samples to slo_met and
// slo_available; every user adds to rate_limited.
export const sloMet = new Rate('slo_met');
export const sloAvailable = new Rate('slo_available');
export const rateLimited = new Rate('rate_limited');

const p4 = (n) => String(n).padStart(4, '0');
const p3 = (n) => String(n).padStart(3, '0');
const rnd = (n) => Math.floor(Math.random() * n);

export function doRequest({ user, judged, tags = {} }) {
  const cls = classOf(exec.scenario.iterationInTest);
  let url;
  let name;
  if (cls === 'fast') {
    url = `/items/feed-${p4(rnd(SEED.feeds))}/item-${p4(rnd(SEED.itemsPerFeed))}`;
    name = 'GET /items/{pk}/{sk}';
  } else if (cls === 'standard') {
    url = `/feeds/feed-${p4(rnd(SEED.feeds))}`;
    name = 'GET /feeds/{pk}';
  } else {
    url = `/reports/report-${p3(rnd(SEED.reports))}`;
    name = 'GET /reports/{pk}';
  }
  const t = { class: cls, user, ...tags };
  // `name` groups URLs that differ only by key; without it every key is a new metric
  // series, and Grafana Cloud ends the run at its active-series limit (seen 2026-11-04).
  const res = http.get(`${BASE_URL}${url}`, { headers: { 'x-api-key': KEYS[user] }, tags: { ...t, name } });

  rateLimited.add(res.status === 429, t);
  // A 429 is the limiter working, not a miss (spec: never a miss), so it counts only in rate_limited.
  if (judged && res.status !== 429) {
    // status 0 is a network error: no response at all, so it is a miss.
    sloAvailable.add(res.status > 0 && res.status < 500, t);
    sloMet.add(res.status >= 200 && res.status < 300 && res.timings.duration <= CLASS_THRESHOLD_MS[cls], t);
  }
  return res;
}
