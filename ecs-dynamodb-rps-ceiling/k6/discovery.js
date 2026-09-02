import { thresholds as base } from './lib/slo.js';
import { doRequest } from './lib/request.js';
import { BASE_URL, USER_AGENT } from './lib/env.js';

export const START_RATE   = Number(__ENV.START_RATE   || 100);
export const MAX_RATE     = Number(__ENV.MAX_RATE     || 2000);
export const STEP_RPS     = Number(__ENV.STEP_RPS     || 100);
export const STEP_SECONDS = Number(__ENV.STEP_SECONDS || 60);

// Steps, not a ramp. k6 evaluates a rate threshold over EVERY sample since the
// test began, so on a continuous ramp the cumulative slo_met crosses 0.99 long
// after the real knee -- ten good minutes dilute the misses -- and the old
// "rate at abort time" formula overstated capacity by however long that took.
// One scenario per step gives each rate its own population and its own verdict.
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
  slo_met: [{ threshold: 'rate>0.99', abortOnFail: true, delayAbortEval: '60s' }],
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
    // VUs = rate x mean latency. At the SLO boundary the frozen mix averages
    // 0.55*50 + 0.15*50 + 0.25*200 + 0.05*800 ms = 125 ms, so this is exactly
    // enough for a step that meets the SLO. A step past the knee also drops
    // iterations; that is fine, it has already failed on slo_met, and the
    // dropped_iterations gate marks the run. Capped at the org's 100-VU limit.
    preAllocatedVUs: Math.min(100, Math.ceil(rate * 0.125)),
    gracefulStop: '5s',
  };
  thresholds[`slo_met{scenario:${name}}`] = ['rate>0.99'];
}

export const options = {
  userAgent: USER_AGENT,
  cloud: {
    name: 'ecs-dynamodb-rps-ceiling discovery',
    distribution: { frankfurt: { loadZone: 'amazon:de:frankfurt', percent: 100 } },
  },
  thresholds,
  scenarios,
};

export default function () { doRequest(BASE_URL); }
