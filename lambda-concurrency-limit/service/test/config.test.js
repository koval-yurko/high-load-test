'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

test('reads TABLE_NAME and HEAVY_CPU_ITERATIONS', () => {
  assert.deepEqual(loadConfig({ TABLE_NAME: 't', HEAVY_CPU_ITERATIONS: '5000' }),
    { tableName: 't', heavyCpuIterations: 5000 });
});

test('HEAVY_CPU_ITERATIONS defaults to 0', () => {
  assert.equal(loadConfig({ TABLE_NAME: 't' }).heavyCpuIterations, 0);
});

test('a missing TABLE_NAME fails at load, naming the variable', () => {
  assert.throws(() => loadConfig({}), /TABLE_NAME/);
});

test('a non-integer or negative HEAVY_CPU_ITERATIONS fails, naming the variable', () => {
  for (const v of ['-1', '1.5', 'abc'])
    assert.throws(() => loadConfig({ TABLE_NAME: 't', HEAVY_CPU_ITERATIONS: v }), /HEAVY_CPU_ITERATIONS/);
});
