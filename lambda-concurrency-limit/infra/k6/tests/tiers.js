import exec from 'k6/execution';
import { gate } from './lib/slo.js';
import { doRequest } from './lib/request.js';
import { USER_AGENT, CLOUD, RATE_SOURCE } from './lib/env.js';
import { iterationRate, shouldSend, vus } from './lib/arrivals.js';
import { ANON_CALLERS as ANON_MAX, TIER_VU_CAP } from './lib/tier.js';

// Two rate-limit tiers (tiered rate limits spec): keyed (normal, 4 callers, plus noisy, 1) and
// anonymous (20 keyless callers, each with its own spoofed X-Forwarded-For).
// Rates are per caller. One scenario per tier at the summed rate: a scenario costs at least 5 VUs,
// so one scenario per caller would break the 100-VU cap. Every iteration picks a caller at random,
// so each caller still sees Poisson arrivals at its own rate.
const NORMAL = Number(__ENV.NORMAL_RATE || 10);
const NOISY = Number(__ENV.NOISY_RATE || 60);
const ANON = Number(__ENV.ANON_RATE || 1);
const WARMUP = Number(__ENV.WARMUP_SECONDS || 60);
const DURATION = Number(__ENV.DURATION_SECONDS || 600);
// Which callers send: 1..4 keyed users, 1.. keyless addresses (NORMAL_CALLERS, ANON_CALLERS).
const NORMAL_CALLERS = Math.min(4, Number(__ENV.NORMAL_CALLERS || 4));
const ANON_CALLERS = Number(__ENV.ANON_CALLERS || ANON_MAX);

const ALL = { normal: NORMAL_CALLERS * NORMAL, noisy: NOISY, anonymous: ANON_CALLERS * ANON };
const TIERS = (__ENV.TIERS || Object.keys(ALL).join(',')).split(',');

const scenarios = {};
for (const t of TIERS) {
  if (!(t in ALL)) throw new Error(`TIERS has unknown tier '${t}' (normal, noisy, anonymous)`);
  scenarios[t] = {
    executor: 'constant-arrival-rate', rate: iterationRate(ALL[t]), timeUnit: '1s',
    duration: `${WARMUP + DURATION}s`, ...vus(ALL[t], TIER_VU_CAP[t]),
  };
}

// Only the tiers with a limit to judge are gated; the noisy caller's own SLO is not the question.
const thresholds = gate('window:measured');
for (const t of TIERS) thresholds[`rate_limited{tier:${t},window:measured}`] = ['rate>=0'];

export const options = {
  userAgent: USER_AGENT,
  tags: { rate_source: RATE_SOURCE },
  cloud: { name: 'lambda-concurrency-limit tiers', ...CLOUD },
  thresholds,
  scenarios,
};

const pick = (n) => 1 + Math.floor(Math.random() * n);

export default function () {
  if (!shouldSend()) return;
  const tier = exec.scenario.name;
  const window = exec.instance.currentTestRunDuration / 1000 < WARMUP ? 'warmup' : 'measured';
  const tags = { window, tier };
  if (tier === 'anonymous') return doRequest({ judged: true, tags, anonymousIndex: pick(ANON_CALLERS) });
  const user = tier === 'noisy' ? 'noisy' : `normal-${pick(NORMAL_CALLERS)}`;
  return doRequest({ user, judged: tier !== 'noisy', tags });
}
