import { thresholds } from './lib/slo.js';
import { doRequest, pollStats } from './lib/request.js';

const BASE_URL = __ENV.BASE_URL;
const RATE = Number(__ENV.RATE);        // the knee from discovery. No default: guessing it is the bug.
const DURATION = __ENV.DURATION || '5m';

if (!RATE) throw new Error('RATE is required — it is the discovered knee, not a guess');

export const options = {
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
    stats: {
      executor: 'constant-arrival-rate',
      rate: 1, timeUnit: '1s', duration: DURATION,
      preAllocatedVUs: 2, exec: 'stats', gracefulStop: '5s',
    },
  },
};

export default function () { doRequest(BASE_URL); }
export function stats() { pollStats(BASE_URL); }
