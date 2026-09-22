// Forked from ecs-dynamodb-rps/infra/k6/tests/stress.js on 2026-09-21.
// A bug fixed here does not reach the sibling copy; fix both.

import { thresholds } from './lib/slo.js';
import { doRequest } from './lib/request.js';
import { BASE_URL, RATE, RATE_SOURCE, USER_AGENT } from './lib/env.js';

const MULTIPLIER = Number(__ENV.MULTIPLIER || 3);

const PEAK = Math.round(RATE * MULTIPLIER);

// Little's law: VUs = rate x mean latency. The mean derives from the class
// thresholds and the mix, and this project's thresholds are unset until plan 3
// calibrates them (slo.yaml). The sibling's constant would size every run
// against a workload with different costs, so until then this is explicit: pass
// -e MEAN_SECONDS=... or the profile refuses to start.
const MEAN_SECONDS = Number(__ENV.MEAN_SECONDS);
if (!Number.isFinite(MEAN_SECONDS) || MEAN_SECONDS <= 0) {
  throw new Error('MEAN_SECONDS is required until plan 3 freezes the class thresholds; see slo.yaml');
}

export const options = {
  userAgent: USER_AGENT,
  // See constant.js -- default means no measured knee was supplied.
  tags: { rate_source: RATE_SOURCE },
  cloud: {
    name: 'ecs-rds-postgres-pool stress',
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
      // Sized for PEAK at MEAN_SECONDS (see the guard above), capped at the
      // org's 100-VU limit. This profile is meant to breach, so it WILL drop
      // iterations past the knee and fail the dropped_iterations gate -- that
      // is the expected verdict for shape C, and the k6 result still carries
      // the delivered rate.
      preAllocatedVUs: Number(__ENV.PRE_VUS || Math.min(100, Math.ceil(PEAK * MEAN_SECONDS))),
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
