// src/db.js
// Prisma Client over the pg.Pool this service owns, plus the four statements.
//
// ONE STATEMENT PER ROUTE, always. One statement is one pool checkout, and the
// capacity model -- pool of 5 divided by a 20 ms hold time = 250 rps -- is only
// true at one checkout per request. The two read-heavy routes are raw SQL
// rather than Prisma query-builder calls precisely so the statement count is
// visible in the source instead of depending on a relation-loading strategy.
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomBytes } from 'node:crypto';

/** ~1 KB per row, so a 20-row feed page moves ~19 KB. */
export const BODY_BYTES = 940;
const BODY = 'x'.repeat(BODY_BYTES);

export const randomAuthor = () => `u_${randomBytes(6).toString('hex')}`;

export const buildPost = (feedId) => ({
  feedId,
  author: randomAuthor(),
  body: BODY,
  score: 0,
});

/**
 * The adapter is what hands Prisma OUR pool rather than letting it build its
 * own -- confirmed against @prisma/adapter-pg 7.10.0, which accepts a
 * constructed pg.Pool and not only a config object.
 */
export function createPrisma(pool) {
  return new PrismaClient({ adapter: new PrismaPg(pool) });
}

export function createRepo({ prisma, config }) {
  return {
    /**
     * fast: ONE statement, a primary-key lookup.
     *
     * Like createPost below, the statement count here is Prisma's to keep, not
     * something the source shows. See the note on createPost.
     */
    getPost: (id) => prisma.post.findUnique({ where: { id } }),

    /**
     * fast: ONE statement -- INSERT ... RETURNING, and no foreign-key probe.
     *
     * `data` carries the SCALAR feedId rather than a nested `feed: { connect }`,
     * and the schema leaves relationMode at its default (foreignKeys), so the
     * database enforces the reference and Prisma issues nothing to check it.
     * Emulation -- the extra SELECT that would make this two statements and
     * halve this route's share of the pool -- only happens at
     * relationMode = "prisma". Do not add a nested write here without
     * re-deriving the capacity model.
     *
     * NOTE how far this guarantee reaches. For feedPage and report the count is
     * visible in the SQL in this file and the unit tests assert it. For getPost
     * and createPost it is a property of Prisma's query compiler, one layer
     * below the client calls a unit test can count -- so it is verified against
     * the real instance in a later plan (pg_stat_statements / log_statement over
     * a load run), not here.
     */
    createPost: (post) => prisma.post.create({ data: post }),

    /**
     * standard: ONE statement joining posts to feeds, index-ordered by
     * post_feed_recent_idx. Deliberately not prisma.post.findMany({ include:
     * { feed: true } }) -- that is one line and can issue two queries depending
     * on the relation load strategy, which would silently double this route's
     * pool occupancy.
     */
    feedPage: (feedId, limit) => prisma.$queryRaw`
      SELECT p.id, p.author, p.body, p.score, p.created_at, f.name AS feed_name
        FROM posts p
        JOIN feeds f ON f.id = p.feed_id
       WHERE p.feed_id = ${feedId}
       ORDER BY p.created_at DESC
       LIMIT ${limit}`,

    /**
     * heavy, and THE CALIBRATED COST KNOB (spec 5). A single data-modifying CTE
     * that scans `scanRows` rows, aggregates them, and inserts one row -- all
     * in one statement, so one checkout.
     *
     * NOT pg_sleep, deliberately: sleeping holds a connection without consuming
     * CPU, which would leave DBLoadCPU near zero and make the calibration
     * target -- "the pool binds while the database still has headroom" --
     * unreadable, because the instance would look idle at any load.
     *
     * count(DISTINCT feed_id) is what makes the cost scale with rows rather
     * than being a cheap running total: it forces a sort or a hash.
     *
     * The shape does NOT change at scanRows = 0. LIMIT 0 scans nothing, the
     * aggregate still returns exactly one row, and the insert still happens.
     * A knob that restructured the statement would mean the baseline measured
     * a different route than the comparison did.
     */
    async report({ scanRows, post }) {
      const [row] = await prisma.$queryRaw`
        WITH scanned AS (
          SELECT feed_id, score, body FROM posts ORDER BY id LIMIT ${scanRows}
        ),
        agg AS (
          SELECT count(*)::int                       AS n,
                 coalesce(sum(length(body)), 0)::int AS bytes,
                 count(DISTINCT feed_id)::int        AS feeds,
                 coalesce(avg(score), 0)::float      AS avg_score
            FROM scanned
        ),
        ins AS (
          INSERT INTO posts (feed_id, author, body, score)
          SELECT ${post.feedId}::int, ${post.author}::varchar, ${post.body}::varchar, 0 FROM agg
          RETURNING id
        )
        SELECT a.n, a.bytes, a.feeds, a.avg_score, i.id AS record_id
          FROM agg a, ins i`;
      return {
        n: row?.n ?? 0,
        bytes: row?.bytes ?? 0,
        feeds: row?.feeds ?? 0,
        avgScore: row?.avg_score ?? 0,
        recordId: row?.record_id ?? null,
      };
    },
  };
}
