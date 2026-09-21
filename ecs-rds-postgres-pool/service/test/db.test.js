import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepo, buildPost, BODY_BYTES } from '../src/db.js';

function fakePrisma() {
  const calls = [];
  return {
    calls,
    post: {
      findUnique: async (a) => { calls.push(['findUnique', a]); return { id: 1, body: 'x' }; },
      create:     async (a) => { calls.push(['create', a]); return { id: 2, ...a.data }; },
    },
    $queryRaw: async (...a) => { calls.push(['raw', ...a]); return [{ n: 0, bytes: 0, feeds: 0, avg_score: 0, record_id: 3 }]; },
  };
}

const config = { feedPageSize: 20, reportScanRows: 0, reportSleepMs: 0, seedFeeds: 16 };

test('a post body is the configured width', () => {
  assert.equal(buildPost(0).body.length, BODY_BYTES);
  assert.equal(BODY_BYTES, 940);
});

test('a built post names a feed inside the seeded range', () => {
  const p = buildPost(7);
  assert.equal(p.feedId, 7);
  assert.ok(p.author.length > 0);
});

// The two query-builder routes below count PRISMA CLIENT CALLS, which is one
// layer above where a second SQL statement would be emitted. One client call is
// necessary for one statement and not sufficient for it: a nested write or
// relationMode = "prisma" would turn one call into several statements and these
// assertions would stay green. Their messages say only what they check. The
// statement count for getPost and createPost is a property of Prisma's query
// compiler and is verified against the real instance in a later plan
// (pg_stat_statements over a load run), not by a unit test -- see the note on
// createPost in src/db.js. For feedPage and report the SQL is in the source, so
// there the count really is asserted.

test('getPost is one prisma client call, a primary-key lookup', async () => {
  const prisma = fakePrisma();
  await createRepo({ prisma, config }).getPost(42);
  assert.equal(prisma.calls.length, 1, 'one prisma client call per request');
  assert.deepEqual(prisma.calls[0][1], { where: { id: 42 } });
});

test('createPost is one prisma client call carrying the scalar foreign key', async () => {
  const prisma = fakePrisma();
  await createRepo({ prisma, config }).createPost(buildPost(3));
  assert.equal(prisma.calls.length, 1, 'one prisma client call per request');
  // A SCALAR feedId, never a nested `feed: { connect }`: the nested form is
  // what would make this route two statements.
  assert.equal(prisma.calls[0][1].data.feedId, 3);
  assert.equal(prisma.calls[0][1].data.feed, undefined,
    'a nested relation write here would cost a second statement');
});

test('feedPage is one raw statement joining posts to feeds', async () => {
  const prisma = fakePrisma();
  await createRepo({ prisma, config }).feedPage(5, 20);
  assert.equal(prisma.calls.length, 1,
    'one raw statement -- the SQL is in src/db.js, so this one really is a statement count');
  const [, sql] = prisma.calls[0];
  const text = String(sql);
  assert.match(text, /join\s+feeds/i, 'the standard route must exercise a join');
  assert.match(text, /order\s+by\s+p\.created_at\s+desc/i);
});

test('report is ONE statement that scans, aggregates and inserts', async () => {
  const prisma = fakePrisma();
  await createRepo({ prisma, config }).report({ scanRows: 5000, post: buildPost(1) });
  assert.equal(prisma.calls.length, 1,
    'the heavy route must take exactly one pool checkout -- the capacity model assumes it');
  const text = String(prisma.calls[0][1]);
  assert.match(text, /with\s+scanned/i);
  assert.match(text, /insert\s+into\s+posts/i);
  assert.match(text, /count\(distinct/i, 'the knob needs work that scales with rows');
});

test('report at 0 scan rows keeps the same statement shape', async () => {
  const prisma = fakePrisma();
  await createRepo({ prisma, config }).report({ scanRows: 0, post: buildPost(1) });
  assert.equal(prisma.calls.length, 1);
  const text = String(prisma.calls[0][1]);
  assert.match(text, /insert\s+into\s+posts/i,
    'the write must still happen at 0, or the baseline measures a different route');
});

test('report sleeps INSIDE the one statement, so the hold is still one checkout', async () => {
  const prisma = fakePrisma();
  await createRepo({ prisma, config }).report({ scanRows: 5000, sleepMs: 320, post: buildPost(1) });
  assert.equal(prisma.calls.length, 1,
    'the wait must be part of the same statement -- a second round trip would be a second checkout');
  const text = String(prisma.calls[0][1]);
  assert.match(text, /pg_sleep/i);
  assert.match(text, /materialized/i,
    'the sleep CTE is MATERIALIZED so it cannot be inlined away from the plan');
  assert.match(text, /count\(distinct/i, 'the CPU half of the knob stays');
});

test('report at sleepMs 0 keeps the same statement shape', async () => {
  const prisma = fakePrisma();
  await createRepo({ prisma, config }).report({ scanRows: 0, sleepMs: 0, post: buildPost(1) });
  assert.equal(prisma.calls.length, 1);
  const text = String(prisma.calls[0][1]);
  assert.match(text, /pg_sleep/i,
    'pg_sleep(0) returns immediately; removing it at 0 would make the baseline a different statement');
  assert.match(text, /insert\s+into\s+posts/i);
});
