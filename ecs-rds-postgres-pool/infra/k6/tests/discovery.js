// Forked from ecs-dynamodb-rps/infra/k6/tests/discovery.js on 2026-09-21.
// A bug fixed here does not reach the sibling copy; fix both.

import { thresholds as base, SLO_MET_RATE, CLASS_THRESHOLD_MS } from './lib/slo.js';
import { doRequest } from './lib/request.js';
import { BASE_URL, USER_AGENT } from './lib/env.js';

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

export const START_RATE   = Number(__ENV.START_RATE   || 100);
export const MAX_RATE     = Number(__ENV.MAX_RATE     || 2000);
export const STEP_RPS     = Number(__ENV.STEP_RPS     || 100);
export const STEP_SECONDS = Number(__ENV.STEP_SECONDS || 60);

// Steps, not a ramp. k6 evaluates a rate threshold over EVERY sample since the
// test began, so on a continuous ramp the cumulative slo_met crosses the
// objective long after the real knee -- ten good minutes dilute the misses --
// and the old "rate at abort time" formula overstated capacity by however long
// that took. One scenario per step gives each rate its own population and its
// own verdict.
//
// Every rate below comes from SLO_MET_RATE, which slo.yaml generates. It was
// typed here as a literal 0.99 until 2026-09-09, which meant this profile kept
// measuring the knee against 99% no matter what the SLO said -- the one drift
// the generator existed to prevent, in the one file it did not write.
//
// Reading the result: in the summary export a threshold's boolean is BREACHED
// (true = crossed). The knee is the lowest rps_N whose slo_met{scenario:rps_N}
// reads true; RATE for constant.js and stress.js is the step before it. If no
// step breached, the ceiling is above MAX_RATE -- raise it and re-run rather
// than reporting MAX_RATE as the answer.
const scenarios = {};
const thresholds = {
  ...base,
  // The cumulative gate is kept only as a STOP, so a clearly broken service does
  // not run all twenty steps. It is not the measurement; the per-step
  // thresholds below are.
  slo_met: [{ threshold: `rate>${SLO_MET_RATE}`, abortOnFail: true, delayAbortEval: '60s' }],
};

let i = 0;
for (let rate = START_RATE; rate <= MAX_RATE; rate += STEP_RPS, i++) {
  const name = `rps_${rate}`;
  scenarios[name] = {
    executor: 'constant-arrival-rate',
    rate,
    timeUnit: '1s',
    duration: `${STEP_SECONDS}s`,
    startTime: `${i * STEP_SECONDS}s`,
    // VUs = rate x MEAN_SECONDS (see the guard above). A step past the knee
    // also drops iterations; that is fine, it has already failed on slo_met,
    // and the dropped_iterations gate marks the run. Capped at the org's
    // 100-VU limit.
    preAllocatedVUs: Math.min(100, Math.ceil(rate * MEAN_SECONDS)),
    gracefulStop: '5s',
  };
  thresholds[`slo_met{scenario:${name}}`] = [`rate>${SLO_MET_RATE}`];
}

export const options = {
  userAgent: USER_AGENT,
  cloud: {
    name: 'ecs-rds-postgres-pool discovery',
    distribution: { frankfurt: { loadZone: 'amazon:de:frankfurt', percent: 100 } },
  },
  thresholds,
  scenarios,
};

export default function () { doRequest(BASE_URL); }
