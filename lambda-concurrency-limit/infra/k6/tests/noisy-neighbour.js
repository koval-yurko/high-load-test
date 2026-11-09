import exec from 'k6/execution';
import { gate } from './lib/slo.js';
import { doRequest } from './lib/request.js';
import { USER_AGENT, CLOUD, RATE_SOURCE } from './lib/env.js';
import { iterationRate, shouldSend, vus } from './lib/arrivals.js';

const NORMAL = Number(__ENV.NORMAL_RATE || 10);
const NOISY = Number(__ENV.NOISY_RATE || 60);
const WARMUP = Number(__ENV.WARMUP_SECONDS || 60);
const DURATION = Number(__ENV.DURATION_SECONDS || 600);

// One scenario per user; the scenario name is the user and selects its API key. The SLO
// is judged over normal-* only (spec decision 6): the noisy user's 429s are the limit
// working. rate_limited is reported per user.
// Parallel scenarios share the 100-VU cap.
const user = (rate, cap) => ({
  executor: 'constant-arrival-rate', rate: iterationRate(rate), timeUnit: '1s',
  duration: `${WARMUP + DURATION}s`, ...vus(rate, cap),
});
const scenarios = { noisy: user(NOISY, 52) };
for (const n of [1, 2, 3, 4]) scenarios[`normal-${n}`] = user(NORMAL, 12);

const thresholds = gate('window:measured');
for (const u of Object.keys(scenarios)) thresholds[`rate_limited{user:${u},window:measured}`] = ['rate>=0'];

export const options = {
  userAgent: USER_AGENT,
  tags: { rate_source: RATE_SOURCE },
  cloud: { name: 'lambda-concurrency-limit noisy-neighbour', ...CLOUD },
  thresholds,
  scenarios,
};

export default function () {
  if (!shouldSend()) return;
  const name = exec.scenario.name;
  const window = exec.instance.currentTestRunDuration / 1000 < WARMUP ? 'warmup' : 'measured';
  doRequest({ user: name, judged: name.startsWith('normal-'), tags: { window } });
}
