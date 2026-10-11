import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFeeds, buildPostBatch, seedAll, EPOCH } from '../prisma/seed.js';

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

function fakePrisma(existingPerFeed) {
  const inserted = [];
  return {
    inserted,
    feed: { createMany: async () => {} },
    post: {
      groupBy: async () => existingPerFeed.map((n, i) => ({ feedId: i + 1, _count: { _all: n } })),
      createMany: async ({ data }) => { inserted.push(...data); },
    },
    $executeRawUnsafe: async () => {},
  };
}

test('seeding to a target tops up and a second run at the same target inserts nothing', async () => {
  const first = fakePrisma([0, 0]);
  assert.deepEqual(await seedAll(first, { rows: 10, feeds: 2 }), { before: 0, inserted: 10, after: 10 });
  const again = fakePrisma([5, 5]);
  assert.deepEqual(await seedAll(again, { rows: 10, feeds: 2 }), { before: 10, inserted: 0, after: 10 });
  assert.equal(again.inserted.length, 0);
});

test('add appends after the existing offsets, so no seeded row is duplicated', async () => {
  const prisma = fakePrisma([5, 5]);
  const out = await seedAll(prisma, { rows: 10, feeds: 2, add: 6 });
  assert.deepEqual(out, { before: 10, inserted: 6, after: 16 });
  const feed1 = prisma.inserted.filter((r) => r.feedId === 1).map((r) => r.author);
  assert.deepEqual(feed1, ['seed_0000000005', 'seed_0000000006', 'seed_0000000007']);
});
