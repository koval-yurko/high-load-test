// src/admission.js
// Admission control: above the shed threshold, reject immediately with
// 429 + Retry-After instead of queueing. Queueing on a single task pushed
// most fast-class requests over their latency threshold with zero errors; a
// shed request costs ~1 ms, a queue slot costs every request behind it.
//
// The shed threshold MUST stay strictly above every scale-out threshold --
// shedding lowers ELU, and a scale-out step at or above the shed threshold
// would never fire. Asserted against the Terraform in test/admission.test.js.
import { createEluSampler } from './elu.js';

// 250 ms: short enough to react within a fraction of a second of overload,
// long enough that each reading spans many requests instead of one instant.
export const ADMISSION_INTERVAL_MS = 250;

export const SHED_STATUS = 429;
// The fleet is expected to grow within roughly a minute, so a short retry is
// the behaviour we want.
export const RETRY_AFTER_SECONDS = 1;

/**
 * Pure so tests drive it without timers. Sheds only when ELU EXCEEDS the
 * threshold. /healthz is never shed: the ALB must not be told a task is
 * unhealthy because it is busy, or it deregisters capacity when it's needed.
 */
export function shouldShed({ elu, threshold, route }) {
  if (route?.name === 'health') return false;
  return elu > threshold;
}

/**
 * Owns a sampler and the cached reading the gate consults. Uses its OWN
 * sampler instance: sharing the CloudWatch publisher's would steal its delta
 * (src/elu.js). Starts at 0 -- nothing measured yet, so admit.
 */
export function createAdmission({ threshold, sampler = createEluSampler(), intervalMs = ADMISSION_INTERVAL_MS }) {
  let elu = 0;
  let timer = null;

  const refresh = () => { elu = sampler.sample(); };

  return {
    refresh,
    shouldShed: (route) => shouldShed({ elu, threshold, route }),
    start() {
      if (timer) return;
      timer = setInterval(refresh, intervalMs);
      // Never the reason the process stays alive -- shutdown is SIGTERM's job.
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    get elu() { return elu; },
    get timer() { return timer; },
  };
}

/** Wiring for server.js. Only called when config.shedEluThreshold is set. */
export function startAdmission(config) {
  const admission = createAdmission({ threshold: config.shedEluThreshold });
  admission.start();
  return admission;
}
