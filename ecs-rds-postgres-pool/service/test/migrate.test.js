import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateWithRetry } from '../src/migrate.js';

const P1001 = { status: 1, output: 'Error: P1001: Can\'t reach database server' };
const OK = { status: 0, output: 'done' };
const opts = (results, extra = {}) => {
  let t = 0;
  const calls = [];
  return {
    calls,
    o: { run: () => { calls.push(1); return results.shift(); }, sleep: async (ms) => { t += ms; },
         now: () => t, log: () => {}, timeoutMs: 60_000, intervalMs: 10_000, ...extra },
  };
};

test('retries P1001 until the database answers', async () => {
  const { o, calls } = opts([P1001, P1001, OK]);
  assert.equal(await migrateWithRetry(o), 3);
  assert.equal(calls.length, 3);
});

test('does not retry any other failure', async () => {
  const { o, calls } = opts([{ status: 1, output: 'Error: P3009 migration failed' }]);
  await assert.rejects(() => migrateWithRetry(o), /exit 1, attempt 1/);
  assert.equal(calls.length, 1);
});

test('gives up when P1001 outlasts the timeout', async () => {
  const { o, calls } = opts(Array(20).fill(P1001));
  await assert.rejects(() => migrateWithRetry(o), /failed/);
  assert.equal(calls.length, 7); // attempts at t = 0..60s; the last one sees no room for another sleep
});
