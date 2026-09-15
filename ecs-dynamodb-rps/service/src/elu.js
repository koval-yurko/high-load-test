// src/elu.js
// Event-loop utilization (ELU): the fraction of wall time the loop spent doing
// work rather than waiting in the poll phase, 0..1. It saturates in seconds under
// overload, where CPU utilization on a 0.25 vCPU slice read 3-16% while the loop
// was pinned (2026-09-01) -- which is why it drives scaling (spike-response spec §5).
import { performance as nodePerformance } from 'node:perf_hooks';

/**
 * A factory, deliberately with no module-level state. Each sampler keeps its OWN
 * previous reading, so sample() returns utilization over the window since that
 * instance's last call. A shared module-level "previous" would let a second
 * consumer (admission control) close the scaler's window early and steal its
 * delta -- each would see only the slice since the other last looked.
 *
 * The window starts at construction, so the first sample() covers
 * construction -> now.
 */
export function createEluSampler({ performance = nodePerformance } = {}) {
  let prev = performance.eventLoopUtilization();
  return {
    sample() {
      const now = performance.eventLoopUtilization();
      // eventLoopUtilization(a, b) is the difference a - b: this window only,
      // never cumulative, so successive calls do not double-count.
      const { utilization } = performance.eventLoopUtilization(now, prev);
      prev = now;
      // Two calls inside the same tick produce an empty window (0/0). An idle
      // reading is the honest answer; NaN would poison an Average statistic.
      return Number.isFinite(utilization) ? utilization : 0;
    },
  };
}
