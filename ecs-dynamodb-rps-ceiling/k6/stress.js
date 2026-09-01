import { thresholds } from './lib/slo.js';
import { doRequest } from './lib/request.js';
import { BASE_URL, RATE, RATE_SOURCE, USER_AGENT } from './lib/env.js';

const MULTIPLIER = Number(__ENV.MULTIPLIER || 3);

const PEAK = Math.round(RATE * MULTIPLIER);

export const options = {
  userAgent: USER_AGENT,
  // See constant.js -- default means no measured knee was supplied.
  tags: { rate_source: RATE_SOURCE },
  cloud: {
    name: 'ecs-dynamodb-rps-ceiling stress',
    distribution: { frankfurt: { loadZone: 'amazon:de:frankfurt', percent: 100 } },
  },
  // No abortOnFail here: this profile is SUPPOSED to breach. Aborting would
  // discard exactly the error-budget burn it exists to measure.
  thresholds,
  scenarios: {
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: RATE,
      timeUnit: '1s',
      preAllocatedVUs: Number(__ENV.PRE_VUS || 1200),
      stages: [
        { target: RATE, duration: '1m' },   // hold at the known-good rate
        { target: PEAK, duration: '30s' },  // spike
        { target: PEAK, duration: '2m' },   // hold past the burst window
        { target: RATE, duration: '30s' },  // recover
        { target: RATE, duration: '1m' },
      ],
      gracefulStop: '15s',
    },
  },
};

export default function () { doRequest(BASE_URL); }
