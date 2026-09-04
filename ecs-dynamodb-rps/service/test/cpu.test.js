// test/cpu.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { burn } from '../src/cpu.js';

test('returns empty string when disabled', () => {
  assert.equal(burn(0, 'x'), '');
  assert.equal(burn(-5, 'x'), '');
});

test('is deterministic for the same seed and iterations', () => {
  assert.equal(burn(50, 'abc'), burn(50, 'abc'));
});

test('differs for different seeds', () => {
  assert.notEqual(burn(50, 'abc'), burn(50, 'def'));
});

test('returns a 16-char hex digest', () => {
  assert.match(burn(50, 'abc'), /^[0-9a-f]{16}$/);
});

test('cost scales with iteration count', () => {
  const time = (n) => { const t0 = process.hrtime.bigint(); burn(n, 's'); return Number(process.hrtime.bigint() - t0); };
  time(2000);                                    // warm up, ignore result
  assert.ok(time(20000) > time(2000) * 3, '20k iterations should cost well over 3x 2k');
});
