import { thresholds } from './lib/slo.js';
import { doRequest } from './lib/request.js';
import { BASE_URL, RATE, RATE_SOURCE, USER_AGENT } from './lib/env.js';

const DURATION = __ENV.DURATION || '5m';

export const options = {
  userAgent: USER_AGENT,
  // rate_source=default means RATE fell back to the placeholder in lib/env.js
  // instead of being given a measured knee. Such a run is not a baseline.
  tags: { rate_source: RATE_SOURCE },
  cloud: {
    name: 'ecs-dynamodb-rps-ceiling constant',
    distribution: { frankfurt: { loadZone: 'amazon:de:frankfurt', percent: 100 } },
  },
  thresholds,
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      // VUs = rate x mean latency. At the SLO boundary the frozen mix averages
      // 0.55*50 + 0.15*50 + 0.25*200 + 0.05*800 ms = 125 ms, so this is exactly
      // enough for a run that meets the SLO; one that breaches it also drops
      // iterations, which the dropped_iterations gate reports. Capped at the
      // org's 100-VU limit (grafana/k6.tf). A fixed 400 tripped that cap.
      preAllocatedVUs: Number(__ENV.PRE_VUS || Math.min(100, Math.ceil(RATE * 0.125))),
      gracefulStop: '10s',
    },
  },
};

export default function () { doRequest(BASE_URL); }
