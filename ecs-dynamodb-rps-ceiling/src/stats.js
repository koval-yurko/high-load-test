// src/stats.js
import { monitorEventLoopDelay } from 'node:perf_hooks';

const NS_PER_MS = 1e6;

// Two independent histograms track the same event loop: `windowHistogram` is reset on every
// scraped snapshot so it reports a clean per-window figure (the /stats handler resets it), while
// `bootHistogram` is never reset and keeps the cumulative since-boot view so that resetting the
// window loses no information.
const windowHistogram = monitorEventLoopDelay({ resolution: 10 });
windowHistogram.enable();
const bootHistogram = monitorEventLoopDelay({ resolution: 10 });
bootHistogram.enable();

function readHistogram(h) {
  return {
    p50: h.percentile(50) / NS_PER_MS,
    p90: h.percentile(90) / NS_PER_MS,
    p99: h.percentile(99) / NS_PER_MS,
    max: h.max / NS_PER_MS,
    mean: (Number.isFinite(h.mean) ? h.mean : 0) / NS_PER_MS,
  };
}

/**
 * @param {{ reset?: boolean }} [opts] - when reset is true, the window histogram is cleared
 *   *after* being read, so the next snapshot starts a fresh window. Default is non-destructive.
 */
export function snapshot({ reset = false } = {}) {
  const mem = process.memoryUsage();
  const eventLoopDelayMs = readHistogram(windowHistogram);
  const sinceBoot = readHistogram(bootHistogram);
  if (reset) windowHistogram.reset();
  return {
    eventLoopDelayMs,
    sinceBoot,
    memoryMb: {
      rss: mem.rss / 1048576,
      heapUsed: mem.heapUsed / 1048576,
    },
    uptimeSeconds: process.uptime(),
  };
}

export function resetStats() { windowHistogram.reset(); }
