// test/stats.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, resetStats } from '../src/stats.js';

test('snapshot exposes the documented shape', () => {
  const s = snapshot();
  for (const k of ['p50', 'p90', 'p99', 'max', 'mean']) {
    assert.equal(typeof s.eventLoopDelayMs[k], 'number', `missing ${k}`);
    assert.ok(Number.isFinite(s.eventLoopDelayMs[k]), `${k} not finite`);
  }
  assert.equal(typeof s.memoryMb.rss, 'number');
  assert.equal(typeof s.uptimeSeconds, 'number');
});

test('reports lag in milliseconds, not nanoseconds', async () => {
  await new Promise(r => setTimeout(r, 60));
  const s = snapshot();
  assert.ok(s.eventLoopDelayMs.max < 1000, `max ${s.eventLoopDelayMs.max} looks like ns, not ms`);
});

test('resetStats clears the histogram', async () => {
  await new Promise(r => setTimeout(r, 40));
  resetStats();
  assert.ok(snapshot().eventLoopDelayMs.max >= 0);
});

/** Blocks the event loop synchronously so monitorEventLoopDelay records real lag once freed. */
function blockFor(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy */ }
}

/**
 * Generates real, measurable event-loop lag: repeated synchronous stalls with a `setImmediate`
 * yield between each, so the delay histogram's own sampling timer gets a turn to observe each
 * stall (a single very long uninterrupted block starves that sampling timer along with
 * everything else and under-reports itself — chunking is what makes the lag land in the
 * histogram, the same way real request-by-request CPU work would).
 */
async function generateLag({ chunks = 15, chunkMs = 25 } = {}) {
  for (let i = 0; i < chunks; i++) {
    blockFor(chunkMs);
    await new Promise((r) => setImmediate(r));
  }
}

test('a reset window reports a lower max after idle than after real lag', async () => {
  resetStats();
  await generateLag();
  const busy = snapshot({ reset: true });
  assert.ok(busy.eventLoopDelayMs.max > 20, `expected a high max after real lag, got ${busy.eventLoopDelayMs.max}`);

  await new Promise((r) => setTimeout(r, 300)); // go fully idle
  const idle = snapshot();
  assert.ok(
    idle.eventLoopDelayMs.max < busy.eventLoopDelayMs.max,
    `idle max ${idle.eventLoopDelayMs.max} should be lower than busy max ${busy.eventLoopDelayMs.max} — ` +
      'this is the assertion an un-reset, since-boot-only histogram would have failed',
  );
});

test('sinceBoot never undercounts the current window', async () => {
  await generateLag();
  const s = snapshot();
  assert.ok(s.sinceBoot.max >= s.eventLoopDelayMs.max);
});

test('snapshot() with no argument does not reset', async () => {
  resetStats();
  await generateLag();
  const first = snapshot();
  const second = snapshot();
  assert.equal(second.eventLoopDelayMs.max, first.eventLoopDelayMs.max, 'default snapshot() must be non-destructive');
});
