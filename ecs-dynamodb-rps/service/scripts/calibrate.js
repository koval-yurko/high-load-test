import { burn } from '../src/cpu.js';

/** Binary-search the iteration count whose cost is closest to targetMs on THIS cpu. */
export function iterationsFor(targetMs, { lo = 1, hi = 200000, samples = 7 } = {}) {
  const cost = (n) => {
    const runs = [];
    for (let i = 0; i < samples; i++) {
      const t0 = process.hrtime.bigint();
      burn(n, `calibrate-${i}`);
      runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    runs.sort((a, b) => a - b);
    return runs[Math.floor(runs.length / 2)]; // median, to shrug off scheduler noise
  };

  burn(2000, 'warmup');
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (cost(mid) < targetMs) lo = mid; else hi = mid;
  }
  return lo;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = Number(process.argv[2] || 1.4);
  const n = iterationsFor(target);
  console.log(JSON.stringify({ targetMs: target, iterations: n }));
}
