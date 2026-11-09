import exec from 'k6/execution';
import { gate } from './lib/slo.js';
import { doRequest } from './lib/request.js';
import { USER_AGENT, CLOUD, RATE_SOURCE } from './lib/env.js';
import { iterationRate, shouldSend, vus } from './lib/arrivals.js';

const PEAK = Number(__ENV.PEAK_RATE || 50);
const BASE = Math.max(1, Math.round(PEAK * Number(__ENV.BASE_FRACTION || 0.1)));
const BASE_SECONDS = Number(__ENV.BASE_SECONDS || 180);
const SPIKE_SECONDS = Number(__ENV.SPIKE_SECONDS || 120);
const HEAD_SECONDS = Number(__ENV.HEAD_SECONDS || 30);

// Knob 3 (provisioned concurrency) is judged on p99 and max latency in the first
// HEAD_SECONDS of the spike, where the new environments' cold starts land. Attainment
// over the whole spike is gated as usual and is expected to barely move.
export const options = {
  userAgent: USER_AGENT,
  tags: { rate_source: RATE_SOURCE },
  cloud: { name: 'lambda-concurrency-limit spike', ...CLOUD },
  thresholds: {
    ...gate('window:spike'),
    'http_req_duration{head:yes}': ['p(99)>=0', 'max>=0'],
  },
  // Parallel scenarios share the 100-VU cap.
  scenarios: {
    base: {
      executor: 'constant-arrival-rate', rate: iterationRate(BASE), timeUnit: '1s',
      duration: `${BASE_SECONDS + SPIKE_SECONDS}s`, ...vus(BASE, 20),
    },
    surge: {
      executor: 'constant-arrival-rate', rate: iterationRate(PEAK - BASE), timeUnit: '1s',
      duration: `${SPIKE_SECONDS}s`, startTime: `${BASE_SECONDS}s`, ...vus(PEAK - BASE, 80),
    },
  },
};

export default function () {
  if (!shouldSend()) return;
  // Windows by elapsed time, so base-scenario requests during the spike count too.
  const s = exec.instance.currentTestRunDuration / 1000;
  const window = s < BASE_SECONDS ? 'base' : 'spike';
  const head = s >= BASE_SECONDS && s < BASE_SECONDS + HEAD_SECONDS ? 'yes' : 'no';
  doRequest({ user: 'load', judged: true, tags: { window, head } });
}
