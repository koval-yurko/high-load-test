// test/timing.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTimer } from '../src/timing.js';

test('empty timer produces an empty header', () => {
  assert.equal(createTimer().header(), '');
});

test('measures a sync phase and formats it', () => {
  const t = createTimer();
  t.measureSync('cpu', () => { for (let i = 0; i < 1e5; i++); });
  assert.match(t.header(), /^cpu;dur=\d+\.\d{3}$/);
});

test('measures an async phase and returns its value', async () => {
  const t = createTimer();
  const v = await t.measure('db', async () => { await new Promise(r => setTimeout(r, 12)); return 'ok'; });
  assert.equal(v, 'ok');
  const ms = Number(t.header().match(/dur=([\d.]+)/)[1]);
  assert.ok(ms >= 10, `expected >=10ms, got ${ms}`);
});

test('accumulates repeated phases and joins with a comma', () => {
  const t = createTimer();
  t.measureSync('db', () => {}); t.measureSync('db', () => {}); t.measureSync('cpu', () => {});
  const h = t.header();
  assert.equal(h.split(', ').length, 2);
  assert.ok(h.includes('db;dur='));
  assert.ok(h.includes('cpu;dur='));
});

test('records the phase even when the function throws', async () => {
  const t = createTimer();
  await assert.rejects(() => t.measure('db', async () => { throw new Error('boom'); }));
  assert.ok(t.header().startsWith('db;dur='));
});
