import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { instrumentConnect } from '../src/pool.js';
import { runInRequestContext } from '../src/context.js';

/** Minimal stand-in for pg.Pool: enough surface for the wrapper, no database. */
function fakePool({ delayMs = 0, fail = false } = {}) {
  const released = [];
  return {
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    released,
    async connect() {
      await new Promise((r) => setTimeout(r, delayMs));
      if (fail) throw new Error('connect failed');
      this.totalCount += 1;
      return { release: () => released.push(1), query: async () => ({ rows: [] }) };
    },
  };
}

/**
 * A pg.Client that never opens a socket, so a REAL pg.Pool can be driven with
 * no database, no credentials and no network.
 *
 * This exists because a hand-written pool double cannot catch the bug this file
 * now guards: pg-pool's own `query()` checks out through the CALLBACK form of
 * connect, queues behind `max`, and hands the client over from `_pulseQueue()`.
 * A double that only implements `async connect()` exercises none of that, which
 * is exactly how a pool-wait metric that recorded 0.03 ms for a 120 ms queue
 * passed its tests. `holdMs` is how long a query keeps the connection.
 */
function makeStubClient(holdMs) {
  return class StubClient extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.connected = false;
    }

    connect(cb) {
      this.connected = true;
      setImmediate(() => cb(null, this));
    }

    isConnected() {
      return this.connected;
    }

    query(text, values, cb) {
      if (typeof values === 'function') cb = values;
      setTimeout(() => cb(null, { rows: [], rowCount: 0, fields: [] }), holdMs);
    }

    end(cb) {
      this.connected = false;
      if (cb) setImmediate(cb);
      return Promise.resolve();
    }
  };
}

/** A real pg.Pool over the stub client, instrumented, with the waits collected. */
function stubbedPool({ max = 1, holdMs = 60 } = {}) {
  const waits = [];
  const pool = new pg.Pool({ max, Client: makeStubClient(holdMs) });
  instrumentConnect(pool, (w) => waits.push(w));
  return { pool, waits };
}

const ms = (w) => w.seconds * 1000;

test('a checkout reports its duration in seconds', async () => {
  const calls = [];
  const p = fakePool({ delayMs: 20 });
  instrumentConnect(p, (w) => calls.push(w));
  const client = await p.connect();
  client.release();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].seconds >= 0.015, `expected >= 0.015s, got ${calls[0].seconds}`);
});

test('the wait is labelled with the calling request route and class', async () => {
  const calls = [];
  const p = fakePool();
  instrumentConnect(p, (w) => calls.push(w));
  await runInRequestContext({ route: '/reports', class: 'heavy' }, async () => {
    const c = await p.connect();
    c.release();
  });
  assert.equal(calls[0].route, '/reports');
  assert.equal(calls[0].class, 'heavy');
});

test('outside a request the wait is still recorded, unlabelled', async () => {
  const calls = [];
  const p = fakePool();
  instrumentConnect(p, (w) => calls.push(w));
  const c = await p.connect();
  c.release();
  assert.equal(calls[0].route, undefined);
  assert.equal(calls[0].class, undefined);
});

test('a checkout that opened a new physical connection is marked opened', async () => {
  const calls = [];
  const p = fakePool();
  instrumentConnect(p, (w) => calls.push(w));
  const c = await p.connect();
  c.release();
  // totalCount rose from 0 to 1 across the call: this was an establishment,
  // not a queue. Spec 4.2 -- opposite diagnoses, one series.
  assert.equal(calls[0].opened, true);
});

test('a checkout served from the idle set is not marked opened', async () => {
  const calls = [];
  const p = fakePool();
  p.totalCount = 3;
  p.connect = async function () { return { release() {}, query: async () => ({ rows: [] }) }; };
  instrumentConnect(p, (w) => calls.push(w));
  const c = await p.connect();
  c.release();
  assert.equal(calls[0].opened, false);
});

test('a failed checkout still reports, and still rejects', async () => {
  const calls = [];
  const p = fakePool({ fail: true });
  instrumentConnect(p, (w) => calls.push(w));
  await assert.rejects(() => p.connect(), /connect failed/);
  assert.equal(calls.length, 1, 'a failed checkout must still be measured');
});

test('the wrapper does not swallow the client: release still reaches the pool', async () => {
  const p = fakePool();
  instrumentConnect(p, () => {});
  const c = await p.connect();
  c.release();
  assert.equal(p.released.length, 1);
});

test('a throwing onWait never breaks a checkout', async () => {
  const p = fakePool();
  instrumentConnect(p, () => { throw new Error('recorder exploded'); });
  const c = await p.connect();
  assert.ok(c, 'the caller must still get its client');
  c.release();
});

