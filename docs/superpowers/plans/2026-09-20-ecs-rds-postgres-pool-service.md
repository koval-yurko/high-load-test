# ecs-rds-postgres-pool — Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

- **Status:** **complete** (executed 2026-09-20). All 13 tasks implemented, each reviewed;
  two task-level fix rounds and one whole-branch fix wave. The suite is 133 tests, green with
  no database, AWS credentials or collector. `npm run slo:check` exits non-zero naming `fast`
  and `threshold_ms` — the deliberate red state plan 3 turns green. Not merged to master at
  time of writing.
- **Plan 1 of 4** (see the spec's "Execution shape"). This plan is spec phase 1 only: the Node
  service and `slo.yaml`. It touches **no Terraform and no AWS**, and nothing in it can cost money.
- **Spec:** `docs/superpowers/specs/2026-09-19-ecs-rds-postgres-pool-design.md`
- **Reviewed 2026-09-20**, which settled the two questions this plan was holding open and corrected
  five defects found while checking its asserted facts:

| # | question | answer |
|---|---|---|
| P1 | Is the schema a Postgres design, or DynamoDB thinking ported? | **A Postgres design** — two tables with a foreign key, a join on the standard route, replacing the single `(pk, sk)` table an earlier draft carried over |
| P2 | The heavy route took two pool checkouts | **Fold it into one statement** — a single data-modifying CTE, so the capacity arithmetic stays true |

The defects are recorded in commit `b76196a`: invented OpenTelemetry versions, three missing
packages including the one that emits `nodejs.eventloop.delay`, `prisma` as a devDependency while
migrate-on-boot needs it at runtime, a `test` script that broke per-file test runs, and a
calibration search that could converge above the seeded table size.

**Goal:** A Node.js service that serves four routes against PostgreSQL through Prisma, measures how
long each request waited for a database connection, attributes that wait to the request's latency
class, and ships as a container image — verified without any database, because this project has none
locally.

**Architecture:** Prisma Client over a `pg.Pool` the service constructs itself (`@prisma/adapter-pg`),
so connection checkout is ours to time. An `AsyncLocalStorage` store carries the current request's
route template and latency class, so the pool-wait histogram wears the same `http.route` and `class`
labels as the `db` and `cpu` phase histograms. Everything exports over OTLP to an Alloy collector
that does not exist yet; absent its endpoint, the exporters are not started and the recorders are
no-ops, which is what lets the whole suite run with no infrastructure.

**Tech Stack:** Node 22.13, ESM, `node:test` + `node:assert/strict` (no test framework),
`prisma` + `@prisma/client` + `@prisma/adapter-pg` 7.10.x, `pg`, `@opentelemetry/*`,
`@aws-sdk/client-cloudwatch`, Docker.

---

## Global Constraints

Copied verbatim from the spec; every task's requirements implicitly include these.

- **No local Postgres and no integration suite.** Decided 2026-09-11 and kept by the spec. Every
  test in this plan runs with no database, no AWS and no collector. A task that cannot be verified
  that way is written so that it can be.
- **The pool is ours.** Prisma is reached through `@prisma/adapter-pg` over a `pg.Pool` this service
  constructs. Prisma's own `$metrics` does not exist: it was deprecated in 6.14.0 and **removed in
  7.0.0**. Do not reach for it; do not add `previewFeatures = ["metrics"]`.
- **Exactly one SQL statement per request, on every route.** One statement is one pool checkout, and
  the spec's capacity arithmetic — pool of 5 ÷ 20 ms hold time = 250 rps — is only true at one
  checkout per request. A route that issues two halves the rate at which the pool binds and makes
  the calibration target wrong for that share of the mix. Task 5 asserts the statement count per
  route, so a second query cannot creep in later through a convenient `include`.
- **Route templates, never concrete paths.** `http.route` is always the pattern (`/posts/:id`),
  because a raw path mints one time series per id.
- **Phase marks are recorded in seconds**, converted once in `timing.js`, because that is the unit
  of the OTel histograms.
- **Class thresholds in `slo.yaml` are deliberately left unset in this plan.** They are frozen in
  plan 3, after calibration on the real instance. Do not invent values for them.
- **No measured number appears in any document.** No SLO or RPS figure without the run that produced
  it, in the same session.
- **Every file copied from `ecs-dynamodb-rps` carries a header** naming the sibling file and the
  fork date (2026-09-20), because a bug fixed in one copy stays broken in the other.

### The environment-variable contract

This is the interface between this plan and plan 2 (infrastructure). Plan 2 sets these; nothing else
reaches the service. Fix the names here and do not change them later.

| variable | type | absent means |
|---|---|---|
| `PORT` | number | 8080 |
| `DATABASE_URL` | string | **required** — the service exits non-zero at boot |
| `POOL_MAX` | number | 5 — this is knob 1 |
| `POOL_CONNECTION_TIMEOUT_MS` | number | 900 |
| `DB_SSL` | `"require"` \| `"off"` | `"require"` |
| `MIGRATE_ON_BOOT` | `"1"` \| unset | off |
| `SEED_ON_BOOT` | `"1"` \| unset | off |
| `SEED_ROWS` | number | 50000 |
| `SEED_FEEDS` | number | 16 |
| `FEED_PAGE_SIZE` | number | 20 |
| `REPORT_SCAN_ROWS` | number | 0 — the calibrated cost knob (Task 3) |
| `OTEL_SERVICE_NAME` | string | `ecs-rds-postgres-pool` |
| `OTEL_SERVICE_INSTANCE_ID` | string | ECS task metadata supplies `service.instance.id`; this is the manual override for when detection fails (added by the final whole-branch review fix wave — `src/otel.js` read `config.instanceIdFallback` but `loadConfig` never produced it) |
| `OTLP_ENDPOINT` | string | no exporter is started; recorders are no-ops |
| `OTEL_EXPORT_INTERVAL_MS` | number | 15000 |
| `METRICS_NAMESPACE` | string | no CloudWatch publisher, no AWS client |
| `METRICS_INTERVAL_MS` | number | 10000 |

There is deliberately **no** `SHED_ELU_THRESHOLD`. The spec excludes admission control: shedding
429s would stop a saturated pool from ever producing the 5xx this project wants to measure, and a
4xx is not a miss in this repo's Grafana SLI.

---

## Design decision made in this plan: the SQL workload

The spec fixes the shape — four routes, three latency classes, a 55/15/25/5 mix, and a cost knob
that sits *inside connection hold time* — but deliberately leaves the queries, indexes and row
widths to be "designed on their own terms". This section is that design. **It is the one genuinely
architectural choice in this plan and is the thing to read first in review.**

**Schema.** Two tables with a real foreign key, designed as SQL rather than as a key-value store
wearing a Postgres costume. An earlier draft of this plan used a single `items` table with a
composite `(pk, sk)` primary key — a near-literal port of the sibling's DynamoDB access pattern.
That was rejected on 2026-09-20: with one table and every query an index hit, the project would
never exercise a join, a foreign key, or a planner that can choose badly, which is most of what
makes Postgres behave unlike DynamoDB under load.

```prisma
model Feed {
  id    Int    @id
  name  String @db.VarChar(64)
  posts Post[]

  @@map("feeds")
}

model Post {
  id        Int      @id @default(autoincrement())
  feedId    Int      @map("feed_id")
  author    String   @db.VarChar(32)
  body      String   @db.VarChar(1024)
  score     Int
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  feed Feed @relation(fields: [feedId], references: [id])

  @@index([feedId, createdAt(sort: Desc)], map: "post_feed_recent_idx")
  @@map("posts")
}
```

Four things about this are load-bearing:

- **`Int` ids, not `BigInt`.** Prisma maps `BigInt` to JavaScript `BigInt`, which `JSON.stringify`
  refuses to serialize — every response would throw at the last moment, on the happy path. A 4-byte
  serial holds 2.1 billion rows against a seed of tens of thousands.
- **The foreign key is not decoration.** `POST /posts` pays a real referential-integrity probe
  against `feeds` inside its insert, which is a cost DynamoDB has no analogue for and which this
  project is now able to observe.
- **`post_feed_recent_idx` on `(feed_id, created_at DESC)`** is what makes the feed route an
  index-ordered read rather than a sort. If the planner ever stops using it, feed latency moves for
  a reason that is neither the pool nor the instance — worth knowing that is possible.
- **`body` is 940 bytes**, so a row is roughly 1 KB and a 20-row feed page moves about 19 KB. At the
  default 50,000 rows the table is ~50 MB, comfortably inside `shared_buffers`.

**Where the cost knob lives, and why not `pg_sleep`.** `pg_sleep` would hold a connection for a
known duration, which is exactly what pool occupancy needs — and it is the wrong choice, because it
consumes no CPU. The spec's calibration target is a *relationship*: the pool must bind while
`DBLoadRelativeToNumVCPUs` sits near 0.5. A workload that sleeps produces `DBLoadNonCPU` and leaves
`DBLoadCPU` near zero, so the "database still has headroom" half of the target becomes unreadable —
the instance would look idle at any load.

So the knob is real work: `REPORT_SCAN_ROWS` sets how many rows the heavy route aggregates over,
including a `count(DISTINCT feed_id)` that forces a sort or hash rather than a running total.
Calibration in plan 3 turns this one number until mean hold time reaches roughly the 20 ms the spec
derives.

**The four routes, one statement each:**

| route | class | statement | why this cost |
|---|---|---|---|
| `GET /posts/:id` | fast | primary-key lookup, one row | the floor: index hit, ~1 ms |
| `POST /posts` | fast | one insert, plus its foreign-key probe | the write path, with real referential integrity |
| `GET /feeds/:id/posts` | standard | join `posts` to `feeds`, ordered by `created_at DESC`, `LIMIT $2` | index-ordered read of `FEED_PAGE_SIZE` rows across two tables |
| `POST /reports` | heavy | **one** data-modifying CTE: scan → aggregate → insert | **the calibrated knob**, and the longest hold |

**The report is one statement, not two.** Decided 2026-09-20. An earlier draft ran the aggregate and
the insert as separate Prisma calls, which is two pool checkouts for one request — and the spec's
arithmetic (pool 5 ÷ 20 ms = 250 rps) assumes one. Postgres can do both in a single data-modifying
CTE, so the route keeps its shape and the capacity model stays true:

```sql
WITH scanned AS (
  SELECT feed_id, score, body FROM posts ORDER BY id LIMIT $1
),
agg AS (
  SELECT count(*)::int                AS n,
         coalesce(sum(length(body)),0)::int AS bytes,
         count(DISTINCT feed_id)::int  AS feeds,
         coalesce(avg(score),0)::float AS avg_score
  FROM scanned
),
ins AS (
  INSERT INTO posts (feed_id, author, body, score)
  SELECT $2::int, $3::varchar, $4::varchar, 0 FROM agg
  RETURNING id
)
SELECT a.n, a.bytes, a.feeds, a.avg_score, i.id AS record_id FROM agg a, ins i;
```

`REPORT_SCAN_ROWS` defaults to `0`, which makes `LIMIT 0` scan nothing — an uncalibrated service
must not silently run a workload nobody chose. Note that the shape does not change at 0: the
aggregate still returns exactly one row (aggregates over an empty set do), the insert still happens,
and the route still takes exactly one checkout. A knob that changed the statement's structure
between calibrated and uncalibrated would mean the baseline measured a different route than the
comparison did. The `coalesce` calls are what keep `sum` and `avg` from returning `NULL` there.

**Working set.** `SEED_ROWS` × ~1 KB must stay inside `shared_buffers`, roughly a quarter of the
instance's 1 GiB, or a "fast" query becomes random reads from gp3 and the first run of a session
differs from the second by an order of magnitude. 50,000 rows ≈ 50 MB, comfortably inside. The seed
is followed by `VACUUM ANALYZE` (Task 10).

---

## File Structure

```
ecs-rds-postgres-pool/
  service/
    package.json            scripts, deps, node engine
    Dockerfile              multi-stage; prisma generate at build time
    .dockerignore
    prisma/
      schema.prisma         the model above + the pg driver adapter
      migrations/           generated by `prisma migrate dev --create-only`
      seed.js               deterministic seed, SEED_ROWS rows
    src/
      config.js             env -> config object, with validation
      context.js            NEW  AsyncLocalStorage: the current request's route + class
      timing.js             forked: phase marks in seconds
      pool.js               NEW  pg.Pool + instrumented checkout
      db.js                 NEW  PrismaClient over the adapter; the four queries
      handlers.js           forked shape, SQL bodies
      otel.js               forked + pool wait histogram and three pool gauges
      elu.js                forked verbatim
      cloudwatch.js         forked verbatim
      server.js             forked: wiring, pre-warm, migrate/seed on boot
    scripts/
      generate-slo.js       forked; capacity advisory replaces renderCapacityTfvars
      calibrate.js          NEW  binary-searches REPORT_SCAN_ROWS (used in plan 3)
    test/                   one file per src module
  slo.yaml                  SLI shapes; class thresholds left unset
```

---

## Task 1: Scaffold and configuration

**Files:**
- Create: `ecs-rds-postgres-pool/service/package.json`
- Create: `ecs-rds-postgres-pool/service/src/config.js`
- Test: `ecs-rds-postgres-pool/service/test/config.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadConfig(env = process.env)` returning the object whose keys are the
  environment-variable contract above, camel-cased: `port`, `databaseUrl`, `poolMax`,
  `poolConnectionTimeoutMs`, `dbSsl`, `migrateOnBoot`, `seedOnBoot`, `seedRows`, `feedPageSize`,
  `reportScanRows`, `serviceName`, `otlpEndpoint`, `exportIntervalMs`, `metricsNamespace`,
  `metricsIntervalMs`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "ecs-rds-postgres-pool",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test",
    "calibrate": "node scripts/calibrate.js",
    "slo:generate": "node scripts/generate-slo.js",
    "slo:check": "node scripts/generate-slo.js --check",
    "prisma:generate": "prisma generate",
    "prisma:validate": "prisma validate"
  },
  "prisma": { "seed": "node prisma/seed.js" },
  "dependencies": {
    "@prisma/adapter-pg": "7.10.0",
    "@prisma/client": "7.10.0",
    "prisma": "7.10.0",
    "pg": "^8.13.1",
    "@aws-sdk/client-cloudwatch": "^3.1133.0",
    "@opentelemetry/api": "1.9.1",
    "@opentelemetry/exporter-metrics-otlp-http": "0.221.0",
    "@opentelemetry/instrumentation": "0.221.0",
    "@opentelemetry/instrumentation-runtime-node": "0.34.0",
    "@opentelemetry/resource-detector-aws": "2.21.0",
    "@opentelemetry/resources": "2.10.0",
    "@opentelemetry/sdk-metrics": "2.10.0",
    "@opentelemetry/semantic-conventions": "1.43.0"
  },
  "devDependencies": {
    "aws-sdk-client-mock": "^4.1.0",
    "yaml": "^2.6.0"
  }
}
```

Four things here are not free choices and must not be "tidied":

- **The OpenTelemetry versions are exact, not caret ranges**, and they are the versions
  `ecs-dynamodb-rps/service/package.json` pins today. `otel.js` is forked from that project in Task 7
  and its imports — `detectResources`, `resourceFromAttributes`, `registerInstrumentations` — moved
  across majors in this family. A caret range here means the fork compiles against one version and
  resolves to another.
- **`@opentelemetry/instrumentation-runtime-node` is what emits `nodejs.eventloop.delay`**, which is
  queue [1] in the spec's three-queue model. Without it, and its peer
  `@opentelemetry/instrumentation`, the event-loop half of the attribution story is simply absent —
  `elu.js` alone does not produce it.
- **`prisma` is a runtime dependency, not a dev one.** `MIGRATE_ON_BOOT` runs `prisma migrate deploy`
  inside the container (Task 10), and the image installs with `npm ci --omit=dev` (Task 13). As a
  devDependency the CLI is absent from the image and migrate-on-boot fails at task start, which
  would look like a database connectivity problem rather than a packaging one.
- **`yaml` and `aws-sdk-client-mock` are required by forked code**, not optional extras:
  `scripts/generate-slo.js` parses `slo.yaml` with the first, and the copied
  `test/cloudwatch.test.js` mocks the CloudWatch client with the second.

`"test": "node --test"` takes no directory argument, which is what makes `npm test -- test/x.test.js`
run exactly that one file. `node --test test/` plus a path argument would run the directory *and*
the file.

- [ ] **Step 2: Write the failing test**

`test/config.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgresql://u:p@h:5432/d' };

