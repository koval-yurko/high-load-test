import { CLASS_THRESHOLD_MS, MIX } from './slo.js';

// Random arrivals by thinning. k6's constant-arrival-rate starts iterations at even
// intervals, which rarely collide and would show far fewer throttles than Erlang B
// predicts. Running at 4x the target and sending each iteration with p = 0.25 gives
// gaps with CV = sqrt(1 - p) = 0.87 (Poisson is 1, even arrivals 0).
// shortcut: p = 0.25 gives CV 0.87, not 1; lower p (more oversampling) if measured
// throttles stay well below the Erlang B prediction.
export const OVERSAMPLE = 4;
export const SEND_PROBABILITY = 1 / OVERSAMPLE;

export const iterationRate = (targetRps) => Math.round(targetRps * OVERSAMPLE);
export const shouldSend = (random = Math.random) => random() < SEND_PROBABILITY;

// Grafana Cloud k6 refuses an upload above 100 VUs (E2004, an organization cap). k6 counts the
// VUs of every scenario that can run at the same time, so a profile with parallel scenarios
// splits the cap between them (the `cap` argument).
export const VU_CAP = 100;
// Little's law: busy VUs = sent rate × mean latency. The mean is the mix-weighted class threshold
// from slo.yaml, an upper bound for a run that meets its SLO; × 2 is room for random bunching.
// Skipped iterations (3 in 4) end at once and hold no VU.
export const MEAN_SECONDS = Object.keys(MIX).reduce((s, c) => s + MIX[c] * CLASS_THRESHOLD_MS[c], 0) / 1000;
// shortcut: at the cap, a run needs rate × mean client latency ≤ cap (the × 2 is headroom, not the
// limit); past that, dropped_iterations fails the run (a gated threshold), so it can never pass.
export function vus(targetRps, cap = VU_CAP) {
  const n = Math.min(cap, Math.max(5, Math.ceil(2 * targetRps * MEAN_SECONDS)));
  return { preAllocatedVUs: n, maxVUs: n };
}
