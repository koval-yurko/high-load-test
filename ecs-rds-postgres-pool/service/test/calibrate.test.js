import test from 'node:test';
import assert from 'node:assert/strict';
import { searchScanRows, solveKnobs, readMix } from '../scripts/calibrate.js';

/** Hold time rises linearly with rows: 200 rows per millisecond. */
const linear = async (rows) => rows / 200;

test('finds the row count that hits the target hold time', async () => {
  const r = await searchScanRows({ measure: linear, targetMs: 20, lo: 0, hi: 100_000, tolerance: 0.5 });
  assert.ok(Math.abs(r.ms - 20) <= 0.5, `got ${r.ms} ms at ${r.rows} rows`);
  assert.ok(r.rows > 3800 && r.rows < 4200, `expected ~4000 rows, got ${r.rows}`);
});

test('it terminates rather than spinning when the target is unreachable', async () => {
  const r = await searchScanRows({ measure: async () => 1, targetMs: 500, lo: 0, hi: 1000, tolerance: 0.5 });
  assert.ok(r.iterations <= 20, `binary search must bound its iterations, took ${r.iterations}`);
  assert.equal(r.rows, 1000, 'an unreachable target pins at the top of the range');
});

test('landing inside the tolerance band does not discard a closer earlier probe', async () => {
  // The opening probe at `hi` is the one case the tolerance check never sees,
  // so it is the one that used to be thrown away: the search returned whichever
  // mid happened to stop it, even when `hi` had measured nearer the target.
  // Here 1000 rows hits 20 ms exactly and 500 rows misses by 4, inside a
  // tolerance of 5.
  const stepped = async (rows) => (rows === 1000 ? 20 : 24);
  const r = await searchScanRows({ measure: stepped, targetMs: 20, lo: 0, hi: 1000, tolerance: 5 });
  assert.equal(r.rows, 1000, 'the closest probe wins, not the one that tripped the tolerance');
  assert.equal(r.ms, 20);
});

test('it reports how many probes it took, so a noisy measurement is visible', async () => {
  const r = await searchScanRows({ measure: linear, targetMs: 20, lo: 0, hi: 100_000, tolerance: 0.5 });
  assert.ok(r.iterations > 0);
});

const MIX = { read: 0.55, write: 0.15, feed: 0.25, report: 0.05 };
const SPEC = { mix: MIX, poolSize: 5, vcpus: 2, targetMeanHoldMs: 20, targetCpuRelative: 0.5 };

test('the CPU fraction comes from the pool and the vCPUs, not from the knee', () => {
  const r = solveKnobs({ holds: { read: 1, write: 1, feed: 2, report: 0 }, ...SPEC });
  // 0.5 x 2 / 5: at most a fifth of each hold may be the database working, or
  // the database saturates before the pool does.
  assert.equal(r.cpuFraction, 0.2);
});

test('it solves the two knobs so that mean hold and database CPU both land on target', () => {
  const holds = { read: 1, write: 1, feed: 2, report: 0 };
  const r = solveKnobs({ holds, ...SPEC });
  const lightHold = 0.55 * 1 + 0.15 * 1 + 0.25 * 2;          // 1.2 ms
  assert.equal(r.lightHoldMs, lightHold);
  // mean hold 20 ms  =>  0.05 x reportHold + 1.2  =>  reportHold = 376 ms
  assert.ok(Math.abs(r.reportHoldMs - 376) < 1e-9, `got ${r.reportHoldMs}`);
  // mean db cpu 4 ms =>  0.05 x reportCpu  + 1.2  =>  reportCpu  = 56 ms
  assert.ok(Math.abs(r.reportCpuMs - 56) < 1e-9, `got ${r.reportCpuMs}`);
  assert.ok(Math.abs(r.sleepMs - 320) < 1e-9, `got ${r.sleepMs}`);
  assert.equal(r.feasible, true);
});

test('the knee it predicts is the one the spec derives', () => {
  const r = solveKnobs({ holds: { read: 1, write: 1, feed: 2, report: 0 }, ...SPEC });
  assert.equal(r.kneeRps, 250);   // pool 5 / 20 ms
});

test('light routes that already exceed the CPU budget are reported, not squeezed', () => {
  // 5 ms per light route puts mean light CPU at 5 ms against a 4 ms budget:
  // no report cost can fix that, and a negative scan row count is not an answer.
  const r = solveKnobs({ holds: { read: 5, write: 5, feed: 5, report: 0 }, ...SPEC });
  assert.equal(r.feasible, false);
  assert.match(r.reason, /light routes/i);
  assert.ok(r.reportCpuMs < 0, 'the arithmetic is still reported, so the gap is visible');
});

test('a mix missing a share is refused rather than treated as zero', () => {
  assert.throws(() => solveKnobs({ holds: { read: 1, write: 1, feed: 2, report: 0 },
    ...SPEC, mix: { read: 0.55, write: 0.15, feed: 0.25 } }), /report/);
});

test('the mix comes from CAPACITY_MIX when the container has no slo.yaml', () => {
  const mix = readMix({ CAPACITY_MIX: '{"read":0.55,"write":0.15,"feed":0.25,"report":0.05}' });
  assert.deepEqual(mix, { read: 0.55, write: 0.15, feed: 0.25, report: 0.05 });
});

test('a malformed CAPACITY_MIX fails loudly rather than silently mis-sizing the experiment', () => {
  assert.throws(() => readMix({ CAPACITY_MIX: 'not json' }), /CAPACITY_MIX/);
});

test('the four shares must all be present, because solveKnobs divides by the report share', () => {
  assert.throws(() => readMix({ CAPACITY_MIX: '{"read":0.55,"write":0.15,"feed":0.25}' }), /report/);
});

test('without CAPACITY_MIX it says where the value comes from', () => {
  assert.throws(() => readMix({}), /slo\.yaml/);
});
