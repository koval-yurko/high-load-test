'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../src/handler');

const items = { 'feed-0001/item-0002': { pk: 'feed-0001', sk: 'item-0002', body: 'x' } };
const parts = { 'feed-0001': [{ sk: 'item-0000' }, { sk: 'item-0001' }], 'report-001': [{ sk: 'row-0000' }] };
const repo = {
  async getItem(pk, sk) { return items[`${pk}/${sk}`] ?? null; },
  async queryAll(pk) { return parts[pk] ?? []; },
};
const handle = createHandler({ repo, config: { heavyCpuIterations: 10 } });
const ev = (resource, pathParameters) => ({ httpMethod: 'GET', resource, pathParameters });

test('fast route returns the item', async () => {
  const r = await handle(ev('/items/{pk}/{sk}', { pk: 'feed-0001', sk: 'item-0002' }));
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).sk, 'item-0002');
});

test('standard route returns the partition items', async () => {
  const r = await handle(ev('/feeds/{pk}', { pk: 'feed-0001' }));
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).items.length, 2);
});

test('heavy route returns a count and a digest, not the items', async () => {
  const r = await handle(ev('/reports/{pk}', { pk: 'report-001' }));
  assert.equal(r.statusCode, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.count, 1);
  assert.match(body.digest, /^[0-9a-f]{16}$/);
});

test('an unseeded key or partition is 404', async () => {
  assert.equal((await handle(ev('/items/{pk}/{sk}', { pk: 'feed-9999', sk: 'item-0000' }))).statusCode, 404);
  assert.equal((await handle(ev('/feeds/{pk}', { pk: 'feed-9999' }))).statusCode, 404);
  assert.equal((await handle(ev('/reports/{pk}', { pk: 'report-999' }))).statusCode, 404);
});

test('an unknown route or method is 404', async () => {
  assert.equal((await handle(ev('/nope', {}))).statusCode, 404);
  assert.equal((await handle({ httpMethod: 'POST', resource: '/feeds/{pk}', pathParameters: { pk: 'feed-0001' } })).statusCode, 404);
});

test('a repo error is a 500 with a fixed body and one log line naming the error', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (line) => logged.push(line));
  const err = Object.assign(new Error('secret detail'), { name: 'ProvisionedThroughputExceededException' });
  const failing = createHandler({ repo: { getItem: async () => { throw err; } }, config: { heavyCpuIterations: 0 } });
  const r = await failing(ev('/items/{pk}/{sk}', { pk: 'a', sk: 'b' }));
  assert.equal(r.statusCode, 500);
  assert.deepEqual(JSON.parse(r.body), { error: 'internal' });
  assert.equal(logged.length, 1);
  assert.equal(JSON.parse(logged[0]).error, 'ProvisionedThroughputExceededException');
  assert.doesNotMatch(r.body, /secret detail/);
});
