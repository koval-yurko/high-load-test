import exec from 'k6/execution';
import { gate, LATENCY_RATE, AVAILABILITY_RATE } from './lib/slo.js';
import { doRequest } from './lib/request.js';
import { USER_AGENT, CLOUD, RATE_SOURCE } from './lib/env.js';
import { iterationRate, shouldSend, vus } from './lib/arrivals.js';

const START = Number(__ENV.START_RATE || 10);
const STEP = Number(__ENV.STEP_RPS || 10);
const MAX = Number(__ENV.MAX_RATE || 120);
const STEP_SECONDS = Number(__ENV.STEP_SECONDS || 120);
const WARMUP = Number(__ENV.WARMUP_SECONDS || 60);

// The last step whose slo_met and slo_available both pass is the measured capacity at
// this reserved concurrency; compare it with `npm run capacity`. The run stops once the
// whole-run availability is clearly gone.
const scenarios = {
  warmup: {
    // 0s: k6 adds the VUs of scenarios whose graceful stop overlaps the next one, and the cap is 100.
    gracefulStop: '0s',
    executor: 'ramping-arrival-rate', startRate: 0, timeUnit: '1s',
    stages: [{ target: iterationRate(START), duration: `${WARMUP}s` }],
    ...vus(START), tags: { window: 'warmup' },
  },
};
const thresholds = {
  ...gate('window:step'),
  slo_available: [{ threshold: `rate>=${AVAILABILITY_RATE}`, abortOnFail: true, delayAbortEval: '60s' }],
};
// Each step is gated by its own scenario tag, so `scenario:rps_N` shows where it broke.
delete thresholds['slo_met{window:step}'];
delete thresholds['slo_available{window:step}'];

let i = 0;
for (let rate = START; rate <= MAX; rate += STEP, i++) {
  const name = `rps_${rate}`;
  scenarios[name] = {
    executor: 'constant-arrival-rate', rate: iterationRate(rate), timeUnit: '1s',
    duration: `${STEP_SECONDS}s`, startTime: `${WARMUP + i * STEP_SECONDS}s`,
    // 0s: k6 adds the VUs of scenarios whose graceful stop overlaps the next one, and the cap is 100.
    ...vus(rate), gracefulStop: '0s', tags: { window: 'step' },
  };
  thresholds[`slo_met{scenario:${name}}`] = [`rate>=${LATENCY_RATE}`];
  thresholds[`slo_available{scenario:${name}}`] = [`rate>=${AVAILABILITY_RATE}`];
}

export const options = {
  userAgent: USER_AGENT,
  tags: { rate_source: RATE_SOURCE },
  cloud: { name: 'lambda-concurrency-limit discovery', ...CLOUD },
  thresholds,
  scenarios,
};

export default function () {
  const s = exec.scenario.name;
  if (shouldSend()) doRequest({ user: 'load', judged: true, tags: { window: s === 'warmup' ? 'warmup' : 'step', scenario: s } });
}
