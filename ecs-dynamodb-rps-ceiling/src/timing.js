// src/timing.js
import { performance } from 'node:perf_hooks';

export function createTimer() {
  const marks = new Map();
  const add = (name, ms) => marks.set(name, (marks.get(name) ?? 0) + ms);

  return {
    async measure(name, fn) {
      const t0 = performance.now();
      try { return await fn(); } finally { add(name, performance.now() - t0); }
    },
    measureSync(name, fn) {
      const t0 = performance.now();
      try { return fn(); } finally { add(name, performance.now() - t0); }
    },
    /**
     * Marks in SECONDS, because that is the unit of the histograms in otel.js.
     * The conversion lives here, once, rather than at every call site.
     */
    phases() {
      const out = {};
      for (const [name, ms] of marks) out[name] = ms / 1000;
      return out;
    },
  };
}
