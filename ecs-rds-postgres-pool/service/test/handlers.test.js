import test from 'node:test';
import assert from 'node:assert/strict';
import { matchRoute, createHandlers, ROUTE_CLASS } from '../src/handlers.js';
import { createTimer } from '../src/timing.js';

const config = { feedPageSize: 20, reportScanRows: 0, seedFeeds: 16 };

function fakeRepo() {
  return {
    calls: [],
    async getPost(id) { this.calls.push('getPost'); return id === 9999 ? null : { id, body: 'x' }; },
    async createPost(p) { this.calls.push('createPost'); return { id: 1, ...p }; },
    async feedPage(feedId, n) {
      this.calls.push('feedPage');
      return Array.from({ length: 3 }, (_, i) => ({ id: i, feed_id: feedId, body: 'xy', score: i, feed_name: 'f' }));
    },
    async report({ scanRows }) { this.calls.push('report'); return { n: scanRows, bytes: 1, feeds: 2, avgScore: 0, recordId: 7 }; },
  };
}

test('routes match on the template, not the concrete path', () => {
  assert.equal(matchRoute('GET', '/posts/42').template, '/posts/:id');
  assert.deepEqual(matchRoute('GET', '/posts/42').params, { id: '42' });
  assert.equal(matchRoute('GET', '/feeds/3/posts').template, '/feeds/:id/posts');
  assert.deepEqual(matchRoute('GET', '/feeds/3/posts').params, { id: '3' });
  assert.equal(matchRoute('POST', '/posts').name, 'createPost');
  assert.equal(matchRoute('POST', '/reports').name, 'report');
  assert.equal(matchRoute('GET', '/healthz').name, 'health');
  assert.equal(matchRoute('DELETE', '/posts'), null);
  assert.equal(matchRoute('GET', '/nope'), null);
});

test('every non-health route has a latency class', () => {
  assert.deepEqual(ROUTE_CLASS, {
    getPost: 'fast', createPost: 'fast', feed: 'standard', report: 'heavy',
  });
});

test('getPost returns 404 for a missing row', async () => {
  const h = createHandlers({ repo: fakeRepo(), config });
  const res = await h.getPost({ params: { id: '9999' }, timer: createTimer() });
  assert.equal(res.status, 404);
});

test('a non-numeric post id is 400, not a database round trip', async () => {
  const repo = fakeRepo();
  const res = await createHandlers({ repo, config }).getPost({ params: { id: 'abc' }, timer: createTimer() });
  assert.equal(res.status, 400);
  assert.equal(repo.calls.length, 0, 'a malformed id must not reach the pool');
});

test('getPost records a db phase', async () => {
  const timer = createTimer();
  await createHandlers({ repo: fakeRepo(), config }).getPost({ params: { id: '1' }, timer });
  assert.ok('db' in timer.phases());
});

test('createPost returns 201 and the created row', async () => {
  const res = await createHandlers({ repo: fakeRepo(), config }).createPost({ timer: createTimer() });
  assert.equal(res.status, 201);
  assert.ok(Number.isInteger(res.body.id));
});

test('feed summarises the page in a cpu phase', async () => {
  const timer = createTimer();
  const res = await createHandlers({ repo: fakeRepo(), config }).feed({ params: { id: '3' }, timer });
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 3);
  assert.equal(res.body.bytes, 6);
  const p = timer.phases();
  assert.ok('db' in p && 'cpu' in p);
});

test('report takes exactly one repository call', async () => {
  const repo = fakeRepo();
  const res = await createHandlers({ repo, config: { ...config, reportScanRows: 100 } })
    .report({ body: { feedId: 2 }, timer: createTimer() });
  assert.equal(res.status, 200);
  assert.equal(res.body.scanned, 100);
  assert.deepEqual(repo.calls, ['report'],
    'one repository call -- report is raw SQL in src/db.js, so that is one statement and one checkout');
});

test('the report handler passes both knob positions from config', async () => {
  const seen = [];
  const repo = { report: async (a) => { seen.push(a); return { n: 0, bytes: 0, feeds: 0, recordId: 1 }; } };
  const handlers = createHandlers({ repo, config: { reportScanRows: 4000, reportSleepMs: 320, seedFeeds: 16 } });
  await handlers.report({ body: { feedId: 2 }, timer: createTimer() });
  assert.equal(seen[0].scanRows, 4000);
  assert.equal(seen[0].sleepMs, 320,
    'the sleep is what makes DBLoadCPU readable at the pool knee (plan 3, D1)');
});

test('report defaults its feed when the body omits one', async () => {
  const res = await createHandlers({ repo: fakeRepo(), config }).report({ body: undefined, timer: createTimer() });
  assert.equal(res.status, 200);
});

test('every handler records exactly one db phase', async () => {
  const h = createHandlers({ repo: fakeRepo(), config });
  for (const [name, args] of [
    ['getPost', { params: { id: '1' } }],
    ['createPost', {}],
    ['feed', { params: { id: '1' } }],
    ['report', { body: {} }],
  ]) {
    const timer = createTimer();
    await h[name]({ ...args, timer });
    assert.ok('db' in timer.phases(), `${name} must record a db phase`);
  }
});
