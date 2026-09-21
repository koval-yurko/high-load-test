// Forked from ecs-dynamodb-rps/infra/k6/tests/constant.js on 2026-09-21.
// A bug fixed here does not reach the sibling copy; fix both.

import { thresholds, CLASS_THRESHOLD_MS } from './lib/slo.js';
import { doRequest } from './lib/request.js';
import { BASE_URL, RATE, RATE_SOURCE, USER_AGENT } from './lib/env.js';

const DURATION = __ENV.DURATION || '5m';

// Little's law: VUs = rate x mean latency. The mean is the mix-weighted class
// threshold, so the sizing moves with slo.yaml instead of with a constant
// somebody typed: a run that just meets its SLO never starves for VUs, and the
// 100-VU subscription cap (infra/k6/main.tf) is only reached far past the knee.
// -e MEAN_SECONDS still wins, for a deliberate override.
const MIX = { fast: 0.70, standard: 0.25, heavy: 0.05 };   // 55% read + 15% write are both fast
const DERIVED_MEAN_SECONDS =
  (MIX.fast * CLASS_THRESHOLD_MS.fast + MIX.standard * CLASS_THRESHOLD_MS.standard
   + MIX.heavy * CLASS_THRESHOLD_MS.heavy) / 1000;
const MEAN_SECONDS = Number(__ENV.MEAN_SECONDS) > 0 ? Number(__ENV.MEAN_SECONDS) : DERIVED_MEAN_SECONDS;

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
