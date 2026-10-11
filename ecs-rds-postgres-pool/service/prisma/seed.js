// prisma/seed.js
// Deterministic, so two environments hold identical data and a run in one is
// comparable to a run in the other.
import { BODY_BYTES } from '../src/db.js';

const BODY = 'x'.repeat(BODY_BYTES);
const BATCH = 1000;

/**
 * A fixed instant, NOT Date.now(). created_at is what the feed route orders by,
 * so seeding with the wall clock would give two environments different row
 * order and quietly break comparability between their runs.
 * 2026-01-01T00:00:00Z.
 */
export const EPOCH = Date.UTC(2026, 0, 1);

/** Feed ids start at 1: the routes treat 0 as an invalid id. */
export function buildFeeds(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `feed-${String(i + 1).padStart(2, '0')}`,
  }));
}

/** One second apart, ascending, so ORDER BY created_at DESC is unambiguous. */
export function buildPostBatch(feedId, offset, count) {
  return Array.from({ length: count }, (_, i) => ({
    feedId,
    author: `seed_${String(offset + i).padStart(10, '0')}`,
    body: BODY,
    score: (offset + i) % 100,
    createdAt: new Date(EPOCH + (offset + i) * 1000),
  }));
}

/**
 * Tops `posts` up; it never starts from empty, so it is safe to run again.
 *
 * Rows are named by (feed, offset), and a feed's seeded rows are always offsets
 * 0..n-1, so "what exists" is one count per feed and "what is missing" is the
 * offsets after it. `rows` is the TARGET total (a re-run at the same number
 * inserts nothing); `add` appends that many on top of whatever is there.
 * Seeded rows are told apart from the heavy route's `u_...` inserts by the
 * `seed_` author prefix, so load-test writes do not count as seed.
 */
export async function seedAll(prisma, { rows, feeds, add = 0, log = () => {} }) {
  // Feeds first: every post carries a foreign key into this table, so seeding
  // posts first fails on the constraint rather than on anything informative.
  await prisma.feed.createMany({ data: buildFeeds(feeds), skipDuplicates: true });

  const counts = await prisma.post.groupBy({
    by: ['feedId'],
    where: { author: { startsWith: 'seed_' } },
    _count: { _all: true },
  });
  const have = new Map(counts.map((c) => [c.feedId, c._count._all]));
  const before = [...have.values()].reduce((a, b) => a + b, 0);
  const target = add > 0 ? before + add : rows;
  const perFeed = Math.ceil(target / feeds);

  let inserted = 0;
  for (let f = 1; f <= feeds; f += 1) {
    for (let offset = have.get(f) ?? 0; offset < perFeed; offset += BATCH) {
      const batch = buildPostBatch(f, offset, Math.min(BATCH, perFeed - offset));
      await prisma.post.createMany({ data: batch, skipDuplicates: true });
      inserted += batch.length;
    }
  }
  log(`seeded posts: ${before} before, ${inserted} inserted, ${before + inserted} after`);

  if (inserted === 0) return { before, inserted, after: before };

  // Without this the planner has no statistics, and the first run of a session
  // measures a different query plan than the second (spec 5). VACUUM cannot run
  // inside a transaction block, which is why it is $executeRawUnsafe on its own
  // rather than part of a batch.
  await prisma.$executeRawUnsafe('VACUUM ANALYZE feeds');
  await prisma.$executeRawUnsafe('VACUUM ANALYZE posts');
  return { before, inserted, after: before + inserted };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { createPrisma } = await import('../src/db.js');
  const { createPool } = await import('../src/pool.js');
  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();
  const { pool, close } = createPool({ config, onWait: () => {} });
  const prisma = createPrisma(pool);
  // SEED_ADD_ROWS (set by scripts/seed.sh --add / -i) appends; without it the
  // seed tops posts up to SEED_ROWS, which is a no-op when already there.
  const add = Number(process.env.SEED_ADD_ROWS ?? 0);
  if (!Number.isInteger(add) || add < 0) throw new Error(`SEED_ADD_ROWS must be a non-negative integer, got ${process.env.SEED_ADD_ROWS}`);
  await seedAll(prisma, { rows: config.seedRows, feeds: config.seedFeeds, add, log: console.log });
  await prisma.$disconnect();
  await close();
}
