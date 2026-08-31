// test/timing.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTimer } from '../src/timing.js';

test('measures a sync phase', () => {
  // `>= 0` cannot fail: a timer that returned a hardcoded 0, or never ran the
  // callback at all, passed it. Bound the measurement against a block of known
  // duration instead, the same way the async cases do. Lower bound 0.004 s for a
  // 5 ms spin (clock granularity), upper bound 0.1 s to catch a ms/s unit slip.
  const t = createTimer();
  t.measureSync('cpu', () => { const end = Date.now() + 5; while (Date.now() < end); });
  const cpu = t.phases().cpu;
  assert.ok(cpu >= 0.004 && cpu < 0.1, `cpu was ${cpu}, expected ~0.005 s`);
});

test('measures an async phase and returns its value', async () => {
  const t = createTimer();
  const v = await t.measure('db', async () => { await new Promise(r => setTimeout(r, 12)); return 'ok'; });
  assert.equal(v, 'ok');
  assert.ok(t.phases().db >= 0.010, `expected >=0.010s, got ${t.phases().db}`);
});

test('records the phase even when the function throws', async () => {
  const t = createTimer();
  await assert.rejects(() => t.measure('db', async () => { throw new Error('boom'); }));
  assert.ok(t.phases().db >= 0);
});

test('phases() reports seconds, and sums repeated marks of the same name', async () => {
  const t = createTimer();
  await t.measure('db', async () => { const end = Date.now() + 12; while (Date.now() < end); });
  await t.measure('db', async () => { const end = Date.now() + 8;  while (Date.now() < end); });
  t.measureSync('cpu', () => { const end = Date.now() + 5; while (Date.now() < end); });

  const p = t.phases();
  // Seconds, not milliseconds: recordRequest feeds these straight into a
  // histogram whose unit is 's'. A 1000x error here is invisible until a
  // Grafana panel reads 20 seconds of database time per request.
  assert.ok(p.db >= 0.019 && p.db < 0.1, `db was ${p.db}, expected ~0.020 s`);
  assert.ok(p.cpu >= 0.004 && p.cpu < 0.1, `cpu was ${p.cpu}, expected ~0.005 s`);
});

test('phases() is empty when nothing was measured', () => {
  assert.deepEqual(createTimer().phases(), {});
});

test('header() is gone -- measurement no longer leaves over HTTP', () => {
  assert.equal(createTimer().header, undefined);
});
