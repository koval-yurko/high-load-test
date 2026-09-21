import test from 'node:test';
import assert from 'node:assert/strict';
import { searchScanRows } from '../scripts/calibrate.js';

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
