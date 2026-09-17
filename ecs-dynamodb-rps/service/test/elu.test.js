// test/elu.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createEluSampler } from '../src/elu.js';

// Synchronous work the event loop cannot interrupt: the loop is 100% active for `ms`.
function block(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

test('a deliberately blocked loop reads close to 1', () => {
  const elu = createEluSampler();
  block(200);
  const u = elu.sample();
  assert.ok(u > 0.9, `blocked loop read ${u}`);
});

test('an idle loop reads close to 0', async () => {
  const elu = createEluSampler();
  await sleep(200);
  const u = elu.sample();
  assert.ok(u < 0.2, `idle loop read ${u}`);
});

test('successive calls do not double-count: an idle window after a blocked one reads idle', async () => {
  const elu = createEluSampler();
  block(200);
  const busy = elu.sample();
  await sleep(200);
  const idle = elu.sample();
  assert.ok(busy > 0.9, `blocked window read ${busy}`);
  // A cumulative (since-boot or since-construction) reading would be ~0.5 here.
  assert.ok(idle < 0.2, `idle window after a blocked one read ${idle}`);
});

test('each sampler keeps its own window, so two consumers do not steal each other\'s delta', async () => {
  const a = createEluSampler();
  const b = createEluSampler();
  block(200);
  const aBusy = a.sample();     // a's window closes here; b's stays open
  await sleep(200);
  const bSpan = b.sample();     // b spans blocked + idle
  assert.ok(aBusy > 0.9, `a read ${aBusy}`);
  assert.ok(bSpan > 0.3 && bSpan < 0.8, `b should span both halves, read ${bSpan}`);
});

test('computes the delta from the injected performance clock', () => {
  // Fake with the same contract as perf_hooks: eventLoopUtilization(cur, prev)
  // returns cur minus prev. Readings are cumulative { idle, active } in ms.
  const readings = [
    { idle: 100, active: 100 },  // construction
    { idle: 100, active: 400 },  // +300 active, +0 idle   -> 1.0
    { idle: 400, active: 500 },  // +100 active, +300 idle -> 0.25
  ];
  let i = 0;
  const performance = {
    eventLoopUtilization(cur, prev) {
      if (!cur) return readings[i++];
      const idle = cur.idle - prev.idle;
      const active = cur.active - prev.active;
      return { idle, active, utilization: active / (idle + active) };
    },
  };
  const elu = createEluSampler({ performance });
  assert.equal(elu.sample(), 1);
  assert.equal(elu.sample(), 0.25);
});

test('an empty window reads 0, never NaN', () => {
  const r = { idle: 5, active: 5 };
  const performance = {
    eventLoopUtilization(cur, prev) {
      if (!cur) return r;
      return { idle: 0, active: 0, utilization: NaN };
    },
  };
  assert.equal(createEluSampler({ performance }).sample(), 0);
});