// ---------------------------------------------------------------------------
// The callback form: the path every MEASURED request actually takes.
// @prisma/adapter-pg's performIO calls pool.query(), and pg-pool's query()
// checks out with this.connect((err, client) => ...).
// ---------------------------------------------------------------------------

test('a callback-form checkout records the real queueing wait', async () => {
  // REGRESSION: the wrapper used to `await` the callback form's return value,
  // which is undefined and resolves on the next microtask -- so a connection
  // that was queued for the whole of another query's hold time was recorded at
  // a fraction of a millisecond. Measured before the fix: 0.03 ms for a 120 ms
  // queue. This is the only shape that catches it.
  const { pool, waits } = stubbedPool({ max: 1, holdMs: 60 });
  try {
    await Promise.all([pool.query('select 1'), pool.query('select 2')]);
  } finally {
    await pool.end();
  }

  assert.equal(waits.length, 2, 'both checkouts must be measured');
  assert.ok(ms(waits[0]) < 20, `the first checkout should not queue, got ${ms(waits[0])} ms`);
  assert.ok(ms(waits[1]) >= 45,
    `the queued checkout must record the wait it actually paid (~60 ms), got ${ms(waits[1])} ms`);
});

test('a queued callback-form checkout is a queue, not an establishment', async () => {
  const { pool, waits } = stubbedPool({ max: 1, holdMs: 40 });
  try {
    await Promise.all([pool.query('select 1'), pool.query('select 2')]);
  } finally {
    await pool.end();
  }
  assert.equal(waits[0].opened, true, 'the first checkout built the one connection');
  assert.equal(waits[1].opened, false, 'the second reused it, so this wait is pure queueing');
});

test('a queued wait is attributed to the WAITING request, not the releasing one', async () => {
  // THE TRAP. pg-pool hands the connection over from _pulseQueue(), which runs
  // in the async context of whichever request RELEASED it. A wrapper reading
  // currentRequest() in the completion path labels /reports' 60 ms queue with
  // /posts/:id -- a label that looks right and is wrong. The context is
  // therefore captured eagerly, at call time.
  const { pool, waits } = stubbedPool({ max: 1, holdMs: 60 });
  try {
    await Promise.all([
      runInRequestContext({ route: '/posts/:id', class: 'fast' }, () => pool.query('select 1')),
      runInRequestContext({ route: '/reports', class: 'heavy' }, () => pool.query('select 2')),
    ]);
  } finally {
    await pool.end();
  }

  assert.deepEqual(waits.map((w) => w.route), ['/posts/:id', '/reports']);
  assert.deepEqual(waits.map((w) => w.class), ['fast', 'heavy']);
  const heavy = waits.find((w) => w.route === '/reports');
  assert.ok(ms(heavy) >= 45,
    `the heavy request is the one that queued; it must carry the wait, got ${ms(heavy)} ms`);
});

test('the callback form keeps its contract: undefined back, client and release through', async () => {
  const { pool, waits } = stubbedPool({ max: 1, holdMs: 0 });
  try {
    const seen = await new Promise((resolve, reject) => {
      const ret = pool.connect((err, client, release) => {
        if (err) return reject(err);
        resolve({ client, release });
      });
      // pg-pool's query() ignores the return value and expects undefined here;
      // handing back a promise would make the wrapper a different function.
      assert.equal(ret, undefined, 'the callback form must not return a promise');
    });
    assert.ok(seen.client, 'the caller must receive its client, unwrapped');
    assert.equal(typeof seen.release, 'function', 'the release handle must reach the caller');
    seen.release();
  } finally {
    await pool.end();
  }
  assert.equal(waits.length, 1);
});

test('a throwing onWait never breaks a callback-form checkout', async () => {
  const pool = new pg.Pool({ max: 1, Client: makeStubClient(0) });
  instrumentConnect(pool, () => { throw new Error('recorder exploded'); });
  try {
    const res = await pool.query('select 1');
    assert.ok(res, 'the query must still complete');
  } finally {
    await pool.end();
  }
});

test('the promise form still measures a real pg.Pool checkout', async () => {
  // warm() and the adapter's startTransaction() are the only promise-form
  // callers left, so this path has to keep working against the real thing too.
  const { pool, waits } = stubbedPool({ max: 2, holdMs: 0 });
  try {
    const client = await runInRequestContext({ route: '/reports', class: 'heavy' },
      () => pool.connect());
    assert.equal(typeof client.release, 'function');
    client.release();
  } finally {
    await pool.end();
  }
  assert.equal(waits.length, 1);
  assert.equal(waits[0].route, '/reports');
  assert.equal(waits[0].opened, true);
});
