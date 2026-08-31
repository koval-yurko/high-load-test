import { thresholds } from './lib/slo.js';
import { doRequest } from './lib/request.js';

const BASE_URL = __ENV.BASE_URL;
const RATE = Number(__ENV.RATE);          // the knee
const MULTIPLIER = Number(__ENV.MULTIPLIER || 3);

if (!RATE) throw new Error('RATE is required — it is the discovered knee, not a guess');

const PEAK = Math.round(RATE * MULTIPLIER);

export const options = {
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
