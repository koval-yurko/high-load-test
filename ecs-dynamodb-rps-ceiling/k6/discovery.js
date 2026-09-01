import { thresholds } from './lib/slo.js';
import { doRequest } from './lib/request.js';
import { BASE_URL, USER_AGENT } from './lib/env.js';

export const START_RATE = Number(__ENV.START_RATE || 50);
export const MAX_RATE = Number(__ENV.MAX_RATE || 2000);
export const RAMP_SECONDS = Number(__ENV.RAMP_SECONDS || 900);

export const options = {
  userAgent: USER_AGENT,
  cloud: {
    name: 'ecs-dynamodb-rps-ceiling discovery',
    distribution: { frankfurt: { loadZone: 'amazon:de:frankfurt', percent: 100 } },
  },
  // Abort at the knee: the run stops the moment the primary SLI drops below
  // objective, and the arrival rate at that instant IS the capacity number.
  thresholds: {
    ...thresholds,
    slo_met: [{ threshold: 'rate>0.99', abortOnFail: true, delayAbortEval: '30s' }],
  },
  scenarios: {
    ramp: {
      executor: 'ramping-arrival-rate',
      startRate: START_RATE,
      timeUnit: '1s',
      // Pre-allocated, never grown mid-test: k6 documents that allocating VUs
      // during a run costs CPU and memory on the generator and skews results.
      preAllocatedVUs: Number(__ENV.PRE_VUS || 400),
      stages: [{ target: MAX_RATE, duration: `${RAMP_SECONDS}s` }],
      gracefulStop: '10s',
    },
  },
};

export default function () { doRequest(BASE_URL); }
