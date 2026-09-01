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
      preAllocatedVUs: Number(__ENV.PRE_VUS || 400),
      gracefulStop: '10s',
    },
  },
};

export default function () { doRequest(BASE_URL); }
