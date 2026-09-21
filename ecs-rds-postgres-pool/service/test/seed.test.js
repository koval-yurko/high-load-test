import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFeeds, buildPostBatch, EPOCH } from '../prisma/seed.js';

test('feeds are numbered from 1, because a post id of 0 is not a valid FK target', () => {
  const feeds = buildFeeds(16);
  assert.equal(feeds.length, 16);
  assert.equal(feeds[0].id, 1);
  assert.equal(feeds.at(-1).id, 16);
  assert.match(feeds[0].name, /feed-01/);
});

test('a batch is deterministic: same inputs, same rows', () => {
  assert.deepEqual(buildPostBatch(1, 0, 5), buildPostBatch(1, 0, 5));
});

test('created_at is generated, never now(), or two environments diverge', () => {
  const rows = buildPostBatch(1, 0, 3);
  assert.ok(rows[0].createdAt instanceof Date);
  assert.equal(rows[0].createdAt.getTime(), EPOCH);
  assert.ok(rows[1].createdAt.getTime() > rows[0].createdAt.getTime(),
    'ascending, so ORDER BY created_at DESC has a stable answer');
});

test('offsets do not collide across batches of the same feed', () => {
  const a = buildPostBatch(1, 0, 3);
  const b = buildPostBatch(1, 3, 3);
  const times = [...a, ...b].map((r) => r.createdAt.getTime());
  assert.equal(new Set(times).size, 6);
});

test('every row carries the full body width and a valid feed id', () => {
  for (const r of buildPostBatch(4, 0, 3)) {
    assert.equal(r.body.length, 940);
    assert.equal(r.feedId, 4);
  }
});