test('defaults match the environment-variable contract', () => {
  const c = loadConfig(base);
  assert.equal(c.port, 8080);
  assert.equal(c.poolMax, 5);
  assert.equal(c.poolConnectionTimeoutMs, 900);
  assert.equal(c.dbSsl, 'require');
  assert.equal(c.feedPageSize, 20);
  assert.equal(c.reportScanRows, 0);
  assert.equal(c.seedRows, 50_000);
  assert.equal(c.migrateOnBoot, false);
  assert.equal(c.seedOnBoot, false);
  assert.equal(c.serviceName, 'ecs-rds-postgres-pool');
});

test('DATABASE_URL is required', () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
});

test('absent OTLP_ENDPOINT and METRICS_NAMESPACE read as undefined, not empty string', () => {
  const c = loadConfig({ ...base, OTLP_ENDPOINT: '', METRICS_NAMESPACE: '' });
  assert.equal(c.otlpEndpoint, undefined);
  assert.equal(c.metricsNamespace, undefined);
});

test('a negative number is rejected by name', () => {
  assert.throws(() => loadConfig({ ...base, POOL_MAX: '-1' }), /POOL_MAX/);
});

test('DB_SSL accepts only require or off', () => {
  assert.equal(loadConfig({ ...base, DB_SSL: 'off' }).dbSsl, 'off');
  assert.throws(() => loadConfig({ ...base, DB_SSL: 'maybe' }), /DB_SSL/);
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd ecs-rds-postgres-pool/service && npm test`
Expected: FAIL — `Cannot find module '../src/config.js'`.

- [ ] **Step 4: Write `src/config.js`**

```js
// src/config.js
// Forked from ecs-dynamodb-rps/service/src/config.js on 2026-09-20.
// A bug fixed here does not reach the sibling copy; fix both.

function num(env, key, dflt) {
  const raw = env[key];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number, got ${JSON.stringify(raw)}`);
  return n;
}

const flag = (env, key) => env[key] === '1';

export function loadConfig(env = process.env) {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const dbSsl = env.DB_SSL ?? 'require';
  if (dbSsl !== 'require' && dbSsl !== 'off') {
    throw new Error(`DB_SSL must be "require" or "off", got ${JSON.stringify(dbSsl)}`);
  }

  return {
    port: num(env, 'PORT', 8080),
    databaseUrl,
    // Knob 1. Terraform supplies it; the default is the binding-constraint value.
    poolMax: num(env, 'POOL_MAX', 5),
    // Just above the heavy class, so a saturated pool produces 5xx the
    // availability objective catches rather than an unbounded queue that shows
    // only as latency. Raised in plan 3 if the heavy threshold lands higher.
    poolConnectionTimeoutMs: num(env, 'POOL_CONNECTION_TIMEOUT_MS', 900),
    dbSsl,
    migrateOnBoot: flag(env, 'MIGRATE_ON_BOOT'),
    seedOnBoot: flag(env, 'SEED_ON_BOOT'),
    seedRows: num(env, 'SEED_ROWS', 50_000),
    feedPageSize: num(env, 'FEED_PAGE_SIZE', 20),
    // The calibrated cost knob. 0 => the aggregate returns immediately, so an
    // uncalibrated service never silently runs a workload nobody chose.
    reportScanRows: num(env, 'REPORT_SCAN_ROWS', 0),
    serviceName: env.OTEL_SERVICE_NAME ?? 'ecs-rds-postgres-pool',
    // Absent => no exporter is started and the recorders stay no-ops. That is
    // what lets every test run with no collector present.
    otlpEndpoint: env.OTLP_ENDPOINT || undefined,
    exportIntervalMs: num(env, 'OTEL_EXPORT_INTERVAL_MS', 15_000),
    // Same pattern: absent => no CloudWatch publisher and no AWS client.
    metricsNamespace: env.METRICS_NAMESPACE || undefined,
    metricsIntervalMs: num(env, 'METRICS_INTERVAL_MS', 10_000),
  };
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npm test`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add ecs-rds-postgres-pool/service/package.json \
        ecs-rds-postgres-pool/service/src/config.js \
        ecs-rds-postgres-pool/service/test/config.test.js
git commit -m "feat(ecs-rds-postgres-pool/service): scaffold and configuration"
```

---

## Task 2: Prisma schema and migration

**Files:**
- Create: `ecs-rds-postgres-pool/service/prisma/schema.prisma`
- Create: `ecs-rds-postgres-pool/service/prisma/migrations/` (generated)

**Interfaces:**
- Consumes: nothing.
- Produces: the `Feed` model (table `feeds`) and the `Post` model (table `posts`, index
  `post_feed_recent_idx`, foreign key `post_feed_id_fkey`). Tasks 5, 8 and 10 use these exact table
  and column names, because two of the four routes are raw SQL.

- [ ] **Step 1: Write `prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
  // No previewFeatures: the "metrics" feature was removed in Prisma 7.0.0.
  // Pool observability comes from the pg.Pool this service owns (src/pool.js).
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Feed {
  id    Int    @id
  name  String @db.VarChar(64)
  posts Post[]

  @@map("feeds")
}

model Post {
  // Int, never BigInt: Prisma maps BigInt to a JavaScript BigInt, which
  // JSON.stringify refuses to serialize -- every response would throw on the
  // happy path, at the last moment.
  id        Int      @id @default(autoincrement())
  feedId    Int      @map("feed_id")
  author    String   @db.VarChar(32)
  body      String   @db.VarChar(1024)
  score     Int
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  feed Feed @relation(fields: [feedId], references: [id])

  @@index([feedId, createdAt(sort: Desc)], map: "post_feed_recent_idx")
  @@map("posts")
}
```

- [ ] **Step 2: Validate the schema without a database**

Run: `npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid`.

This is the verification for this task. `prisma validate` parses and type-checks against the
provider without connecting, which is what makes a schema task possible with no local Postgres.

- [ ] **Step 3: Generate the client**

Run: `npx prisma generate`
Expected: `Generated Prisma Client`. No database contacted.

- [ ] **Step 4: Create the migration SQL without a database**

Run:

```bash
npx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/0001_init/migration.sql
```

`migrate diff` is offline; `migrate dev` is not, and would try to connect. Create the directory
first. Verify the file contains `CREATE TABLE "feeds"`, `CREATE TABLE "posts"`,
`CREATE INDEX "post_feed_recent_idx"` and an `ALTER TABLE "posts" ADD CONSTRAINT` naming a foreign
key to `"feeds"`. The foreign key is the one easiest to lose in a schema edit and the one this
design exists to exercise.

- [ ] **Step 5: Write the migrations lock file**

`prisma migrate deploy` reads `prisma/migrations/migration_lock.toml` to confirm the migrations were
authored for this provider. `migrate diff` does not create it, because it never touched a migrations
directory. Create it by hand:

```toml
# Please do not edit this file manually
provider = "postgresql"
```

Confirm at execution time that `npx prisma migrate status` complains only about not reaching a
database, and not about the migrations directory itself — that is the check that this file is in the
shape the CLI wants. If it reports a malformed migrations directory, fix it here rather than in
plan 3, where it would surface as a failing container start.

- [ ] **Step 6: Commit**

```bash
git add ecs-rds-postgres-pool/service/prisma/
git commit -m "feat(ecs-rds-postgres-pool/service): prisma schema and initial migration"
```

---

## Task 3: The request context

**Files:**
- Create: `ecs-rds-postgres-pool/service/src/context.js`
- Test: `ecs-rds-postgres-pool/service/test/context.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `runInRequestContext({ route, class: cls }, fn)` and `currentRequest()` returning
  `{ route, class }` or `undefined` outside a request. Task 4 calls `currentRequest()` from inside
  the pool's checkout wrapper; Task 8 calls `runInRequestContext` per request.

This is the mechanism the spec's S1 decision rests on: it is what lets a wait measured deep inside
the pool be attributed to the route and class of the request that caused it.

- [ ] **Step 1: Write the failing test**

`test/context.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInRequestContext, currentRequest } from '../src/context.js';

test('outside a request there is no context', () => {
  assert.equal(currentRequest(), undefined);
});

test('the context is visible synchronously inside the callback', () => {
  runInRequestContext({ route: '/posts', class: 'fast' }, () => {
    assert.deepEqual(currentRequest(), { route: '/posts', class: 'fast' });
  });
});

test('the context survives an await boundary', async () => {
  await runInRequestContext({ route: '/reports', class: 'heavy' }, async () => {
    await new Promise((r) => setTimeout(r, 1));
    assert.deepEqual(currentRequest(), { route: '/reports', class: 'heavy' });
  });
});

test('concurrent requests do not see each other', async () => {
  const seen = [];
  const one = runInRequestContext({ route: '/a', class: 'fast' }, async () => {
    await new Promise((r) => setTimeout(r, 5));
    seen.push(currentRequest().route);
  });
  const two = runInRequestContext({ route: '/b', class: 'heavy' }, async () => {
    await new Promise((r) => setTimeout(r, 1));
    seen.push(currentRequest().route);
  });
  await Promise.all([one, two]);
  assert.deepEqual(seen, ['/b', '/a']);
});

test('the context is gone again after the callback resolves', async () => {
  await runInRequestContext({ route: '/a', class: 'fast' }, async () => {});
  assert.equal(currentRequest(), undefined);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- test/context.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/context.js`**

```js
// src/context.js
// The request's identity, reachable from anywhere inside its async tree.
//
// This exists for ONE reason: the pool's checkout happens deep inside Prisma's
// call stack, with no parameter to thread a route through. Without this, a
// pool-wait histogram is process-global and can say a queue existed but not
// whose requests were in it -- which is the question this project exists to
// answer (spec decision S1).
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/** `fn`'s return value is passed through, so callers can await it. */
export function runInRequestContext(ctx, fn) {
  return storage.run(ctx, fn);
}

/** undefined outside a request -- the pool still works, it just cannot label. */
export function currentRequest() {
  return storage.getStore();
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm test -- test/context.test.js`
Expected: PASS, 5 tests. The concurrency test is the one that matters: it fails if the store is a
module-level variable rather than `AsyncLocalStorage`.

- [ ] **Step 5: Commit**

```bash
git add ecs-rds-postgres-pool/service/src/context.js \
        ecs-rds-postgres-pool/service/test/context.test.js
git commit -m "feat(ecs-rds-postgres-pool/service): async request context for pool attribution"
```

---

## Task 4: The instrumented pool

**Files:**
- Create: `ecs-rds-postgres-pool/service/src/pool.js`
- Test: `ecs-rds-postgres-pool/service/test/pool.test.js`

**Interfaces:**
- Consumes: `currentRequest()` from Task 3.
- Produces:
  - `createPool({ config, onWait })` returning `{ pool, warm, stats, close }`, where `pool` is a
    `pg.Pool` whose `connect` is wrapped, `warm()` opens `config.poolMax` connections concurrently,
    `stats()` returns `{ waiting, idle, total }`, and `close()` ends the pool.
  - `onWait({ seconds, route, class: cls, opened })` is called once per checkout. `opened` is true
    when the pool created a new physical connection to satisfy it.
  - `instrumentConnect(pool, onWait)` — exported separately so the test can drive it against a fake.

This is the highest-risk code in the plan. Two things must hold: the wrapper must never leak a
connection (a leak exhausts the pool and every later run measures the leak instead of the design),
and it must distinguish a real queue from a new connection being established — the spec's §4.2
contaminant that produces opposite diagnoses in one series.

- [ ] **Step 1: Write the failing test**

`test/pool.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- test/pool.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/pool.js`**

```js
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
 * Exported for the tests, which drive it against a fake pool -- there is no
 * local Postgres in this project by design.
 */
export function instrumentConnect(pool, onWait) {
  const original = pool.connect.bind(pool);
  pool.connect = async function instrumentedConnect(...args) {
    const before = pool.totalCount;
    const t0 = process.hrtime.bigint();
    try {
      return await original(...args);
    } finally {
      const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
      const ctx = currentRequest();
      try {
        onWait({
          seconds,
          route: ctx?.route,
          class: ctx?.class,
          opened: pool.totalCount > before,
        });
      } catch {
        // A recorder must never be able to fail a request. Swallowing here is
        // deliberate: the alternative is that an OTel hiccup becomes a 5xx and
        // burns the availability budget this project is trying to measure.
      }
    }
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
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm test -- test/pool.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add ecs-rds-postgres-pool/service/src/pool.js \
        ecs-rds-postgres-pool/service/test/pool.test.js
git commit -m "feat(ecs-rds-postgres-pool/service): instrumented connection pool"
```

---

## Task 5: The repository — the four queries

**Files:**
- Create: `ecs-rds-postgres-pool/service/src/db.js`
- Test: `ecs-rds-postgres-pool/service/test/db.test.js`

**Interfaces:**
- Consumes: `createPool` from Task 4; the `Feed` and `Post` models from Task 2.
- Produces: `createRepo({ prisma, config })` returning `{ getPost(id)`, `createPost(post)`,
  `feedPage(feedId, limit)`, `report({ scanRows, post })` `}`, plus `buildPost(feedId)`,
  `randomAuthor()`, `BODY_BYTES` and `createPrisma(pool)`. Task 8 calls all of these.

**Every one of the four is exactly one statement.** The test asserts the count, because the
capacity arithmetic depends on it and a second query is the easiest thing in the world to add by
accident — a Prisma `include` is one line and issues two.

- [ ] **Step 1: Write the failing test**

`test/db.test.js`. The Prisma client is faked — there is no database, and the point is that the
right statement is issued with the right bound parameters, not that Postgres can run it.

```js
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

const config = { feedPageSize: 20, reportScanRows: 0, seedFeeds: 16 };

test('a post body is the configured width', () => {
  assert.equal(buildPost(0).body.length, BODY_BYTES);
  assert.equal(BODY_BYTES, 940);
});

test('a built post names a feed inside the seeded range', () => {
  const p = buildPost(7);
  assert.equal(p.feedId, 7);
  assert.ok(p.author.length > 0);
});

test('getPost is one statement, a primary-key lookup', async () => {
  const prisma = fakePrisma();
  await createRepo({ prisma, config }).getPost(42);
  assert.equal(prisma.calls.length, 1, 'one statement per request');
  assert.deepEqual(prisma.calls[0][1], { where: { id: 42 } });
});

test('createPost is one statement and carries the foreign key', async () => {
  const prisma = fakePrisma();
  await createRepo({ prisma, config }).createPost(buildPost(3));
  assert.equal(prisma.calls.length, 1, 'one statement per request');
  assert.equal(prisma.calls[0][1].data.feedId, 3);
});

test('feedPage is one raw statement joining posts to feeds', async () => {
  const prisma = fakePrisma();
  await createRepo({ prisma, config }).feedPage(5, 20);
  assert.equal(prisma.calls.length, 1, 'one statement per request');
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
```

**On asserting against `$queryRaw`:** Prisma's tagged-template form receives a template-strings
array, so `String(sql)` in these assertions flattens it to the SQL text with the interpolation slots
elided. That is enough to assert the statement's *shape*. Do not switch to `$queryRawUnsafe` to make
the assertions easier to write — the row count and the foreign key reach the database as bound
parameters, and `$queryRawUnsafe` with string interpolation would put a request-controlled value
into SQL text.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- test/db.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/db.js`**

```js
// src/db.js
// Prisma Client over the pg.Pool this service owns, plus the four statements.
//
// ONE STATEMENT PER ROUTE, always. One statement is one pool checkout, and the
// capacity model -- pool of 5 divided by a 20 ms hold time = 250 rps -- is only
// true at one checkout per request. The two read-heavy routes are raw SQL
// rather than Prisma query-builder calls precisely so the statement count is
// visible in the source instead of depending on a relation-loading strategy.
import { PrismaClient, Prisma } from '@prisma/client';
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
    /** fast: primary-key lookup. */
    getPost: (id) => prisma.post.findUnique({ where: { id } }),

    /** fast: one insert, plus the foreign-key probe against feeds. */
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
```

**One thing to confirm at execution time rather than assume:** that `$queryRaw`'s tagged-template
form accepts an interpolation in `LIMIT`. Postgres accepts a bound parameter there, and Prisma
passes interpolations as bind parameters, so it should hold — but if the driver rejects it, the fix
is `Prisma.sql` with an explicitly typed fragment, **not** `$queryRawUnsafe` with string
interpolation, which would put a value into SQL text.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm test -- test/db.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add ecs-rds-postgres-pool/service/src/db.js \
        ecs-rds-postgres-pool/service/test/db.test.js
git commit -m "feat(ecs-rds-postgres-pool/service): repository and the calibrated scan knob"
```

---

## Task 6: Timing and ELU — the ported modules

**Files:**
- Create: `ecs-rds-postgres-pool/service/src/timing.js` (from `ecs-dynamodb-rps/service/src/timing.js`)
- Create: `ecs-rds-postgres-pool/service/src/elu.js` (from the sibling, verbatim)
- Create: `ecs-rds-postgres-pool/service/src/cloudwatch.js` (from the sibling, verbatim)
- Test: `ecs-rds-postgres-pool/service/test/timing.test.js`, `test/elu.test.js`, `test/cloudwatch.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `createTimer()` → `{ measure(name, fn), measureSync(name, fn), phases() }` with phases in
  **seconds**; `createEluSampler({ performance })` → `{ sample() }`; and from `cloudwatch.js`,
  `createEluPublisher` plus the `METRIC_NAME` and `DIMENSION_NAME` constants its test imports.
  Tasks 7, 8 and 9 use these. Take the exact export names from the sibling files rather than from
  this list if the two ever disagree — these are copies, not reimplementations.

The spec takes the sibling's event-loop instrumentation and leaves its admission control and
autoscaling behind (decision S3). `elu.js` and `cloudwatch.js` come over unchanged; `admission.js`
does **not** come over at all.

**`cpu.js` is deliberately not forked, which diverges from the file list in the spec's "Queue [1]:
what gets forked".** That table pairs `elu.js` with `cpu.js` as though they were one unit. They are
not: `elu.js` imports only `node:perf_hooks`, and `cpu.js` contains nothing but `burn()`, the
pbkdf2 cost knob. In the sibling, CPU cost is how the service is made to bind before DynamoDB does;
here the cost knob lives in the database instead (`report`'s aggregate, Task 5), so `burn()` would have
no caller. Forking it would ship dead code into a project whose whole question is where time goes.
The spec has been corrected to match.

- [ ] **Step 1: Copy the three files and their tests**

```bash
cd /Users/koval/dev/test/high-load-test
for f in timing elu cloudwatch; do
  cp ecs-dynamodb-rps/service/src/$f.js ecs-rds-postgres-pool/service/src/$f.js
  cp ecs-dynamodb-rps/service/test/$f.test.js ecs-rds-postgres-pool/service/test/$f.test.js
done
```

- [ ] **Step 2: Add the fork header to each copied file**

At the top of each of the three `src/` files, directly under the existing `// src/<name>.js` line:

```js
// Forked from ecs-dynamodb-rps/service/src/<name>.js on 2026-09-20, unchanged.
// A bug fixed here does not reach the sibling copy; fix both.
```

- [ ] **Step 3: Confirm nothing references a DynamoDB-only module**

Run:

```bash
cd ecs-rds-postgres-pool/service && grep -rn "dynamo\|admission\|@aws-sdk/client-dynamodb" src/ test/
```

Expected: no matches. If `cloudwatch.test.js` imports anything DynamoDB-shaped, delete that test
case — the CloudWatch publisher itself only publishes EventLoopUtilization and is datastore-agnostic.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS. Tasks 1–5's tests still pass alongside.

- [ ] **Step 5: Commit**

```bash
git add ecs-rds-postgres-pool/service/src/ ecs-rds-postgres-pool/service/test/
git commit -m "feat(ecs-rds-postgres-pool/service): fork timing, elu and cloudwatch"
```

---

## Task 7: OpenTelemetry — the pool histogram and gauges

**Files:**
- Create: `ecs-rds-postgres-pool/service/src/otel.js` (from `ecs-dynamodb-rps/service/src/otel.js`)
- Test: `ecs-rds-postgres-pool/service/test/otel.test.js`

**Interfaces:**
- Consumes: `stats()` from Task 4.
- Produces: `startTelemetry({ config, poolStats })` → `{ recordRequest({ route, class: cls, status, seconds, phases }), recordPoolWait({ seconds, route, class: cls, opened }), shutdown() }`.
  Task 9 calls `recordRequest`; Task 4's `onWait` is wired to `recordPoolWait`.

- [ ] **Step 1: Copy the sibling's `otel.js` and its test as the starting point**

```bash
cp ecs-dynamodb-rps/service/src/otel.js ecs-rds-postgres-pool/service/src/otel.js
cp ecs-dynamodb-rps/service/test/otel.test.js ecs-rds-postgres-pool/service/test/otel.test.js
```

Add the fork header from Task 6, with "unchanged" replaced by "plus the pool instruments below".

- [ ] **Step 2: Write the failing test for the new instruments**

Append to `test/otel.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTelemetry } from '../src/otel.js';

const base = { serviceName: 'test', exportIntervalMs: 60_000 };

test('with no OTLP endpoint the recorders are no-ops and nothing is started', () => {
  const t = startTelemetry({ config: { ...base, otlpEndpoint: undefined }, poolStats: () => ({ waiting: 0, idle: 0, total: 0 }) });
  // Must not throw, must not need a collector.
  t.recordRequest({ route: '/posts', class: 'fast', status: 200, seconds: 0.01, phases: { db: 0.005 } });
  t.recordPoolWait({ seconds: 0.002, route: '/posts', class: 'fast', opened: false });
  return t.shutdown();
});

test('recordPoolWait accepts an unlabelled wait without throwing', () => {
  const t = startTelemetry({ config: { ...base, otlpEndpoint: undefined }, poolStats: () => ({ waiting: 0, idle: 0, total: 0 }) });
  t.recordPoolWait({ seconds: 0.002, route: undefined, class: undefined, opened: true });
  return t.shutdown();
});

test('poolStats is not called until the exporter is running', () => {
  let calls = 0;
  const t = startTelemetry({
    config: { ...base, otlpEndpoint: undefined },
    poolStats: () => { calls += 1; return { waiting: 0, idle: 0, total: 0 }; },
  });
  assert.equal(calls, 0, 'observable callbacks must not be registered without an exporter');
  return t.shutdown();
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm test -- test/otel.test.js`
Expected: FAIL — `recordPoolWait is not a function`.

- [ ] **Step 4: Add the instruments to `src/otel.js`**

Inside the function that builds the meters, after the existing request and phase histograms:

```js
// Pool wait, per class. THE metric this project exists to produce (spec S1).
//
// Buckets are tighter at the bottom than the request histogram's: a healthy
// checkout from a warm pool is sub-millisecond, and the interesting range is
// the two decades above that. A bucket set copied from request latency would
// put every healthy checkout in one bucket and every queued one in the next.
const poolWait = meter.createHistogram('db.pool.wait.duration', {
  description: 'Time a request waited to check a connection out of the pool',
  unit: 's',
  advice: {
    explicitBucketBoundaries: [
      0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025,
      0.05, 0.1, 0.25, 0.5, 1, 2.5,
    ],
  },
});

// Three gauges, read from the pool on each export tick. `total` is what tells a
// setup cost apart from a real queue: it rises exactly when a connection is
// being created (spec 4.2).
const waiting = meter.createObservableGauge('db.pool.waiting', {
  description: 'Requests currently queued for a connection',
});
const idle = meter.createObservableGauge('db.pool.idle', {
  description: 'Connections currently idle in the pool',
});
const total = meter.createObservableGauge('db.pool.total', {
  description: 'Connections the pool currently holds',
});
meter.addBatchObservableCallback((observer) => {
  const s = poolStats();
  observer.observe(waiting, s.waiting);
  observer.observe(idle, s.idle);
  observer.observe(total, s.total);
}, [waiting, idle, total]);
```

And the recorder, alongside the existing `recordRequest`:

```js
recordPoolWait({ seconds, route, class: cls, opened }) {
  const attrs = { 'pool.opened': Boolean(opened) };
  // Unlabelled waits still count -- a checkout from the boot-time pre-warm has
  // no request context. Omitting the keys keeps them out of the per-class
  // series rather than minting an "undefined" class.
  if (route) attrs['http.route'] = route;
  if (cls) attrs.class = cls;
  poolWait.record(seconds, attrs);
},
```

Both the gauge callback and the histogram must live inside the branch that only runs when
`config.otlpEndpoint` is set, so the third test passes.

- [ ] **Step 5: Run the test and watch it pass**

Run: `npm test -- test/otel.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ecs-rds-postgres-pool/service/src/otel.js \
        ecs-rds-postgres-pool/service/test/otel.test.js
git commit -m "feat(ecs-rds-postgres-pool/service): pool wait histogram and pool gauges"
```

---

## Task 8: Handlers — the four routes

**Files:**
- Create: `ecs-rds-postgres-pool/service/src/handlers.js`
- Test: `ecs-rds-postgres-pool/service/test/handlers.test.js`

**Interfaces:**
- Consumes: `createRepo` (Task 5), `createTimer` (Task 6).
- Produces: `matchRoute(method, path)` → `{ name, params, template }` or `null`; `ROUTE_CLASS`, a map
  from route name to latency class; `createHandlers({ repo, config })` → an object keyed by route
  name, each `async ({ params, body, timer }) => ({ status, body })`. Task 9 consumes both.

- [ ] **Step 1: Write the failing test**

`test/handlers.test.js`:

```js
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
    'one statement, one checkout -- the capacity model assumes it');
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- test/handlers.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/handlers.js`**

```js
// src/handlers.js
// Route shape forked from ecs-dynamodb-rps/service/src/handlers.js on
// 2026-09-20; the bodies are SQL and are this project's own.
import { buildPost } from './db.js';

// `template` is the route PATTERN, never the concrete path. It is the metric's
// http.route attribute and the key the collector maps to a latency class, so a
// raw path here would mint one time series per post id.
const ROUTES = [
  { name: 'health',     method: 'GET',  re: /^\/healthz$/,                 keys: [],     template: '/healthz' },
  { name: 'feed',       method: 'GET',  re: /^\/feeds\/([^/]+)\/posts$/,   keys: ['id'], template: '/feeds/:id/posts' },
  { name: 'getPost',    method: 'GET',  re: /^\/posts\/([^/]+)$/,          keys: ['id'], template: '/posts/:id' },
  { name: 'createPost', method: 'POST', re: /^\/posts$/,                   keys: [],     template: '/posts' },
  { name: 'report',     method: 'POST', re: /^\/reports$/,                 keys: [],     template: '/reports' },
];

/**
 * The single source of truth for which class a route belongs to. slo.yaml's
 * `classes` block and infra/grafana/classmap.json must agree with this, and
 * test/generate-slo.test.js asserts both directions, so a renamed route fails
 * the build instead of silently leaving traffic unclassified. /healthz is
 * deliberately absent: it carries no objective.
 */
export const ROUTE_CLASS = {
  getPost: 'fast',
  createPost: 'fast',
  feed: 'standard',
  report: 'heavy',
};

export function matchRoute(method, path) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = r.re.exec(path);
    if (!m) continue;
    return { name: r.name, params: Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]])), template: r.template };
  }
  return null;
}

/** A positive integer, or null. Keeps a malformed id away from the pool. */
function toId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Real, deterministic work over the page: sort, then aggregate. */
function summarize(rows) {
  const sorted = [...rows].sort((a, b) => (a.score < b.score ? 1 : a.score > b.score ? -1 : 0));
  let bytes = 0;
  for (const r of sorted) bytes += r.body ? r.body.length : 0;
  return { count: sorted.length, bytes, top: sorted[0]?.id ?? null, feed: sorted[0]?.feed_name ?? null };
}

export function createHandlers({ repo, config }) {
  // Spread inserts across the seeded feeds rather than hammering one, so the
  // write path does not turn into a single-page hot spot that no production
  // workload would have.
  const someFeed = () => 1 + Math.floor(Math.random() * config.seedFeeds);

  return {
    async health() { return { status: 200, body: { ok: true } }; },

    async getPost({ params, timer }) {
      const id = toId(params.id);
      if (id === null) return { status: 400, body: { error: 'id must be a positive integer' } };
      const post = await timer.measure('db', () => repo.getPost(id));
      return post ? { status: 200, body: post } : { status: 404, body: { error: 'not found' } };
    },

    async createPost({ timer }) {
      const post = buildPost(someFeed());
      const created = await timer.measure('db', () => repo.createPost(post));
      return { status: 201, body: { id: created.id, feedId: post.feedId } };
    },

    async feed({ params, timer }) {
      const id = toId(params.id);
      if (id === null) return { status: 400, body: { error: 'id must be a positive integer' } };
      const rows = await timer.measure('db', () => repo.feedPage(id, config.feedPageSize));
      const body = timer.measureSync('cpu', () => summarize(rows));
      return { status: 200, body };
    },

    /**
     * The heavy route and the longest hold: ONE data-modifying CTE that scans
     * config.reportScanRows rows, aggregates them and inserts a row. One
     * statement, therefore one pool checkout -- the capacity model in the spec
     * assumes exactly that, and test/db.test.js asserts it.
     */
    async report({ body, timer }) {
      const feedId = toId(body?.feedId) ?? someFeed();
      const post = buildPost(feedId);
      const out = await timer.measure('db', () => repo.report({ scanRows: config.reportScanRows, post }));
      return {
        status: 200,
        body: { feedId, scanned: out.n, bytes: out.bytes, feeds: out.feeds, recordId: out.recordId },
      };
    },
  };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm test -- test/handlers.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add ecs-rds-postgres-pool/service/src/handlers.js \
        ecs-rds-postgres-pool/service/test/handlers.test.js
git commit -m "feat(ecs-rds-postgres-pool/service): the four SQL routes"
```

---

## Task 9: The server

**Files:**
- Create: `ecs-rds-postgres-pool/service/src/server.js`
- Test: `ecs-rds-postgres-pool/service/test/server.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: `createServer({ handlers, telemetry, config })` → a `node:http` server; and a
  `main()` that wires config → pool → prisma → repo → handlers → telemetry → listen. `createServer`
  is exported separately so the test can drive it over a real socket with fake handlers, no database.

- [ ] **Step 1: Write the failing test**

`test/server.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

const noopTelemetry = { recordRequest() {}, recordPoolWait() {}, async shutdown() {} };

function start(handlers) {
  const server = createServer({ handlers, telemetry: noopTelemetry, config: { port: 0 } });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const handlers = {
  async health() { return { status: 200, body: { ok: true } }; },
  async getPost() { return { status: 200, body: { id: 1 } }; },
  async createPost() { return { status: 201, body: { id: 2 } }; },
  async feed() { return { status: 200, body: { count: 0 } }; },
  async report() { return { status: 200, body: { scanned: 0 } }; },
};

test('healthz answers 200', async () => {
  const { server, url } = await start(handlers);
  const res = await fetch(`${url}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  server.close();
});

test('an unknown path is 404 and is not recorded as a route', async () => {
  const seen = [];
  const server = createServer({
    handlers,
    telemetry: { ...noopTelemetry, recordRequest: (r) => seen.push(r) },
    config: { port: 0 },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(res.status, 404);
  assert.equal(seen.length, 0, 'an unmatched path must not mint a time series');
  server.close();
});

test('a handler that throws becomes a 500, and the request is still recorded', async () => {
  const seen = [];
  const server = createServer({
    handlers: { ...handlers, feed: async () => { throw new Error('boom'); } },
    telemetry: { ...noopTelemetry, recordRequest: (r) => seen.push(r) },
    config: { port: 0 },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/feeds/3/posts`);
  assert.equal(res.status, 500);
  assert.equal(seen[0].status, 500);
  assert.equal(seen[0].route, '/feeds/:id/posts');
  server.close();
});

test('a recorded request carries the route template and its class', async () => {
  const seen = [];
  const server = createServer({
    handlers,
    telemetry: { ...noopTelemetry, recordRequest: (r) => seen.push(r) },
    config: { port: 0 },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await fetch(`http://127.0.0.1:${port}/posts/42`);
  assert.equal(seen[0].route, '/posts/:id');
  assert.equal(seen[0].class, 'fast');
  assert.ok(seen[0].seconds >= 0);
  server.close();
});

test('malformed JSON on a POST is a 400, not a 500', async () => {
  const { server, url } = await start(handlers);
  const res = await fetch(`${url}/reports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  server.close();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- test/server.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server.js`**

```js
// src/server.js
// Forked in shape from ecs-dynamodb-rps/service/src/server.js on 2026-09-20.
// Differences: no admission control (spec S3 -- shedding 429s would stop a
// saturated pool ever producing the 5xx this project measures), and the pool is
// pre-warmed before listen.
import http from 'node:http';
import { loadConfig } from './config.js';
import { createPool } from './pool.js';
import { createPrisma, createRepo } from './db.js';
import { createHandlers, matchRoute, ROUTE_CLASS } from './handlers.js';
import { createTimer } from './timing.js';
import { runInRequestContext } from './context.js';
import { startTelemetry } from './otel.js';

const send = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
};

async function readJson(req) {
  if (req.method !== 'POST') return undefined;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createServer({ handlers, telemetry, config }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = matchRoute(req.method, url.pathname);
    if (!route) return send(res, 404, { error: 'not found' });

    const cls = ROUTE_CLASS[route.name];
    const timer = createTimer();
    const t0 = process.hrtime.bigint();

    // The context wraps the WHOLE handler, so a pool checkout anywhere inside
    // it -- including inside Prisma's own call stack -- can name this request.
    await runInRequestContext({ route: route.template, class: cls }, async () => {
      let status = 500;
      let body = { error: 'internal' };
      try {
        const parsed = await readJson(req);
        const out = await handlers[route.name]({ params: route.params, body: parsed, timer });
        status = out.status;
        body = out.body;
      } catch (err) {
        if (err instanceof SyntaxError) { status = 400; body = { error: 'malformed json' }; }
        // Anything else stays a 500. A 5xx is a miss however fast it was, and
        // that is deliberate: a pool that times out under load SHOULD burn the
        // availability budget.
      }
      send(res, status, body);
      telemetry.recordRequest({
        route: route.template,
        class: cls,
        status,
        seconds: Number(process.hrtime.bigint() - t0) / 1e9,
        phases: timer.phases(),
      });
    });
  });
}

export async function main() {
  const config = loadConfig();

  // `telemetry` is referenced by onWait before it is assigned, which is safe
  // because onWait only fires on a checkout and the first checkout is warm()
  // below, after the assignment. The optional call covers the ordering anyway.
  let telemetry;
  const { pool, warm, stats, close } = createPool({
    config,
    onWait: (w) => telemetry?.recordPoolWait(w),
  });

  telemetry = startTelemetry({ config, poolStats: stats });

  const prisma = createPrisma(pool);
  const repo = createRepo({ prisma, config });
  const handlers = createHandlers({ repo, config });

  // Open every connection BEFORE listening, so no measured request pays for
  // TCP + TLS + auth and records it as pool wait (spec 4.2).
  await warm();

  const server = createServer({ handlers, telemetry, config });
  server.listen(config.port, () => console.log(`listening on ${config.port}, pool max ${config.poolMax}`));

  const stop = async () => {
    server.close();
    await telemetry.shutdown();   // flush: an unflushed interval is a hole in the window
    await prisma.$disconnect();
    await close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm test -- test/server.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all green, no test requiring a database, AWS or a collector.

- [ ] **Step 6: Commit**

```bash
git add ecs-rds-postgres-pool/service/src/server.js \
        ecs-rds-postgres-pool/service/test/server.test.js
git commit -m "feat(ecs-rds-postgres-pool/service): http server and boot wiring"
```

---

## Task 10: Seed and migrate-on-boot

**Files:**
- Create: `ecs-rds-postgres-pool/service/prisma/seed.js`
- Modify: `ecs-rds-postgres-pool/service/src/server.js` — add the boot-time step to `main()`
- Test: `ecs-rds-postgres-pool/service/test/seed.test.js`

**Interfaces:**
- Consumes: `BODY_BYTES` (Task 5).
- Produces: `buildFeeds(count)`, `buildPostBatch(feedId, offset, count)` and
  `seedAll(prisma, { rows, feeds })`. The seed is deterministic so two environments hold identical
  data and a run in one is comparable to a run in the other.

- [ ] **Step 1: Write the failing test**

`test/seed.test.js`:

```js
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- test/seed.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `prisma/seed.js`**

```js
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

export async function seedAll(prisma, { rows, feeds }) {
  // Feeds first: every post carries a foreign key into this table, so seeding
  // posts first fails on the constraint rather than on anything informative.
  await prisma.feed.createMany({ data: buildFeeds(feeds), skipDuplicates: true });

  const perFeed = Math.ceil(rows / feeds);
  for (let f = 1; f <= feeds; f += 1) {
    for (let offset = 0; offset < perFeed; offset += BATCH) {
      const batch = buildPostBatch(f, offset, Math.min(BATCH, perFeed - offset));
      await prisma.post.createMany({ data: batch, skipDuplicates: true });
    }
  }

  // Without this the planner has no statistics, and the first run of a session
  // measures a different query plan than the second (spec 5). VACUUM cannot run
  // inside a transaction block, which is why it is $executeRawUnsafe on its own
  // rather than part of a batch.
  await prisma.$executeRawUnsafe('VACUUM ANALYZE feeds');
  await prisma.$executeRawUnsafe('VACUUM ANALYZE posts');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { createPrisma } = await import('../src/db.js');
  const { createPool } = await import('../src/pool.js');
  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();
  const { pool, close } = createPool({ config, onWait: () => {} });
  const prisma = createPrisma(pool);
  await seedAll(prisma, { rows: config.seedRows, feeds: config.seedFeeds });
  await prisma.$disconnect();
  await close();
}
```

- [ ] **Step 4: Add the boot step to `src/server.js`**

In `main()`, immediately before `await warm()`:

```js
  // D4: migrations and seed run at container start, behind a flag. Prisma
  // Migrate takes a Postgres advisory lock, so a rolling deploy does not race
  // itself -- which is why this is safe to do on every task rather than in a
  // one-off job that would need a NAT gateway to reach the VPC.
  if (config.migrateOnBoot) {
    const { execFileSync } = await import('node:child_process');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit' });
  }
  if (config.seedOnBoot) {
    const { seedAll } = await import('../prisma/seed.js');
    await seedAll(prisma, { rows: config.seedRows, feeds: config.seedFeeds });
  }
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: all green. The boot step is not exercised by a test — it needs a database — and that is
stated here so the next reader knows it is the first thing to fail in plan 3, not an oversight.

- [ ] **Step 6: Commit**

```bash
git add ecs-rds-postgres-pool/service/prisma/seed.js \
        ecs-rds-postgres-pool/service/src/server.js \
        ecs-rds-postgres-pool/service/test/seed.test.js
git commit -m "feat(ecs-rds-postgres-pool/service): deterministic seed and boot-time migrate"
```

---

## Task 11: `slo.yaml` and the generator

**Files:**
- Create: `ecs-rds-postgres-pool/slo.yaml`
- Create: `ecs-rds-postgres-pool/service/scripts/generate-slo.js` (from the sibling)
- Test: `ecs-rds-postgres-pool/service/test/generate-slo.test.js`

**Interfaces:**
- Consumes: `ROUTE_CLASS` (Task 8).
- Produces: `npm run slo:generate` and `npm run slo:check`. The k6 threshold file and the Grafana
  class map are generated in **plan 2**, from this same source; this task establishes the source and
  the generator.

- [ ] **Step 1: Write `ecs-rds-postgres-pool/slo.yaml`**

```yaml
service: ecs-rds-postgres-pool

# The SLO is defined over LOAD-BEARING traffic; authoritative attainment is
# run-scoped, over a load run's own window, as results.md records it.
#
# THE WINDOW IS PINNED AT 7d and is not a lever. Grafana's SLO API refuses any
# window outside 7-32 days and Grafana Cloud Free retains 14, so 7d..14d is the
# whole legal range. A SHORTER window burns the budget FASTER, not slower.
window: 7d

endpoints:
  getPost:    /posts/:id
  createPost: /posts
  feed:       /feeds/:id/posts
  report:     /reports

slos:
  - name: latency-classes
    sli: class_threshold_ratio
    # A request is GOOD when it meets its class threshold AND is not a 5xx.
    # A 4xx is NOT a miss in Grafana; k6's own SLI requires a 2xx. This project
    # has no admission control, so the two verdicts do not diverge -- there is
    # no path that produces a 4xx by design.
    objective: 95.0
    tail_objective: 99.0
    tail_multiplier: 3
    classes:
      # THRESHOLDS ARE DELIBERATELY UNSET. They are frozen in plan 3, after
      # calibration on the real db.t4g.micro, because they are what the k6 VU
      # sizing is derived from and inventing them now would be inventing the
      # assertion this project exists to test. `npm run slo:check` fails while
      # any threshold_ms is null -- that is the guard, not an oversight.
      fast:     { threshold_ms: null, endpoints: [getPost, createPost] }
      standard: { threshold_ms: null, endpoints: [feed] }
      heavy:    { threshold_ms: null, endpoints: [report] }

  - name: availability
    sli: success_rate
    objective: 99.9

# Advisory only -- infra/main/dev.tfvars is authoritative for every sizing knob,
# the same arrangement the sibling adopted on 2026-09-18 after a generated file
# made overrides silent rather than preventing them.
capacity:
  target_rps: null          # set in plan 3, from the discovered knee
  mix: { read: 0.55, write: 0.15, feed: 0.25, report: 0.05 }
  pool:
    baseline_size: 5
    released_size: 25
    max_connections_estimate: 112   # SHOW max_connections on the real instance

attribution:
  vcpu_per_task: 0.25
  # There is no server-side per-operation latency in Postgres to subtract, so
  # the sibling's queueing estimate has no analogue. Queue depth is measured
  # directly instead: db.pool.wait.duration, per class.
  pool_wait_metric: db.pool.wait.duration
```

- [ ] **Step 2: Copy the generator and its test**

```bash
cp ecs-dynamodb-rps/service/scripts/generate-slo.js ecs-rds-postgres-pool/service/scripts/generate-slo.js
cp ecs-dynamodb-rps/service/test/generate-slo.test.js ecs-rds-postgres-pool/service/test/generate-slo.test.js
```

Add the fork header from Task 6.

- [ ] **Step 3: Write the failing test for the two behaviour changes**

Append to `test/generate-slo.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSlo, renderCapacityAdvisory } from '../scripts/generate-slo.js';

const doc = () => ({
  service: 'ecs-rds-postgres-pool',
  endpoints: { getPost: '/posts/:id', createPost: '/posts', feed: '/feeds/:id/posts', report: '/reports' },
  slos: [{
    name: 'latency-classes', sli: 'class_threshold_ratio', objective: 95, tail_objective: 99,
    classes: {
      fast: { threshold_ms: null, endpoints: ['getPost', 'createPost'] },
      standard: { threshold_ms: null, endpoints: ['feed'] },
      heavy: { threshold_ms: null, endpoints: ['report'] },
    },
  }],
  capacity: { target_rps: null, pool: { baseline_size: 5, released_size: 25 } },
});

test('an unset threshold fails the check with a message naming the class', () => {
  assert.throws(() => validateSlo(doc()), /fast.*threshold_ms|threshold_ms.*fast/i);
});

test('once thresholds are set the document validates', () => {
  const d = doc();
  d.slos[0].classes.fast.threshold_ms = 50;
  d.slos[0].classes.standard.threshold_ms = 200;
  d.slos[0].classes.heavy.threshold_ms = 800;
  assert.doesNotThrow(() => validateSlo(d));
});

test('every endpoint belongs to exactly one class', () => {
  const d = doc();
  d.slos[0].classes.fast.threshold_ms = 50;
  d.slos[0].classes.standard.threshold_ms = 200;
  d.slos[0].classes.heavy.threshold_ms = 800;
  d.slos[0].classes.heavy.endpoints.push('feed');
  assert.throws(() => validateSlo(d), /feed/);
});

test('the capacity advisory prints pool size and never contributes an exit code', () => {
  const out = renderCapacityAdvisory(doc(), { poolMax: 5, desiredCount: 1 });
  assert.match(out, /advisory/i);
  assert.match(out, /5/);
});
```

**Keep the sibling's route cross-check test** — it is the one that makes the comment in
`handlers.js` true rather than aspirational. `ecs-dynamodb-rps/service/test/generate-slo.test.js`
carries a case reading *"every endpoint in slo.yaml maps to a route template that handlers.js
serves"*, which rebuilds a concrete path from each template and asks `matchRoute` for it. It comes
across with the file. Add its mirror, which the sibling does not have and which this project needs
because `ROUTE_CLASS` is a second copy of the same mapping:

```js
import { ROUTE_CLASS } from '../src/handlers.js';

test('ROUTE_CLASS and slo.yaml agree on every route’s class', () => {
  const d = doc();
  d.slos[0].classes.fast.threshold_ms = 50;
  d.slos[0].classes.standard.threshold_ms = 200;
  d.slos[0].classes.heavy.threshold_ms = 800;
  const fromYaml = {};
  for (const [cls, body] of Object.entries(d.slos[0].classes)) {
    for (const ep of body.endpoints) fromYaml[ep] = cls;
  }
  assert.deepEqual(ROUTE_CLASS, fromYaml);
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `npm test -- test/generate-slo.test.js`
Expected: FAIL — `renderCapacityAdvisory is not a function`, and the null-threshold test passes only
once the guard exists.

- [ ] **Step 5: Adapt the generator**

Three changes, and no others:

1. Delete `renderCapacityTfvars` and everything that writes `capacity.auto.tfvars`. RCU/WCU has no
   analogue, and the sibling deleted the generated-tfvars arrangement on 2026-09-18 anyway.
2. Add `renderCapacityAdvisory(doc, { poolMax, desiredCount })`, returning a printable block naming
   the pool size, the task count, their product, and the `max_connections_estimate` from the
   document. Print it from both `slo:generate` and `slo:check`, **before** any drift exit, so a run
   failing on some other output still says what the pool is set to. It never contributes to the exit
   code.
3. Add the null guard to `validateSlo`: any class whose `threshold_ms` is `null` or missing throws,
   naming the class. This is what keeps the deliberately-unset thresholds from reaching plan 2.

- [ ] **Step 6: Run the test and watch it pass**

Run: `npm test -- test/generate-slo.test.js`
Expected: PASS.

- [ ] **Step 7: Confirm `slo:check` fails as designed, for the right reason**

Run: `npm run slo:check`
Expected: **non-zero exit**, with a message naming `fast` and `threshold_ms`. This is the red state
that plan 3 turns green; if it exits 0 here, the guard is not wired.

- [ ] **Step 8: Commit**

```bash
git add ecs-rds-postgres-pool/slo.yaml \
        ecs-rds-postgres-pool/service/scripts/generate-slo.js \
        ecs-rds-postgres-pool/service/test/generate-slo.test.js
git commit -m "feat(ecs-rds-postgres-pool): slo source of truth with thresholds left open"
```

---

## Task 12: The calibration script

**Files:**
- Create: `ecs-rds-postgres-pool/service/scripts/calibrate.js`
- Test: `ecs-rds-postgres-pool/service/test/calibrate.test.js`

**Interfaces:**
- Consumes: `createPool`, `createPrisma`, `createRepo`.
- Produces: `searchScanRows({ measure, targetMs, lo, hi, tolerance })` → `{ rows, ms, iterations }`,
  a pure binary search over a measurement function, and a CLI that supplies the real one.

Used in plan 3, written here because it is service code and this is the service plan. The search is
pure so it can be tested without a database; the CLI half cannot be, which is stated rather than
faked.

- [ ] **Step 1: Write the failing test**

`test/calibrate.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchScanRows } from '../scripts/calibrate.js';

/** Hold time rises linearly with rows: 200 rows per millisecond. */
const linear = async (rows) => rows / 200;

test('finds the row count that hits the target hold time', async () => {
  const r = await searchScanRows({ measure: linear, targetMs: 20, lo: 0, hi: 100_000, tolerance: 0.5 });
  assert.ok(Math.abs(r.ms - 20) <= 0.5, `got ${r.ms} ms at ${r.rows} rows`);
  assert.ok(r.rows > 3800 && r.rows < 4200, `expected ~4000 rows, got ${r.rows}`);
});

test('it terminates rather than spinning when the target is unreachable', async () => {
  const r = await searchScanRows({ measure: async () => 1, targetMs: 500, lo: 0, hi: 1000, tolerance: 0.5 });
  assert.ok(r.iterations <= 20, `binary search must bound its iterations, took ${r.iterations}`);
  assert.equal(r.rows, 1000, 'an unreachable target pins at the top of the range');
});

test('it reports how many probes it took, so a noisy measurement is visible', async () => {
  const r = await searchScanRows({ measure: linear, targetMs: 20, lo: 0, hi: 100_000, tolerance: 0.5 });
  assert.ok(r.iterations > 0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- test/calibrate.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `scripts/calibrate.js`**

```js
// scripts/calibrate.js
// Finds the REPORT_SCAN_ROWS that makes the heavy route hold a connection for
// the target time (spec 5). Run against the DEPLOYED instance, never locally --
// the number is CPU- and instance-specific, exactly as the sibling's
// pbkdf2_iterations is.
//
// The search is pure and separately exported so it can be tested with no
// database. The measurement half cannot be, and is not faked.

const MAX_ITERATIONS = 20;

export async function searchScanRows({ measure, targetMs, lo = 0, hi = 200_000, tolerance = 0.5 }) {
  let best = { rows: hi, ms: await measure(hi), iterations: 0 };
  let iterations = 0;

  while (lo <= hi && iterations < MAX_ITERATIONS) {
    iterations += 1;
    const mid = Math.floor((lo + hi) / 2);
    const ms = await measure(mid);
    if (Math.abs(ms - targetMs) < Math.abs(best.ms - targetMs)) best = { rows: mid, ms, iterations };
    if (Math.abs(ms - targetMs) <= tolerance) return { ...best, rows: mid, ms, iterations };
    if (ms < targetMs) lo = mid + 1; else hi = mid - 1;
  }
  return { ...best, iterations };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig } = await import('../src/config.js');
  const { createPool } = await import('../src/pool.js');
  const { createPrisma, createRepo } = await import('../src/db.js');

  const config = loadConfig();
  const { pool, warm, close } = createPool({ config, onWait: () => {} });
  const prisma = createPrisma(pool);
  const repo = createRepo({ prisma, config });
  await warm();

  // Median of five, because one probe on a burstable instance is noise.
  //
  // This measures the WHOLE heavy route's statement -- scan, aggregate AND
  // insert -- because that is what holds the connection in production. Timing
  // the scan alone would calibrate against a cheaper statement than the one the
  // load test actually issues.
  //
  // Note that each probe inserts a row, so a long calibration grows the table
  // it is scanning. At five probes per step and ~14 steps that is ~70 rows
  // against tens of thousands, which is inside the noise -- but re-seed before
  // the baseline run rather than measuring on a table this script has grown.
  const { buildPost } = await import('../src/db.js');
  const measure = async (rows) => {
    const samples = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = process.hrtime.bigint();
      await repo.report({ scanRows: rows, post: buildPost(1) });
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return samples.sort((a, b) => a - b)[2];
  };

  const targetMs = Number(process.env.TARGET_HOLD_MS ?? 20);
  // The scan cannot read more rows than the seed created, so the search range
  // is capped by the table, not by the default. Without this the search would
  // happily "converge" above SEED_ROWS, where hold time is flat because every
  // probe reads the same whole table -- and report a row count that means
  // nothing.
  const hi = config.seedRows;
  const result = await searchScanRows({ measure, targetMs, hi });

  if (result.rows >= hi) {
    console.error(
      `\nUNUSABLE: the search pinned at ${hi} rows, the whole seeded table, and still ` +
      `reached only ${result.ms.toFixed(2)} ms against a ${targetMs} ms target.\n` +
      `The knob cannot reach the target at this table size. Raise SEED_ROWS (watch the ` +
      `working set against shared_buffers) or make the aggregate cost more per row, ` +
      `then re-run. Do NOT write this number into dev.tfvars.`,
    );
    process.exit(1);
  }

  console.log(JSON.stringify({ ...result, targetMs, searchCeiling: hi }, null, 2));
  console.log('\nSet REPORT_SCAN_ROWS in infra/main/dev.tfvars, and record the date and instance class beside it.');

  await prisma.$disconnect();
  await close();
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm test -- test/calibrate.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add ecs-rds-postgres-pool/service/scripts/calibrate.js \
        ecs-rds-postgres-pool/service/test/calibrate.test.js
git commit -m "feat(ecs-rds-postgres-pool/service): calibration search for the scan knob"
```

---

## Task 13: The container image

**Files:**
- Create: `ecs-rds-postgres-pool/service/Dockerfile`
- Create: `ecs-rds-postgres-pool/service/.dockerignore`

**Interfaces:**
- Consumes: everything above.
- Produces: an image that plan 2's `scripts/deploy-service.sh` builds and pushes. The container
  listens on `PORT` and answers `GET /healthz` with 200, which is what the ALB target group will
  check.

- [ ] **Step 1: Write `.dockerignore`**

```
node_modules
test
.env
*.log
```

- [ ] **Step 2: Write the `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22.13-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22.13-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
# Generate at BUILD time: the container must not need network or a database to
# start. The driver-adapter path is used at runtime, so no query engine binary
# is downloaded for the target platform at boot.
RUN npx prisma generate

FROM node:22.13-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY package.json ./
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts
# Build for the platform the task runs on. The sibling's README records an
# arm64/amd64 mismatch surfacing as CannotPullContainerError at task start, not
# at build -- pass --platform explicitly in deploy-service.sh (plan 2).
EXPOSE 8080
USER node
CMD ["node", "src/server.js"]
```

- [ ] **Step 3: Build the image**

Run: `cd ecs-rds-postgres-pool/service && docker build -t ecs-rds-postgres-pool:dev .`
Expected: success, with `prisma generate` reporting a generated client.

- [ ] **Step 4: Smoke-test that the image boots and fails for the right reason**

Run:

```bash
docker run --rm ecs-rds-postgres-pool:dev node -e "
  import('./src/config.js').then(m => { try { m.loadConfig({}); } catch (e) { console.log(e.message); } })"
```

Expected output: `DATABASE_URL is required`.

This is the whole end-to-end verification available in this plan: the image is built, Node starts
inside it, the application's own modules resolve, and configuration validation runs. Connecting to a
database is plan 3's first task, not something to fake here.

- [ ] **Step 5: Commit**

```bash
git add ecs-rds-postgres-pool/service/Dockerfile \
        ecs-rds-postgres-pool/service/.dockerignore
git commit -m "build(ecs-rds-postgres-pool/service): container image"
```

---

## Done when

- [ ] `npm test` passes with no database, no AWS credentials and no collector reachable.
- [ ] `npx prisma validate` is clean and `prisma/migrations/0001_init/migration.sql` contains
      `CREATE TABLE "feeds"`, `CREATE TABLE "posts"`, `CREATE INDEX "post_feed_recent_idx"` and
      the foreign key from `posts` to `feeds`.
- [ ] `npm run slo:check` **exits non-zero**, naming `fast` and `threshold_ms` — the deliberate red
      state that plan 3 turns green.
- [ ] `docker build` succeeds and the image reports `DATABASE_URL is required` when run with no
      environment.
- [ ] `grep -rn "dynamo\|admission\|\$metrics\|previewFeatures\|queryRawUnsafe" src/ prisma/` returns
      nothing outside the two `VACUUM ANALYZE` calls in `prisma/seed.js`.
- [ ] `test/db.test.js` asserts **one** statement for each of the four routes. If any of those
      assertions was relaxed to make an implementation easier, the capacity model is no longer true
      and plan 3's calibration will aim at the wrong number.
- [ ] Every file copied from the sibling carries its fork header and the date 2026-09-20.

## What this plan deliberately does not do

Recorded so the next reader does not treat them as omissions:

- **No Terraform, no AWS, no `platform/tfc.tf` line.** That is plan 2.
- **No Grafana dashboards or alert rules**, including the proxy's borrow-latency and session-pinning
  rules, which the spec requires to be written in plan 2 so that plan 4 stays config-only.
- **No k6 profiles.** Plan 2.
- **No integration test and no local Postgres.** Decided 2026-09-11 and kept. The first real
  exercise of the SQL, the TLS path, the migration and the seed is plan 3's first apply and deploy;
  that is the accepted cost of the decision, not a gap in this plan.
- **No class thresholds and no `target_rps`.** Plan 3, after calibration.
- **No `service/pricing.json`.** The spec requires published cost figures to come from a recorded
  price query rather than the estimates in its cost table. That query belongs with the run that
  publishes numbers, so the file is created in plan 4.
- **No `heartbeat/`.** The idle-load Lambda is infrastructure; plan 2.
