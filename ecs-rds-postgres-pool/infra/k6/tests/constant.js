// Forked from ecs-dynamodb-rps/infra/k6/tests/constant.js on 2026-09-21.
// A bug fixed here does not reach the sibling copy; fix both.

import { thresholds } from './lib/slo.js';
import { doRequest } from './lib/request.js';
import { BASE_URL, RATE, RATE_SOURCE, USER_AGENT } from './lib/env.js';

const DURATION = __ENV.DURATION || '5m';

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
  // rate_source=default means RATE fell back to the placeholder in lib/env.js
  // instead of being given a measured knee. Such a run is not a baseline.
  tags: { rate_source: RATE_SOURCE },
  cloud: {
    name: 'ecs-rds-postgres-pool constant',
    distribution: { frankfurt: { loadZone: 'amazon:de:frankfurt', percent: 100 } },
  },
  thresholds,
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      // VUs = rate x MEAN_SECONDS (see the guard above); one that breaches the
      // SLO also drops iterations, which the dropped_iterations gate reports.
      // Capped at the org's 100-VU limit (see infra/k6/main.tf). A fixed 400 tripped
      // that cap.
      preAllocatedVUs: Number(__ENV.PRE_VUS || Math.min(100, Math.ceil(RATE * MEAN_SECONDS))),
      gracefulStop: '10s',
    },
  },
};

export default function () { doRequest(BASE_URL); }
