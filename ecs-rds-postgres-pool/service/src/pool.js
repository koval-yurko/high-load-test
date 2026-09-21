// src/pool.js
// The pg.Pool this service owns, and the checkout measurement built on it.
//
// WHY WE OWN THE POOL AT ALL. Prisma's own metrics feature -- which published
// prisma_client_queries_wait_histogram_ms -- was deprecated in 6.14.0 and
// REMOVED in 7.0.0. Prisma's upgrade guide points at the driver adapter
// instead, so the pool is ours again and checkout is ours to time. Do not go
// looking for $metrics; it does not exist in any version we can pin.
import pg from 'pg';
import { currentRequest } from './context.js';

/**
 * Wraps pool.connect so every checkout is measured and attributed.
 *
 * `opened` distinguishes the two things that land in one series: queueing
 * behind other requests, and paying TCP + TLS + auth for a brand-new physical
 * connection. totalCount rising across the call means the latter.
 *
 * BOTH CALL FORMS ARE INSTRUMENTED, and that is not defensive generality --
 * it is the only reason this metric carries signal. pg-pool's own `query()`
 * calls `this.connect((err, client) => …)`, the CALLBACK form, which queues the
 * request and returns `undefined` synchronously. @prisma/adapter-pg's
 * `performIO` routes every ordinary statement through `this.client.query(...)`
 * where `this.client` IS this pg.Pool, so the callback form is the path EVERY
 * measured request takes. Only warm() below and the adapter's
 * startTransaction() take the promise form. A wrapper that awaited the return
 * value of the callback form would stop the clock on the next microtask,
 * before the connection had been handed over: measured against a real pg.Pool
 * of max 1 with two 120 ms queries, the genuinely-queued second query recorded
 * 0.03 ms.
 *
 * THE CONTEXT IS CAPTURED EAGERLY, at call time, and used in both forms. The
 * completion callback is invoked from pg-pool's `_pulseQueue()`, which runs in
 * the async context of the request that RELEASED the connection, not the one
 * that waited for it. Reading currentRequest() in the completion path would
 * attribute a queued request's real wait to whichever route happened to
 * release -- which is worse than no label, because it is a label that looks
 * right. The regression coverage for exactly this trap is the durable record
 * of the behaviour, not a number quoted in a comment: see test/pool.test.js,
 * 'a queued wait is attributed to the WAITING request, not the releasing one'.
 *
 * Exported for the tests, which drive it against a real pg.Pool with a stub
 * Client -- there is no local Postgres in this project by design.
 */
export function instrumentConnect(pool, onWait) {
  const original = pool.connect.bind(pool);
  pool.connect = function instrumentedConnect(...args) {
    const before = pool.totalCount;
    const t0 = process.hrtime.bigint();
    const ctx = currentRequest();

    let recorded = false;
    const record = () => {
      if (recorded) return;   // pg-pool calls a pending item's callback once; belt and braces
      recorded = true;
      const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
      try {
        onWait({
          seconds,
          route: ctx?.route,
          class: ctx?.class,
          // Read HERE, when the wait actually ended, against the count taken
          // before the call: a rise across that span is an establishment.
          opened: pool.totalCount > before,
        });
      } catch {
        // A recorder must never be able to fail a request. Swallowing here is
        // deliberate: the alternative is that an OTel hiccup becomes a 5xx and
        // burns the availability budget this project is trying to measure.
      }
    };

    const [cb] = args;
    if (typeof cb === 'function') {
      // pg-pool expects `undefined` back from this form, never a promise, so
      // the call is passed straight through. The callback contract is kept
      // exactly: same arguments (err, client, release), same `this`, same
      // return value.
      return original(function instrumentedConnectCallback(...cbArgs) {
        record();
        return cb.apply(this, cbArgs);
      });
    }

    return (async () => {
      try {
        return await original(...args);
      } finally {
        record();
      }
    })();
  };
  return pool;
}

export function createPool({ config, onWait }) {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.poolMax,
    connectionTimeoutMillis: config.poolConnectionTimeoutMs,
    // NEVER reap an idle connection. The sibling project records ~3% of idle
    // fast-class requests missing 50 ms because the socket was reaped and the
    // next request paid a fresh TLS handshake. Under Prisma's own pool this was
    // only mitigable; owning the pool makes it preventable.
    idleTimeoutMillis: 0,
    // RDS PostgreSQL 15+ ships rds.force_ssl = 1 in the default parameter
    // group. rejectUnauthorized is false because the task trusts the VPC path
    // and carrying the RDS CA bundle in the image is plan 2's problem, not a
    // reason to fail closed here.
    ssl: config.dbSsl === 'require' ? { rejectUnauthorized: false } : undefined,
  });

  instrumentConnect(pool, onWait);

  return {
    pool,
    /**
     * Open every connection before the server listens, so no MEASURED request
     * pays for establishment. Without this the first requests of a run record
     * a TLS handshake as pool wait (spec 4.2).
     */
    async warm() {
      const clients = await Promise.all(
        Array.from({ length: config.poolMax }, () => pool.connect()),
      );
      for (const c of clients) c.release();
    },
    stats: () => ({
      waiting: pool.waitingCount,
      idle: pool.idleCount,
      total: pool.totalCount,
    }),
    close: () => pool.end(),
  };
}
