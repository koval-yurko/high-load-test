import exec from 'k6/execution';
import { gate } from './lib/slo.js';
import { doRequest } from './lib/request.js';
import { USER_AGENT, CLOUD, RATE_SOURCE } from './lib/env.js';
import { iterationRate, shouldSend, vus } from './lib/arrivals.js';

const RATE = Number(__ENV.RATE || 20);
const WARMUP = Number(__ENV.WARMUP_SECONDS || 120);
const DURATION = Number(__ENV.DURATION_SECONDS || 600);

// The warm-up creates the execution environments, so cold starts fall outside the
// judged window. Only window:measured is gated.
export const options = {
  userAgent: USER_AGENT,
  tags: { rate_source: RATE_SOURCE },
  cloud: { name: 'lambda-concurrency-limit constant', ...CLOUD },
  thresholds: gate('window:measured'),
  scenarios: {
    warmup: {
      // 0s: k6 adds the VUs of scenarios whose graceful stop overlaps the next one, and the cap is 100.
      gracefulStop: '0s',
      executor: 'ramping-arrival-rate', startRate: 0, timeUnit: '1s',
      stages: [{ target: iterationRate(RATE), duration: `${WARMUP}s` }],
      ...vus(RATE), tags: { window: 'warmup' },
    },
    measured: {
      executor: 'constant-arrival-rate', rate: iterationRate(RATE), timeUnit: '1s',
      duration: `${DURATION}s`, startTime: `${WARMUP}s`,
      ...vus(RATE), tags: { window: 'measured' },
    },
  },
};

export default function () {
  // Custom metrics need the window tag passed explicitly; the scenario name is the window.
  if (shouldSend()) doRequest({ user: 'load', judged: true, tags: { window: exec.scenario.name } });
}
