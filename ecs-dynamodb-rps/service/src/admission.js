// src/admission.js
// Admission control (spike-response spec §6): above the shed threshold, reject
// immediately with 429 + Retry-After instead of accepting into a queue. The one
// task that exists in the first minutes of a spike otherwise queues everything,
// and a uniform ~130 ms of queueing pushed 71% of fast-class requests over their
// threshold with zero errors (spec §1). A shed request costs ~1 ms; a queue slot
// costs every request behind it.
//
// Same signal as the scaler (event-loop utilization): the scaler asks for more
// tasks, the shedder protects the tasks that exist. The shed threshold MUST stay
// strictly above every scale-out threshold (spec §6.1) -- shedding clamps ELU
// near its own value, so a scale-out step above it would never fire. Asserted
// against the Terraform in test/admission.test.js.
import { createEluSampler } from './elu.js';

/**
 * 250 ms. Short enough that the gate reacts within a fraction of a second of
 * overload -- the scaler cannot help for ~100 s, so this is the only fast
 * protection -- and long enough that each reading spans hundreds of requests at
 * this service's rates, so it is a utilization and not the on/off state of the
 * loop at one instant. Per-request sampling would measure microsecond windows,
 * which read 0 or 1 depending on where the request happened to land.
 */
export const ADMISSION_INTERVAL_MS = 250;

export const SHED_STATUS = 429;
// Short (spec §6.2): the fleet is expected to grow within ~100 s, so a client
// that backs off briefly and retries is the behaviour we want.
export const RETRY_AFTER_SECONDS = 1;

/**
 * The whole decision, pure so tests drive it without timers. Sheds only when ELU
 * EXCEEDS the threshold. /healthz is never shed: the ALB must not be told a task
 * is unhealthy because it is busy, or it deregisters capacity exactly when it is
 * needed.
 */
export function shouldShed({ elu, threshold, route }) {
  if (route?.name === 'health') return false;
  return elu > threshold;
}

/**
 * Owns a sampler and the cached reading the gate consults. The sampler is this
 * gate's OWN instance: sharing the CloudWatch publisher's would close the
 * publisher's window every 250 ms and steal its delta (src/elu.js).
 *
 * The cached ELU starts at 0 -- nothing measured yet, so admit.
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
