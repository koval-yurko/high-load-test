import test from 'node:test';
import assert from 'node:assert/strict';
import { runInRequestContext, currentRequest } from '../src/context.js';

test('outside a request there is no context', () => {
  assert.equal(currentRequest(), undefined);
});

test('the context is visible synchronously inside the callback', () => {
  runInRequestContext({ route: '/posts', class: 'fast' }, () => {
    assert.deepEqual(currentRequest(), { route: '/posts', class: 'fast' });
  });
});

test('the context survives an await boundary', async () => {
  await runInRequestContext({ route: '/reports', class: 'heavy' }, async () => {
    await new Promise((r) => setTimeout(r, 1));
    assert.deepEqual(currentRequest(), { route: '/reports', class: 'heavy' });
  });
});

test('concurrent requests do not see each other', async () => {
  const seen = [];
  const one = runInRequestContext({ route: '/a', class: 'fast' }, async () => {
    await new Promise((r) => setTimeout(r, 5));
    seen.push(currentRequest().route);
  });
  const two = runInRequestContext({ route: '/b', class: 'heavy' }, async () => {
    await new Promise((r) => setTimeout(r, 1));
    seen.push(currentRequest().route);
  });
  await Promise.all([one, two]);
  assert.deepEqual(seen, ['/b', '/a']);
});

test('the context is gone again after the callback resolves', async () => {
  await runInRequestContext({ route: '/a', class: 'fast' }, async () => {});
  assert.equal(currentRequest(), undefined);
});
