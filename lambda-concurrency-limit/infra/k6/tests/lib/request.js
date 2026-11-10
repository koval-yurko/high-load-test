import http from 'k6/http';
import exec from 'k6/execution';
import { Rate } from 'k6/metrics';
import { classOf } from './mix.js';
import { CLASS_THRESHOLD_MS } from './slo.js';
import { BASE_URL, KEYS, SEED } from './env.js';
import { anonymousIp, isAvailable, rateLimitedBy } from './tier.js';

// k6 is the only SLI (spec decision 5). Only judged users add samples to slo_met and
// slo_available; every user adds to rate_limited.
export const sloMet = new Rate('slo_met');
export const sloAvailable = new Rate('slo_available');
export const rateLimited = new Rate('rate_limited');

const p4 = (n) => String(n).padStart(4, '0');
const p3 = (n) => String(n).padStart(3, '0');
const rnd = (n) => Math.floor(Math.random() * n);

// anonymousIndex (a number) makes the call keyless: it goes to /public with a spoofed
// X-Forwarded-For, which the WAF rate rule counts per address. Without it the call carries the key.
export function doRequest({ user, judged, tags = {}, anonymousIndex }) {
  const anonymous = anonymousIndex !== undefined;
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
  const caller = anonymous ? `anon-${anonymousIndex}` : user;
  const t = { class: cls, user: caller, ...tags };
  if (anonymous) t.tier = 'anonymous';
  const headers = anonymous ? { 'X-Forwarded-For': anonymousIp(anonymousIndex) } : { 'x-api-key': KEYS[user] };
  // `name` groups URLs that differ only by key; without it every key is a new metric
  // series, and Grafana Cloud ends the run at its active-series limit (seen 2026-11-04).
  const res = http.get(`${BASE_URL}${anonymous ? '/public' : ''}${url}`, { headers, tags: { ...t, name } });

  // Only a 429 marked x-throttle is a limit working (lib/tier.js). A bare 429 is a miss.
  const limited = rateLimitedBy(res.status, res.headers) !== null;
  rateLimited.add(limited, t);
  if (judged && !limited) {
    sloAvailable.add(isAvailable(res.status), t);
    sloMet.add(res.status >= 200 && res.status < 300 && res.timings.duration <= CLASS_THRESHOLD_MS[cls], t);
  }
  return res;
}
