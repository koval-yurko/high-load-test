// src/elu.js
// Forked from ecs-dynamodb-rps/service/src/elu.js on 2026-09-20, unchanged.
// A bug fixed here does not reach the sibling copy; fix both.
// Event-loop utilization (ELU): the fraction of wall time the loop spent doing
// work rather than waiting in the poll phase, 0..1. It saturates in seconds
// under overload, well before CPU utilization on a small Fargate slice does --
// which is why it drives scaling.
import { performance as nodePerformance } from 'node:perf_hooks';

/**
 * A factory with no module-level state: each sampler keeps its OWN previous
 * reading, so a shared "previous" can't let one consumer (e.g. admission
 * control) close another's window early and steal its delta.
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
