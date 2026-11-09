'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { erlangB, minConcurrency, maxRate, rcuPerRequest } = require('../scripts/capacity');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('Erlang B textbook values', () => {
  close(erlangB(1, 1), 0.5);
  close(erlangB(2, 1), 0.2);
  close(erlangB(0, 5), 1);
});

test('Erlang B values the spec quotes', () => {
  close(erlangB(20, 20), 0.158892);
  close(erlangB(100, 100), 0.075700);
  close(erlangB(20, 60), 0.674447);
});

test('max rate at B <= 0.5% and d = 0.2 s', () => {
  assert.equal(Math.floor(maxRate(20, 0.2, 0.005)), 55);
  assert.equal(Math.floor(maxRate(100, 0.2, 0.005)), 404);
  assert.ok(erlangB(20, maxRate(20, 0.2, 0.005) * 0.2) <= 0.005);
});

test('smallest concurrency for A = 60 at B <= 0.5% is 78', () => {
  assert.equal(minConcurrency(60, 0.005), 78);
});

test('RCU per request for the default seed and mix is 1.6', () => {
  const params = { itemsPerFeed: 20, itemsPerReport: 100, itemBytes: 1024 };
  close(rcuPerRequest(params, { fast: 0.70, standard: 0.25, heavy: 0.05 }), 1.6);
});
