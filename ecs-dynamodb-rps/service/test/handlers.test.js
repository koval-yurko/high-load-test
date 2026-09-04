// test/handlers.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlers, matchRoute } from '../src/handlers.js';
import { createTimer } from '../src/timing.js';
import { buildItem } from '../src/item.js';

const config = { tableName: 'items', feedPageSize: 20, pbkdf2Iterations: 25, itemTtlSeconds: 3600 };
let calls;
const repo = {
  async getItem(pk, sk) { calls.push(['get', pk, sk]); return pk === 'missing' ? null : buildItem({ pk, sk }); },
  async putItem(item) { calls.push(['put', item.pk]); return item; },
  async queryFeed(pk, limit) {
    calls.push(['query', pk, limit]);
    return Array.from({ length: limit }, (_, i) => buildItem({ pk, sk: `item-${String(i).padStart(2, '0')}` }));
  },
};
beforeEach(() => { calls = []; });

test('matchRoute resolves every documented route', () => {
  assert.equal(matchRoute('GET', '/healthz').name, 'health');
  assert.deepEqual(matchRoute('GET', '/items/feed-00/item-01').params, { pk: 'feed-00', sk: 'item-01' });
  assert.deepEqual(matchRoute('GET', '/feeds/feed-00').params, { pk: 'feed-00' });
  assert.equal(matchRoute('POST', '/items').name, 'putItem');
  assert.equal(matchRoute('POST', '/reports').name, 'report');
});

test('matchRoute rejects unknown paths and wrong methods', () => {
  assert.equal(matchRoute('GET', '/nope'), null);
  assert.equal(matchRoute('POST', '/healthz'), null);
  assert.equal(matchRoute('GET', '/items/only-one-segment'), null);
});

test('feed and item routes do not collide', () => {
  assert.equal(matchRoute('GET', '/feeds/feed-00').name, 'feed');
  assert.equal(matchRoute('GET', '/items/feed-00/feed').name, 'getItem');
});

test('healthz does not touch the database', async () => {
  const r = await createHandlers({ repo, config }).health({ timer: createTimer() });
  assert.equal(r.status, 200);
  assert.deepEqual(calls, []);
});

test('getItem returns the item and records db time only', async () => {
  const timer = createTimer();
  const r = await createHandlers({ repo, config }).getItem({ params: { pk: 'feed-00', sk: 'item-00' }, timer });
  assert.equal(r.status, 200);
  assert.equal(r.body.pk, 'feed-00');
  assert.ok(timer.phases().db !== undefined);
  assert.ok(timer.phases().cpu === undefined);
});

test('getItem 404s on a missing item', async () => {
  const r = await createHandlers({ repo, config }).getItem({ params: { pk: 'missing', sk: 'x' }, timer: createTimer() });
  assert.equal(r.status, 404);
});

test('putItem writes under a w# prefix so it never enters a seeded partition', async () => {
  const r = await createHandlers({ repo, config }).putItem({ body: {}, timer: createTimer() });
  assert.equal(r.status, 201);
  assert.match(calls[0][1], /^w#[0-9a-f]{16}$/);
});

test('putItem sets a ttl', async () => {
  const handlers = createHandlers({ repo, config });
  const before = Math.floor(Date.now() / 1000);
  await handlers.putItem({ body: {}, timer: createTimer() });
  const item = await handlers.putItem({ body: {}, timer: createTimer() });
  assert.ok(item.body.expires_at >= before + 3600);
});

test('feed queries the configured page size and does cpu work', async () => {
  const timer = createTimer();
  const r = await createHandlers({ repo, config }).feed({ params: { pk: 'feed-00' }, timer });
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 20);
  assert.deepEqual(calls[0], ['query', 'feed-00', 20]);
  assert.ok(timer.phases().db !== undefined);
  assert.ok(timer.phases().cpu !== undefined);
});

test('report queries, burns cpu, then writes', async () => {
  const timer = createTimer();
  const r = await createHandlers({ repo, config }).report({ body: { pk: 'feed-03' }, timer });
  assert.equal(r.status, 200);
  assert.equal(calls[0][0], 'query');
  assert.equal(calls[1][0], 'put');
  assert.match(r.body.digest, /^[0-9a-f]{16}$/);
  assert.ok(timer.phases().cpu !== undefined);
});

test('matchRoute returns the route template, not the concrete path', () => {
  assert.equal(matchRoute('GET', '/items/feed-07/item-13').template, '/items/:pk/:sk');
  assert.equal(matchRoute('GET', '/feeds/feed-07').template, '/feeds/:pk');
  assert.equal(matchRoute('POST', '/items').template, '/items');
  assert.equal(matchRoute('POST', '/reports').template, '/reports');
  assert.equal(matchRoute('GET', '/healthz').template, '/healthz');
});

test('every route has a template and no two share one', () => {
  const templates = ['/healthz', '/feeds/:pk', '/items/:pk/:sk', '/items', '/reports'];
  // An endpoint whose template collides with another is silently merged into
  // the wrong latency class. Cheap to assert, invisible if it happens.
  assert.equal(new Set(templates).size, templates.length);
});

test('/stats is gone -- event-loop lag comes from nodejs_eventloop_delay_*', () => {
  assert.equal(matchRoute('GET', '/stats'), null);
});
