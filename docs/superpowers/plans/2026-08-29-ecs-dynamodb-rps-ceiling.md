# ecs-dynamodb-rps-ceiling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node.js service on ECS Fargate backed by provisioned DynamoDB, discover the request rate at which it stops meeting a class-based SLO, then release one constraint at a time and re-measure.

**Architecture:** Four HTTP endpoints with deliberately different costs (cheap `GetItem`, cheap `PutItem`, a 20-item `Query`, and a `Query` + `pbkdf2` + `PutItem`) run at a frozen 55/15/25/5 traffic mix. Each response carries a `Server-Timing` header splitting DB time from CPU time, and `/stats` exposes event-loop lag — together these let a run report *which* resource bound, not just where it stopped. Load comes from Grafana Cloud k6 in Frankfurt against an internet-facing ALB in `eu-central-1`.

**Tech Stack:** Node.js 22 (`node:http`, `node:test`), AWS SDK v3, Terraform ~1.14 with Terraform Cloud state, ECS Fargate, DynamoDB provisioned mode, k6 1.4 (Grafana Cloud), Grafana Cloud for dashboards/SLOs.

**Spec:** `docs/superpowers/specs/2026-08-29-ecs-dynamodb-rps-ceiling-design.md`

---

## Status — **complete**, 2026-09-01

> Project renamed to `ecs-dynamodb-rps` on 2026-09-03; paths and names below are pre-rename. See `docs/superpowers/specs/2026-09-02-ecs-dynamodb-rps-restructure-design.md`.

**Tasks 1–17 were executed under this plan. Tasks 18–23 were re-homed on 2026-09-01 and are not
executed here.** Nothing in this document remains to do.

Phases 5, 6 and 7 below are **retained as history, not as instructions.** They carry three layers of
amendment banners written while the plan was live, and reading them top-down now produces a sequence
that no longer applies — in particular Task 18 opens by raising DynamoDB capacity, which the re-homed
plan deliberately does not do first. Their reasoning is preserved because the new plans cite it;
their step lists are superseded.

### Where Tasks 18–23 went

The work was split in two on 2026-09-01, on an explicit decision to **prove the free-tier environment
is functional and observable before spending anything on capacity**. Task numbers are not reused:
each new plan numbers its own tasks from 1 and keeps its own SDD ledger directory, following the
precedent set by the 2026-08-31 plan.

| this plan | went to | why |
|---|---|---|
| — (new work) | `docs/superpowers/plans/2026-09-01-ecs-dynamodb-rps-ceiling-observability-shakedown.md` | exercise the live stack at 25/25, drive a burn alert deliberately, test the attribution table against a known answer. No capacity change, no `apply` |
| Task 18 (capacity + discovery) | `docs/superpowers/plans/2026-09-02-ecs-dynamodb-rps-ceiling-scale-and-measure.md`, Tasks 1–2 | amendments applied inline, so the reader no longer chases four banners to learn what the step actually is |
| Task 19 (baselines B, C) | same plan, Task 3 | |
| Task 20 (autoscaling 1→4) | same plan, Tasks 4–5 | |
| Task 21 (raise capacity if the DB binds) | same plan, Task 6 | |
| Task 22 (write up results) | same plan, Task 7 | its Step 1 was already superseded by the 2026-08-31 plan's Task 14, which rewrote the README |
| Task 23 (tear down and sweep) | same plan, Task 8 | |

### What Tasks 1–17 delivered

A Node.js service on ECS Fargate backed by provisioned DynamoDB, four endpoints at a frozen
55/15/25/5 mix, an SLO computed from service-emitted metrics, and four burn-rate alert rules — all
generated from one `slo.yaml`. Two later plans amended it and both are complete:

- `docs/superpowers/plans/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection.md` — the SLI moves off
  k6 and onto the service's own OTel histogram, collected continuously by Alloy. Reverses spec **D7**.
- `docs/superpowers/plans/2026-08-31-ecs-dynamodb-rps-ceiling-attribution-via-metrics.md` — every
  measurement signal moves off the HTTP surface; `Server-Timing` and `GET /stats` are deleted.
  Reverses spec **D10**.

**Read `terraform/dev.tfvars` for live values, never this document.** `pbkdf2_iterations` is **2662**
(re-derived 2026-08-31), and capacity is pinned to the 25/25 free tier by two lines in that file
*and* by two HCP workspace variables — the re-homed plan's Task 1 releases both.

**The environment is LIVE in `eu-central-1`, account `042945885621`**, up since `2026-08-29T18:27:55Z`
at roughly **$0.055/hour** (service + collector; the heartbeat sits inside the Lambda free tier).
`terraform destroy` has not run.

State of the environment as of 2026-09-01, after all three plans:

| | |
|---|---|
| Service | deployed, healthy, 1 task at 0.25 vCPU / 512 MB |
| Collector | Alloy on Fargate, 1 task, reachable at the Cloud Map name; CloudWatch discovery by `Project` tag |
| Heartbeat | EventBridge Scheduler → Lambda, 1/min across all four measured routes |
| DynamoDB | seeded — all 50 partitions at exactly 20 items, verified. Capacity pinned 25/25 (free tier) |
| Tests | 82 unit; 9 integration against pinned `dynamodb-local:2.5.2` |
| Container | built, pushed, smoke-tested as non-root, prod deps only |
| Terraform | applied; state in HCP workspace `ecs-dynamodb-rps-ceiling`, remote execution, `working-directory = "terraform"` |
| Grafana | dashboard, `grafana_slo`, and four burn-rate rule groups — all generated from `slo.yaml` |
| CPU knob | `pbkdf2_iterations = 2662`, re-derived on real Fargate 2026-08-31 |
| k6 | mix verified 55/15/25/5; all three profiles pass `k6 inspect`. **Not yet frozen** — the freeze is the re-homed plan's Task 2 |

### Corrections to this plan found during execution

Each was verified before acting, not assumed. Full reasoning in the SDD ledger at
`.superpowers/sdd/2026-08-29-ecs-dynamodb-rps-ceiling/progress.md`.

1. **`"test": "node --test test/"` does not work** on Node 22.13.1 — it hands the directory to
   the CJS loader and dies with `MODULE_NOT_FOUND`. Corrected to `"node --test"` (Task 1).
2. **Task 2's `cpu.js` used `keylen = 16`**, producing 32 hex chars against four places in this
   plan requiring 16. Corrected to `keylen = 8`. CPU cost is unaffected (one PRF block either way).
3. **Task 5's `getItem` `ConsistentRead: false` was unasserted.** A silent flip inflates required
   capacity 1.025 → 1.300 RCU/rps (+26.8%). Assertion added.
4. **Task 7's seed counted unwritten items as written** and, separately, handled only one of
   DynamoDB's two throttling paths. It crashed live at 900/1000, leaving 5 partitions empty.
   `writeAll()` now retries both paths, paces batches, and throws truthfully.
5. **Task 16's `k6 cloud load-zone list` does not exist** in k6 v1.4.0 (`login`, `run`, `upload`
   only). Spec §14's provenance claim is wrong. Load-zone validity is confirmed at cloud-run
   submission instead — before load or VU-hours are spent. `--summary-export` *is* supported on
   `k6 cloud run`, so `/loadtest`'s JSON parsing applies unchanged.
6. **`k6 inspect` ignores the shell environment; `k6 run` honours it**
   (`--include-system-env-vars` defaults differ). Task 16 step 4's command is wrong as written.
   Use `-e` flags, which work under both. `BASE_URL` has no guard, so unset it silently targets
   `undefined/…`.
7. **Spec §5 estimated 700–1400 pbkdf2 iterations** for the ~1.4 ms budget; measured on a real
   0.25 vCPU Fargate slice it is **~2675** — about 2× the estimate.

### Open issues that affect Task 18 and beyond

- **The Task 18 step 7 attribution table cannot work as written.** `db_ms` is wall-clock around
  an `await`, so it absorbs event-loop queueing: measured, it inflated **12.1×** (10.9 ms → 131.9
  ms) with the database unchanged. The row "`db_ms` flat + `el_delay` climbing ⇒ service-bound"
  can never occur. Use `ThrottledRequests == 0` as the DB-bound discriminator, plus DynamoDB's
  `SuccessfulRequestLatency`; the gap between it and `db_ms` *is* the queueing signal.
  **Rewrite that table before relying on it.** ~~Note `@opentelemetry/instrumentation-aws-sdk`, added by
  the new spec, measures wall-clock around the same `await` and therefore inherits this flaw rather
  than curing it — it is kept for call counts, errors and SDK retries, not attribution.~~
  **AMENDED 2026-08-31: `instrumentation-aws-sdk` was REMOVED.** It never emitted anything and
  structurally could not — only `BedrockRuntimeServiceExtension` implements `updateMetricInstruments`;
  `DynamodbServiceExtension` defines no metric instruments at all. The replacement table is §5 of
  `docs/superpowers/specs/2026-08-31-ecs-dynamodb-rps-ceiling-attribution-via-metrics-design.md`.
- **`/slo` has no generation script** — it is documentation only. Task 14's four outputs were
  hand-written to its spec, so "one file, four outputs, cannot drift" is currently enforced by
  discipline, not tooling. **Addressed by the new plan**, which adds the generator; its first step
  regenerates against the committed `window: 30d` to prove the generator is faithful *before*
  changing anything.
- **`grafana/alerts.tf` has never been validated** against the Grafana provider (none is wired
  here). Its queries also carry no label selector, so on a shared datasource they would aggregate
  unrelated k6 runs. Scope them before applying. **Addressed by the new plan**: the file is rewritten
  against service-emitted series, wired into the root module and validated, and its selector becomes
  `job="ecs-dynamodb-rps-ceiling"` derived from the service's own resource attributes rather than a
  `--tag` that a run can forget to pass.
- **Fast-class 50 ms threshold looks achievable but is unproven**: server-side `db` is ~4 ms
  unloaded. Laptop-measured client totals (~80 ms) are RTT to Frankfurt and will not apply to
  runs originating in-zone.

---

## Global Constraints

- **Project name is fixed:** `ecs-dynamodb-rps-ceiling`. It is the directory name, the AWS `Project` tag value, and the commit scope. Renaming orphans tagged resources from the teardown sweep.
- **Every AWS resource carries `Project = "ecs-dynamodb-rps-ceiling"`** via provider `default_tags`. Never per-resource.
- **`terraform apply` / `destroy` are approval gates.** Each gets its own task that STOPS. Never `-auto-approve` — the `PreToolUse` hook blocks it outright.
- **Terraform is the only way infrastructure exists.** The one recorded exception is seed *data* (Task 7), which is written by a script.
- **No NAT gateway.** Tasks run in public subnets with `assign_public_ip = true`. A NAT gateway is ~$32/month and the most common teardown survivor.
- **Frozen once measured:** the 55/15/25/5 endpoint mix, item size ≤1 KB, `Query` page size 20, read consistency (eventually consistent), and all three k6 scripts. Changing any invalidates every recorded number.
- **Node 22, `"type": "module"`.** ESM throughout.
- **Item size must land in 900–1024 bytes.** Below 900, a 20-item `Query` stops costing 2.5 RCU and the capacity model in the spec becomes wrong.
- **Prices are never typed from memory.** They live in `pricing.json` with the query that produced them.
- **k6 threshold booleans are inverted:** `true` = breached = FAILED. k6 exits `99` on breach, `0` on pass. Capture the exit code on the k6 line, never after a pipe.
- **Commit format:** Conventional Commits, scope `ecs-dynamodb-rps-ceiling` or `ecs-dynamodb-rps-ceiling/<layer>`.

## Deviations from the spec (approved as part of this plan)

1. **Feed route is `GET /feeds/:pk`, not `GET /items/:pk/feed`.** The spec's path is ambiguous against `GET /items/:pk/:sk` — an item whose `sk` is literally `feed` would match both, and resolving it by route ordering is a latent bug. Separate prefixes remove the ambiguity entirely.
2. **Raw `node:http`, no Express.** §5 of the spec budgets 250 µs of CPU per request at 0.25 vCPU and 1000 RPS. A framework's per-request overhead is a meaningful fraction of that and would be indistinguishable from the CPU knob it exists to measure.
3. **Three project skills need extending before they can drive this project** (Tasks 14 and 16). `/slo` only documents `success_rate` and `latency_percentile` SLI types and cannot express a class-threshold ratio; `/loadtest` runs `k6 run` locally, not `k6 cloud run`; and its `results.md` columns do not carry the bound resource, per-class attainment, burn-rate multiple, or $/hour that the spec requires.

## File Structure

```
ecs-dynamodb-rps-ceiling/
  package.json              deps, scripts, node>=22, type=module
  Dockerfile                node:22-alpine, non-root, production deps only
  docker-compose.test.yml   DynamoDB Local, for Task 8's integration test
  .dockerignore
  src/
    config.js               env parsing + validation. One source of runtime knobs.
    cpu.js                  pbkdf2Sync work unit. The CPU knob.
    timing.js               per-request phase timers -> Server-Timing header
    stats.js                event-loop lag histogram -> /stats payload
    dynamo.js               DynamoDB access: getItem / putItem / queryFeed
    handlers.js             one function per endpoint. No routing, no server.
    server.js               router + http server + wiring. Entry point.
  scripts/
    seed.js                 BatchWriteItem seeding, with item-size assertion
    calibrate.js            binary-searches pbkdf2 iterations for a target ms
  test/
    config.test.js  cpu.test.js  timing.test.js  stats.test.js
    dynamo.test.js  handlers.test.js  seed.test.js
    integration.test.js     against DynamoDB Local
  terraform/
    versions.tf  variables.tf  outputs.tf
    network.tf   alb.tf  ecr.tf  dynamodb.tf  ecs.tf  autoscaling.tf
    dev.tfvars
  k6/
    lib/mix.js              deterministic 55/15/25/5 selection
    lib/slo.js              GENERATED from slo.yaml — class thresholds + slo_met
    discovery.js            shape A
    constant.js             shape B
    stress.js               shape C
  grafana/
    dashboard.json          panels: slo_met, per-class p95, db_ms/cpu_ms, ELU, throttles
    slo.tf  alerts.tf       applied from terraform/ via file()
  slo.yaml                  source of truth for thresholds + alerts + capacity
  pricing.json              EXISTS — live eu-central-1 rates + provenance
  capacity-model.html       EXISTS — the budget chart
  results.md                created by /loadtest
  README.md
```

Files are split by responsibility, not layer: `handlers.js` holds no routing so it can be tested without a server; `server.js` holds no business logic so routing can be tested without DynamoDB.

---

## Phase 1 — Service (local only, no AWS spend)

### Task 1: Scaffold and config

**Files:**
- Create: `ecs-dynamodb-rps-ceiling/package.json`
- Create: `ecs-dynamodb-rps-ceiling/src/config.js`
- Test: `ecs-dynamodb-rps-ceiling/test/config.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadConfig(env = process.env) -> {port:number, tableName:string, region:string, pbkdf2Iterations:number, feedPageSize:number, itemTtlSeconds:number, dynamoEndpoint:string|undefined}`. Throws `Error` on an invalid numeric value. Every later task imports this.

- [x] **Step 1: Create `package.json`**

```json
{
  "name": "ecs-dynamodb-rps-ceiling",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test test/",
    "test:integration": "node --test test/integration.test.js",
    "seed": "node scripts/seed.js",
    "calibrate": "node scripts/calibrate.js"
  },
  "dependencies": {
    "@aws-sdk/client-dynamodb": "^3.716.0",
    "@aws-sdk/lib-dynamodb": "^3.716.0"
  },
  "devDependencies": {
    "aws-sdk-client-mock": "^4.1.0"
  }
}
```

- [x] **Step 2: Write the failing test**

```javascript
// test/config.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('applies defaults when env is empty', () => {
  const c = loadConfig({});
  assert.equal(c.port, 8080);
  assert.equal(c.tableName, 'items');
  assert.equal(c.pbkdf2Iterations, 0);
  assert.equal(c.feedPageSize, 20);
  assert.equal(c.itemTtlSeconds, 3600);
  assert.equal(c.dynamoEndpoint, undefined);
});

test('reads values from env', () => {
  const c = loadConfig({ PORT: '3000', TABLE_NAME: 't', PBKDF2_ITERATIONS: '1200' });
  assert.equal(c.port, 3000);
  assert.equal(c.tableName, 't');
  assert.equal(c.pbkdf2Iterations, 1200);
});

test('rejects a non-numeric numeric field', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
});

test('rejects a negative iteration count', () => {
  assert.throws(() => loadConfig({ PBKDF2_ITERATIONS: '-1' }), /PBKDF2_ITERATIONS/);
});
```

- [x] **Step 3: Run test to verify it fails**

Run: `cd ecs-dynamodb-rps-ceiling && npm install && npm test`
Expected: FAIL — `Cannot find module '../src/config.js'`

- [x] **Step 4: Write the implementation**

```javascript
// src/config.js
function num(env, key, dflt) {
  const raw = env[key];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number, got ${JSON.stringify(raw)}`);
  return n;
}

export function loadConfig(env = process.env) {
  return {
    port: num(env, 'PORT', 8080),
    tableName: env.TABLE_NAME ?? 'items',
    region: env.AWS_REGION ?? 'eu-central-1',
    pbkdf2Iterations: num(env, 'PBKDF2_ITERATIONS', 0),
    feedPageSize: num(env, 'FEED_PAGE_SIZE', 20),
    itemTtlSeconds: num(env, 'ITEM_TTL_SECONDS', 3600),
    dynamoEndpoint: env.DYNAMO_ENDPOINT || undefined,
  };
}
```

- [x] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 4 tests.

- [x] **Step 6: Commit**

```bash
git add ecs-dynamodb-rps-ceiling/package.json ecs-dynamodb-rps-ceiling/src/config.js ecs-dynamodb-rps-ceiling/test/config.test.js
git commit -m "feat(ecs-dynamodb-rps-ceiling): add service scaffold and config"
```

---

### Task 2: CPU work unit

**Files:**
- Create: `ecs-dynamodb-rps-ceiling/src/cpu.js`
- Test: `ecs-dynamodb-rps-ceiling/test/cpu.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `burn(iterations:number, seed:string) -> string` — returns a 16-char hex digest so V8 cannot eliminate the call, and returns `''` when `iterations <= 0`.

This is the knob §9 of the spec calibrates so the service ceiling lands at ~70% of the DB ceiling. `pbkdf2Sync` is chosen deliberately: it blocks the event loop, which produces a sharp knee and catastrophic queueing past it — the behaviour a latency SLO should catch.

- [x] **Step 1: Write the failing test**

```javascript
// test/cpu.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { burn } from '../src/cpu.js';

test('returns empty string when disabled', () => {
  assert.equal(burn(0, 'x'), '');
  assert.equal(burn(-5, 'x'), '');
});

test('is deterministic for the same seed and iterations', () => {
  assert.equal(burn(50, 'abc'), burn(50, 'abc'));
});

test('differs for different seeds', () => {
  assert.notEqual(burn(50, 'abc'), burn(50, 'def'));
});

test('returns a 16-char hex digest', () => {
  assert.match(burn(50, 'abc'), /^[0-9a-f]{16}$/);
});

test('cost scales with iteration count', () => {
  const time = (n) => { const t0 = process.hrtime.bigint(); burn(n, 's'); return Number(process.hrtime.bigint() - t0); };
  time(2000);                                    // warm up, ignore result
  assert.ok(time(20000) > time(2000) * 3, '20k iterations should cost well over 3x 2k');
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- test/cpu.test.js`
Expected: FAIL — `Cannot find module '../src/cpu.js'`

- [x] **Step 3: Write the implementation**

```javascript
// src/cpu.js
import { pbkdf2Sync } from 'node:crypto';

const SALT = Buffer.from('ecs-dynamodb-rps-ceiling');

/** Deterministic, allocation-light CPU cost. Blocks the event loop by design. */
export function burn(iterations, seed) {
  if (!(iterations > 0)) return '';
  return pbkdf2Sync(seed, SALT, iterations, 16, 'sha256').toString('hex');
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- test/cpu.test.js`
Expected: PASS — 5 tests.

- [x] **Step 5: Commit**

```bash
git add ecs-dynamodb-rps-ceiling/src/cpu.js ecs-dynamodb-rps-ceiling/test/cpu.test.js
git commit -m "feat(ecs-dynamodb-rps-ceiling): add tunable pbkdf2 cpu work unit"
```

---

### Task 3: Phase timing and Server-Timing header

**Files:**
- Create: `ecs-dynamodb-rps-ceiling/src/timing.js`
- Test: `ecs-dynamodb-rps-ceiling/test/timing.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `createTimer() -> {measure(name, asyncFn), measureSync(name, fn), header() -> string}`. `header()` returns e.g. `db;dur=3.100, cpu;dur=0.240`, and `''` when nothing was measured. Repeated names accumulate.

This is half of the spec's D10 attribution: it puts `db_ms` and `cpu_ms` into the k6 output, so a latency breach can be attributed without a CloudWatch datasource.

- [x] **Step 1: Write the failing test**

```javascript
// test/timing.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTimer } from '../src/timing.js';

test('empty timer produces an empty header', () => {
  assert.equal(createTimer().header(), '');
});

test('measures a sync phase and formats it', () => {
  const t = createTimer();
  t.measureSync('cpu', () => { for (let i = 0; i < 1e5; i++); });
  assert.match(t.header(), /^cpu;dur=\d+\.\d{3}$/);
});

test('measures an async phase and returns its value', async () => {
  const t = createTimer();
  const v = await t.measure('db', async () => { await new Promise(r => setTimeout(r, 12)); return 'ok'; });
  assert.equal(v, 'ok');
  const ms = Number(t.header().match(/dur=([\d.]+)/)[1]);
  assert.ok(ms >= 10, `expected >=10ms, got ${ms}`);
});

test('accumulates repeated phases and joins with a comma', () => {
  const t = createTimer();
  t.measureSync('db', () => {}); t.measureSync('db', () => {}); t.measureSync('cpu', () => {});
  const h = t.header();
  assert.equal(h.split(', ').length, 2);
  assert.ok(h.includes('db;dur='));
  assert.ok(h.includes('cpu;dur='));
});

test('records the phase even when the function throws', async () => {
  const t = createTimer();
  await assert.rejects(() => t.measure('db', async () => { throw new Error('boom'); }));
  assert.ok(t.header().startsWith('db;dur='));
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- test/timing.test.js`
Expected: FAIL — `Cannot find module '../src/timing.js'`

- [x] **Step 3: Write the implementation**

```javascript
// src/timing.js
import { performance } from 'node:perf_hooks';

export function createTimer() {
  const marks = new Map();
  const add = (name, ms) => marks.set(name, (marks.get(name) ?? 0) + ms);

  return {
    async measure(name, fn) {
      const t0 = performance.now();
      try { return await fn(); } finally { add(name, performance.now() - t0); }
    },
    measureSync(name, fn) {
      const t0 = performance.now();
      try { return fn(); } finally { add(name, performance.now() - t0); }
    },
    header() {
      return [...marks].map(([n, ms]) => `${n};dur=${ms.toFixed(3)}`).join(', ');
    },
  };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- test/timing.test.js`
Expected: PASS — 5 tests.

- [x] **Step 5: Commit**

```bash
git add ecs-dynamodb-rps-ceiling/src/timing.js ecs-dynamodb-rps-ceiling/test/timing.test.js
git commit -m "feat(ecs-dynamodb-rps-ceiling): add per-request phase timing"
```

---

### Task 4: Event-loop lag stats

**Files:**
- Create: `ecs-dynamodb-rps-ceiling/src/stats.js`
- Test: `ecs-dynamodb-rps-ceiling/test/stats.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `snapshot() -> {eventLoopDelayMs:{p50,p90,p99,max,mean}, memoryMb:{rss,heapUsed}, uptimeSeconds:number}` and `resetStats() -> void`.

The other half of D10. Event-loop lag climbing while `db_ms` stays flat is the signal that the Node process, not DynamoDB, is the ceiling — which is what turns "it stopped at N" into an attributed result.

- [x] **Step 1: Write the failing test**

```javascript
// test/stats.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, resetStats } from '../src/stats.js';

test('snapshot exposes the documented shape', () => {
  const s = snapshot();
  for (const k of ['p50', 'p90', 'p99', 'max', 'mean']) {
    assert.equal(typeof s.eventLoopDelayMs[k], 'number', `missing ${k}`);
    assert.ok(Number.isFinite(s.eventLoopDelayMs[k]), `${k} not finite`);
  }
  assert.equal(typeof s.memoryMb.rss, 'number');
  assert.equal(typeof s.uptimeSeconds, 'number');
});

test('reports lag in milliseconds, not nanoseconds', async () => {
  await new Promise(r => setTimeout(r, 60));
  const s = snapshot();
  assert.ok(s.eventLoopDelayMs.max < 1000, `max ${s.eventLoopDelayMs.max} looks like ns, not ms`);
});

test('resetStats clears the histogram', async () => {
  await new Promise(r => setTimeout(r, 40));
  resetStats();
  assert.ok(snapshot().eventLoopDelayMs.max >= 0);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- test/stats.test.js`
Expected: FAIL — `Cannot find module '../src/stats.js'`

- [x] **Step 3: Write the implementation**

```javascript
// src/stats.js
import { monitorEventLoopDelay } from 'node:perf_hooks';

const NS_PER_MS = 1e6;
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();

export function snapshot() {
  const mem = process.memoryUsage();
  return {
    eventLoopDelayMs: {
      p50: histogram.percentile(50) / NS_PER_MS,
      p90: histogram.percentile(90) / NS_PER_MS,
      p99: histogram.percentile(99) / NS_PER_MS,
      max: histogram.max / NS_PER_MS,
      mean: (Number.isFinite(histogram.mean) ? histogram.mean : 0) / NS_PER_MS,
    },
    memoryMb: {
      rss: mem.rss / 1048576,
      heapUsed: mem.heapUsed / 1048576,
    },
    uptimeSeconds: process.uptime(),
  };
}

export function resetStats() { histogram.reset(); }
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- test/stats.test.js`
Expected: PASS — 3 tests.

- [x] **Step 5: Commit**

```bash
git add ecs-dynamodb-rps-ceiling/src/stats.js ecs-dynamodb-rps-ceiling/test/stats.test.js
git commit -m "feat(ecs-dynamodb-rps-ceiling): expose event-loop lag stats"
```

---
### Task 5: Item shape and DynamoDB access

**Files:**
- Create: `ecs-dynamodb-rps-ceiling/src/item.js`
- Create: `ecs-dynamodb-rps-ceiling/src/dynamo.js`
- Test: `ecs-dynamodb-rps-ceiling/test/dynamo.test.js`

**Interfaces:**
- Consumes: `loadConfig` (Task 1).
- Produces:
  - `PAYLOAD_BYTES = 940`, `buildItem({pk, sk, expiresAt?}) -> {pk, sk, payload, expires_at?}`, `itemSizeBytes(item) -> number`, `randomId() -> string` (16 hex chars).
  - `createRepo(config) -> {getItem(pk, sk), putItem(item), queryFeed(pk, limit), destroy()}`. `getItem` resolves `null` when absent; `queryFeed` resolves `[]`.

**Why 940 bytes.** A seeded item is `pk`(2+7) + `sk`(2+7) + `payload`(7+940) = **965 bytes**. Twenty of them is 19,300 bytes, which rounds to **5 × 4 KB blocks = 5 RCU strongly consistent = 2.5 RCU eventually consistent** — exactly the coefficient the spec's capacity model assumes. A written item adds a longer `pk` and `expires_at` and lands at 1,003 bytes, still under the 1 KB write block. Both sit inside the 900–1024 band the global constraints require. Change `PAYLOAD_BYTES` and the capacity model is wrong.

**`ConsistentRead: false` is load-bearing**, not a default to leave implicit: eventually consistent reads cost half an RCU. Flipping it doubles every read coefficient in the model.

- [x] **Step 1: Write the failing test**

```javascript
// test/dynamo.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { buildItem, itemSizeBytes, randomId, PAYLOAD_BYTES } from '../src/item.js';
import { createRepo } from '../src/dynamo.js';

const ddb = mockClient(DynamoDBDocumentClient);
const config = { region: 'eu-central-1', tableName: 'items', feedPageSize: 20 };
beforeEach(() => ddb.reset());

test('seeded item size stays inside the 900-1024 byte band', () => {
  const size = itemSizeBytes(buildItem({ pk: 'feed-00', sk: 'item-00' }));
  assert.ok(size >= 900 && size <= 1024, `seeded item is ${size} bytes`);
});

test('written item size stays inside the band', () => {
  const size = itemSizeBytes(buildItem({ pk: `w#${randomId()}`, sk: randomId(), expiresAt: 1893456000 }));
  assert.ok(size >= 900 && size <= 1024, `written item is ${size} bytes`);
});

test('a 20-item page rounds to exactly 5 read blocks', () => {
  const page = 20 * itemSizeBytes(buildItem({ pk: 'feed-00', sk: 'item-00' }));
  assert.equal(Math.ceil(page / 4096), 5, `page is ${page} bytes`);
});

test('randomId is 16 hex chars and does not repeat', () => {
  assert.match(randomId(), /^[0-9a-f]{16}$/);
  assert.notEqual(randomId(), randomId());
});

test('getItem returns the item', async () => {
  ddb.on(GetCommand).resolves({ Item: { pk: 'a', sk: 'b' } });
  assert.deepEqual(await createRepo(config).getItem('a', 'b'), { pk: 'a', sk: 'b' });
});

test('getItem returns null when absent', async () => {
  ddb.on(GetCommand).resolves({});
  assert.equal(await createRepo(config).getItem('a', 'b'), null);
});

test('putItem sends the item to the configured table', async () => {
  ddb.on(PutCommand).resolves({});
  const item = buildItem({ pk: 'w#1', sk: '2' });
  await createRepo(config).putItem(item);
  assert.equal(ddb.commandCalls(PutCommand)[0].args[0].input.TableName, 'items');
  assert.deepEqual(ddb.commandCalls(PutCommand)[0].args[0].input.Item, item);
});

test('queryFeed requests an eventually consistent read with the page limit', async () => {
  ddb.on(QueryCommand).resolves({ Items: [{ pk: 'feed-00', sk: 'item-00' }] });
  const items = await createRepo(config).queryFeed('feed-00', 20);
  assert.equal(items.length, 1);
  const input = ddb.commandCalls(QueryCommand)[0].args[0].input;
  assert.equal(input.ConsistentRead, false, 'eventual consistency halves the RCU cost — must not drift');
  assert.equal(input.Limit, 20);
  assert.equal(input.ExpressionAttributeValues[':pk'], 'feed-00');
});

test('queryFeed returns an empty array when the partition is empty', async () => {
  ddb.on(QueryCommand).resolves({});
  assert.deepEqual(await createRepo(config).queryFeed('nope', 20), []);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- test/dynamo.test.js`
Expected: FAIL — `Cannot find module '../src/item.js'`

- [x] **Step 3: Write `src/item.js`**

```javascript
// src/item.js
import { randomBytes } from 'node:crypto';

/** Sized so a seeded item is 965 B and a 20-item Query rounds to exactly 5 read blocks. */
export const PAYLOAD_BYTES = 940;
const PAYLOAD = 'x'.repeat(PAYLOAD_BYTES);

export function randomId() { return randomBytes(8).toString('hex'); }

export function buildItem({ pk, sk, expiresAt }) {
  const item = { pk, sk, payload: PAYLOAD };
  if (expiresAt !== undefined) item.expires_at = expiresAt;
  return item;
}

/** DynamoDB charges attribute names plus values, UTF-8; numbers are ~8 B. */
export function itemSizeBytes(item) {
  return Object.entries(item).reduce((n, [k, v]) =>
    n + Buffer.byteLength(k, 'utf8') +
    (typeof v === 'number' ? 8 : Buffer.byteLength(String(v), 'utf8')), 0);
}
```

- [x] **Step 4: Write `src/dynamo.js`**

```javascript
// src/dynamo.js
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

export function createRepo(config) {
  const base = new DynamoDBClient({
    region: config.region,
    maxAttempts: 3,
    ...(config.dynamoEndpoint ? { endpoint: config.dynamoEndpoint } : {}),
  });
  const doc = DynamoDBDocumentClient.from(base, { marshallOptions: { removeUndefinedValues: true } });
  const Table = config.tableName;

  return {
    async getItem(pk, sk) {
      const r = await doc.send(new GetCommand({ TableName: Table, Key: { pk, sk }, ConsistentRead: false }));
      return r.Item ?? null;
    },
    async putItem(item) {
      await doc.send(new PutCommand({ TableName: Table, Item: item }));
      return item;
    },
    async queryFeed(pk, limit) {
      const r = await doc.send(new QueryCommand({
        TableName: Table,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        Limit: limit,
        // Eventually consistent: 0.5 RCU per 4 KB instead of 1. The capacity
        // model in the spec assumes this. Do not change without re-deriving it.
        ConsistentRead: false,
      }));
      return r.Items ?? [];
    },
    destroy() { base.destroy(); },
  };
}
```

- [x] **Step 5: Run test to verify it passes**

Run: `npm test -- test/dynamo.test.js`
Expected: PASS — 9 tests. If the block-count test fails, `PAYLOAD_BYTES` was changed; fix the constant rather than the test.

- [x] **Step 6: Commit**

```bash
git add ecs-dynamodb-rps-ceiling/src/item.js ecs-dynamodb-rps-ceiling/src/dynamo.js ecs-dynamodb-rps-ceiling/test/dynamo.test.js
git commit -m "feat(ecs-dynamodb-rps-ceiling): add item shape and dynamodb access"
```

---

### Task 6: Handlers, router and server

**Files:**
- Create: `ecs-dynamodb-rps-ceiling/src/handlers.js`
- Create: `ecs-dynamodb-rps-ceiling/src/server.js`
- Test: `ecs-dynamodb-rps-ceiling/test/handlers.test.js`

**Interfaces:**
- Consumes: `createRepo` + `buildItem`/`randomId` (Task 5), `burn` (Task 2), `createTimer` (Task 3), `snapshot` (Task 4), `loadConfig` (Task 1).
- Produces:
  - `createHandlers({repo, config}) -> {health, stats, getItem, putItem, feed, report}`; every handler takes `{params, body, timer}` and resolves `{status:number, body:object}`.
  - `matchRoute(method, path) -> {name:string, params:object} | null`.
  - `createServer({handlers}) -> http.Server`.

**Routing note.** `GET /feeds/:pk` rather than the spec's `GET /items/:pk/feed` — see the deviations section. `/items/:pk/:sk` and `/items/:pk/feed` overlap, and ordering-based resolution is a latent bug.

- [x] **Step 1: Write the failing test**

```javascript
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
  assert.equal(matchRoute('GET', '/stats').name, 'stats');
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
  assert.ok(timer.header().includes('db;dur='));
  assert.ok(!timer.header().includes('cpu;dur='));
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
  assert.ok(timer.header().includes('db;dur='));
  assert.ok(timer.header().includes('cpu;dur='));
});

test('report queries, burns cpu, then writes', async () => {
  const timer = createTimer();
  const r = await createHandlers({ repo, config }).report({ body: { pk: 'feed-03' }, timer });
  assert.equal(r.status, 200);
  assert.equal(calls[0][0], 'query');
  assert.equal(calls[1][0], 'put');
  assert.match(r.body.digest, /^[0-9a-f]{16}$/);
  assert.ok(timer.header().includes('cpu;dur='));
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- test/handlers.test.js`
Expected: FAIL — `Cannot find module '../src/handlers.js'`

- [x] **Step 3: Write `src/handlers.js`**

```javascript
// src/handlers.js
import { burn } from './cpu.js';
import { snapshot } from './stats.js';
import { buildItem, randomId } from './item.js';

const ROUTES = [
  { name: 'health',  method: 'GET',  re: /^\/healthz$/,                 keys: [] },
  { name: 'stats',   method: 'GET',  re: /^\/stats$/,                   keys: [] },
  { name: 'feed',    method: 'GET',  re: /^\/feeds\/([^/]+)$/,          keys: ['pk'] },
  { name: 'getItem', method: 'GET',  re: /^\/items\/([^/]+)\/([^/]+)$/, keys: ['pk', 'sk'] },
  { name: 'putItem', method: 'POST', re: /^\/items$/,                   keys: [] },
  { name: 'report',  method: 'POST', re: /^\/reports$/,                 keys: [] },
];

export function matchRoute(method, path) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = r.re.exec(path);
    if (!m) continue;
    return { name: r.name, params: Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]])) };
  }
  return null;
}

/** Real, deterministic work over the page: sort, then aggregate. */
function summarize(items) {
  const sorted = [...items].sort((a, b) => (a.sk < b.sk ? 1 : a.sk > b.sk ? -1 : 0));
  let bytes = 0;
  for (const it of sorted) bytes += it.payload ? it.payload.length : 0;
  return { count: sorted.length, bytes, first: sorted[0]?.sk ?? null, last: sorted.at(-1)?.sk ?? null };
}

export function createHandlers({ repo, config }) {
  const newRecord = () => buildItem({
    pk: `w#${randomId()}`,
    sk: randomId(),
    expiresAt: Math.floor(Date.now() / 1000) + config.itemTtlSeconds,
  });

  return {
    async health() { return { status: 200, body: { ok: true } }; },

    async stats() { return { status: 200, body: snapshot() }; },

    async getItem({ params, timer }) {
      const item = await timer.measure('db', () => repo.getItem(params.pk, params.sk));
      return item ? { status: 200, body: item } : { status: 404, body: { error: 'not found' } };
    },

    async putItem({ timer }) {
      const record = newRecord();
      await timer.measure('db', () => repo.putItem(record));
      return { status: 201, body: record };
    },

    async feed({ params, timer }) {
      const items = await timer.measure('db', () => repo.queryFeed(params.pk, config.feedPageSize));
      const body = timer.measureSync('cpu', () => summarize(items));
      return { status: 200, body };
    },

    async report({ body, timer }) {
      const pk = body?.pk ?? 'feed-00';
      const items = await timer.measure('db', () => repo.queryFeed(pk, config.feedPageSize));
      const digest = timer.measureSync('cpu', () => burn(config.pbkdf2Iterations, `${pk}:${items.length}`));
      const record = newRecord();
      await timer.measure('db', () => repo.putItem(record));
      return { status: 200, body: { pk, count: items.length, digest, recordId: record.sk } };
    },
  };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- test/handlers.test.js`
Expected: PASS — 10 tests.

- [x] **Step 5: Write `src/server.js`**

```javascript
// src/server.js
import http from 'node:http';
import { loadConfig } from './config.js';
import { createRepo } from './dynamo.js';
import { createHandlers, matchRoute } from './handlers.js';
import { createTimer } from './timing.js';

const MAX_BODY_BYTES = 16 * 1024;

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('invalid json'); }
}

export function createServer({ handlers }) {
  return http.createServer(async (req, res) => {
    const timer = createTimer();
    const path = req.url.split('?')[0];
    const route = matchRoute(req.method, path);

    const send = (status, body) => {
      const header = timer.header();
      if (header) res.setHeader('Server-Timing', header);
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };

    if (!route) return send(404, { error: 'no route' });

    try {
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      const result = await handlers[route.name]({ params: route.params, body, timer });
      send(result.status, result.body);
    } catch (err) {
      send(500, { error: err.message });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const repo = createRepo(config);
  const server = createServer({ handlers: createHandlers({ repo, config }) });
  server.listen(config.port, () => console.log(JSON.stringify({ msg: 'listening', ...config })));
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => server.close(() => { repo.destroy(); process.exit(0); }));
  }
}
```

- [x] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS — all tests from Tasks 1-6.

- [x] **Step 7: Commit**

```bash
git add ecs-dynamodb-rps-ceiling/src/handlers.js ecs-dynamodb-rps-ceiling/src/server.js ecs-dynamodb-rps-ceiling/test/handlers.test.js
git commit -m "feat(ecs-dynamodb-rps-ceiling): add four endpoints, router and server"
```

---

### Task 7: Seed script

**Files:**
- Create: `ecs-dynamodb-rps-ceiling/scripts/seed.js`
- Test: `ecs-dynamodb-rps-ceiling/test/seed.test.js`

**Interfaces:**
- Consumes: `buildItem`/`itemSizeBytes` (Task 5), `loadConfig` (Task 1).
- Produces: `PARTITIONS = 50`, `ITEMS_PER_PARTITION = 20`, `seedItems() -> item[]` (1000 items), `chunk(arr, n) -> arr[][]`, and a `main()` that writes them.

50 partitions × 20 items. Fifty rather than a handful because a narrow key range concentrates traffic on few physical partitions and can hit per-partition throughput limits — which would present as a service ceiling while being nothing of the kind.

- [x] **Step 1: Write the failing test**

```javascript
// test/seed.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedItems, chunk, PARTITIONS, ITEMS_PER_PARTITION } from '../scripts/seed.js';
import { itemSizeBytes } from '../src/item.js';

test('produces exactly 1000 items', () => {
  assert.equal(seedItems().length, PARTITIONS * ITEMS_PER_PARTITION);
  assert.equal(seedItems().length, 1000);
});

test('keys are zero-padded and deterministic', () => {
  const items = seedItems();
  assert.equal(items[0].pk, 'feed-00');
  assert.equal(items[0].sk, 'item-00');
  assert.equal(items.at(-1).pk, 'feed-49');
  assert.equal(items.at(-1).sk, 'item-19');
  assert.deepEqual(seedItems(), items);
});

test('every partition holds exactly the page size', () => {
  const byPk = new Map();
  for (const it of seedItems()) byPk.set(it.pk, (byPk.get(it.pk) ?? 0) + 1);
  assert.equal(byPk.size, PARTITIONS);
  for (const [pk, n] of byPk) assert.equal(n, ITEMS_PER_PARTITION, `${pk} has ${n}`);
});

test('seeded items carry no ttl', () => {
  assert.equal(seedItems()[0].expires_at, undefined);
});

test('every item sits inside the 900-1024 byte band', () => {
  for (const it of seedItems()) {
    const size = itemSizeBytes(it);
    assert.ok(size >= 900 && size <= 1024, `${it.pk}/${it.sk} is ${size} bytes`);
  }
});

test('chunk splits into BatchWriteItem-legal groups of 25', () => {
  const groups = chunk(seedItems(), 25);
  assert.equal(groups.length, 40);
  for (const g of groups) assert.ok(g.length <= 25);
  assert.equal(groups.flat().length, 1000);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- test/seed.test.js`
Expected: FAIL — `Cannot find module '../scripts/seed.js'`

- [x] **Step 3: Write the implementation**

```javascript
// scripts/seed.js
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { loadConfig } from '../src/config.js';
import { buildItem, itemSizeBytes } from '../src/item.js';

export const PARTITIONS = 50;
export const ITEMS_PER_PARTITION = 20;
const BATCH = 25; // BatchWriteItem hard limit

const pad = (n) => String(n).padStart(2, '0');

export function seedItems() {
  const items = [];
  for (let p = 0; p < PARTITIONS; p++)
    for (let i = 0; i < ITEMS_PER_PARTITION; i++)
      items.push(buildItem({ pk: `feed-${pad(p)}`, sk: `item-${pad(i)}` }));
  return items;
}

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function main() {
  const config = loadConfig();
  const items = seedItems();

  for (const it of items) {
    const size = itemSizeBytes(it);
    if (size < 900 || size > 1024)
      throw new Error(`item ${it.pk}/${it.sk} is ${size} B — outside the 900-1024 band the capacity model assumes`);
  }

  const base = new DynamoDBClient({
    region: config.region,
    ...(config.dynamoEndpoint ? { endpoint: config.dynamoEndpoint } : {}),
  });
  const doc = DynamoDBDocumentClient.from(base);

  let written = 0;
  for (const group of chunk(items, BATCH)) {
    let req = { [config.tableName]: group.map((Item) => ({ PutRequest: { Item } })) };
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await doc.send(new BatchWriteCommand({ RequestItems: req }));
      const un = r.UnprocessedItems?.[config.tableName] ?? [];
      if (!un.length) break;
      req = { [config.tableName]: un };
      await new Promise((res) => setTimeout(res, 100 * 2 ** attempt));
    }
    written += group.length;
    process.stdout.write(`\rseeded ${written}/${items.length}`);
  }
  console.log(`\nseeded ${written} items into ${config.tableName}`);
  base.destroy();
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- test/seed.test.js`
Expected: PASS — 6 tests.

- [x] **Step 5: Commit**

```bash
git add ecs-dynamodb-rps-ceiling/scripts/seed.js ecs-dynamodb-rps-ceiling/test/seed.test.js
git commit -m "feat(ecs-dynamodb-rps-ceiling): add deterministic seed script"
```

---

### Task 8: Container and integration test against DynamoDB Local

**Files:**
- Create: `ecs-dynamodb-rps-ceiling/Dockerfile`
- Create: `ecs-dynamodb-rps-ceiling/.dockerignore`
- Create: `ecs-dynamodb-rps-ceiling/docker-compose.test.yml`
- Test: `ecs-dynamodb-rps-ceiling/test/integration.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: a runnable image, and proof the whole request path works before a single dollar is spent in AWS.

This task exists to keep Task 10's `apply` gate cheap. Every bug found here is a bug not debugged at 25 minutes per provision cycle.

- [x] **Step 1: Write `docker-compose.test.yml`**

```yaml
services:
  dynamodb:
    image: amazon/dynamodb-local:2.5.2
    command: ["-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb"]
    ports: ["8000:8000"]
```

- [x] **Step 2: Write the failing integration test**

```javascript
// test/integration.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBClient, CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { createRepo } from '../src/dynamo.js';
import { createHandlers } from '../src/handlers.js';
import { createServer } from '../src/server.js';
import { seedItems, chunk } from '../scripts/seed.js';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

const config = {
  region: 'eu-central-1', tableName: 'items-test', feedPageSize: 20,
  pbkdf2Iterations: 50, itemTtlSeconds: 3600, dynamoEndpoint: 'http://localhost:8000',
};
process.env.AWS_ACCESS_KEY_ID ||= 'local';
process.env.AWS_SECRET_ACCESS_KEY ||= 'local';

let server, base, repo;
const url = (p) => `http://localhost:${server.address().port}${p}`;

before(async () => {
  base = new DynamoDBClient({ region: config.region, endpoint: config.dynamoEndpoint });
  await base.send(new CreateTableCommand({
    TableName: config.tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
  })).catch((e) => { if (e.name !== 'ResourceInUseException') throw e; });

  const doc = DynamoDBDocumentClient.from(base);
  for (const g of chunk(seedItems(), 25))
    await doc.send(new BatchWriteCommand({ RequestItems: { [config.tableName]: g.map((Item) => ({ PutRequest: { Item } })) } }));

  repo = createRepo(config);
  server = createServer({ handlers: createHandlers({ repo, config }) });
  await new Promise((r) => server.listen(0, r));
});

after(async () => { server.close(); repo.destroy(); base.destroy(); });

test('healthz responds without a Server-Timing header', async () => {
  const res = await fetch(url('/healthz'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get('server-timing'), null);
});

test('getItem returns a seeded item with db timing', async () => {
  const res = await fetch(url('/items/feed-07/item-03'));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).sk, 'item-03');
  assert.match(res.headers.get('server-timing'), /db;dur=[\d.]+/);
});

test('missing item 404s', async () => {
  assert.equal((await fetch(url('/items/feed-07/item-99'))).status, 404);
});

test('feed returns the full page with db and cpu timing', async () => {
  const res = await fetch(url('/feeds/feed-07'));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).count, 20);
  const t = res.headers.get('server-timing');
  assert.match(t, /db;dur=/); assert.match(t, /cpu;dur=/);
});

test('putItem creates a record under the w# prefix', async () => {
  const res = await fetch(url('/items'), { method: 'POST', body: '{}' });
  assert.equal(res.status, 201);
  assert.match((await res.json()).pk, /^w#/);
});

test('report queries, hashes and writes', async () => {
  const res = await fetch(url('/reports'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pk: 'feed-12' }),
  });
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.count, 20);
  assert.match(b.digest, /^[0-9a-f]{16}$/);
});

test('a write never lands in a seeded partition', async () => {
  await fetch(url('/items'), { method: 'POST', body: '{}' });
  assert.equal((await fetch(url('/feeds/feed-12'))).status, 200);
  assert.equal((await (await fetch(url('/feeds/feed-12'))).json()).count, 20, 'feed page size must be unchanged by writes');
});

test('stats reports event-loop lag in milliseconds', async () => {
  const s = await (await fetch(url('/stats'))).json();
  assert.ok(Number.isFinite(s.eventLoopDelayMs.p99));
  assert.ok(s.eventLoopDelayMs.max < 5000);
});

test('unknown route 404s', async () => {
  assert.equal((await fetch(url('/nope'))).status, 404);
});
```

- [x] **Step 3: Start DynamoDB Local and run the test**

```bash
docker compose -f docker-compose.test.yml up -d
npm run test:integration
```
Expected: PASS — 9 tests. If `getItem` fails with a credentials error, the `AWS_ACCESS_KEY_ID` defaults at the top of the test were not applied.

- [x] **Step 4: Write the `Dockerfile`**

```dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
```

- [x] **Step 5: Write `.dockerignore`**

```
node_modules
test
terraform
k6
grafana
*.md
*.html
docker-compose.test.yml
```

- [x] **Step 6: Build the image and smoke it against DynamoDB Local**

```bash
docker build -t ecs-dynamodb-rps-ceiling:local .
docker run --rm -d --name rps-smoke --network host \
  -e TABLE_NAME=items-test -e DYNAMO_ENDPOINT=http://localhost:8000 \
  -e AWS_ACCESS_KEY_ID=local -e AWS_SECRET_ACCESS_KEY=local -e AWS_REGION=eu-central-1 \
  ecs-dynamodb-rps-ceiling:local
sleep 2
curl -fsS localhost:8080/healthz && echo
curl -fsS -D- -o/dev/null localhost:8080/feeds/feed-07 | grep -i server-timing
docker rm -f rps-smoke
docker compose -f docker-compose.test.yml down
```
Expected: `{"ok":true}` and a `Server-Timing` header naming both `db` and `cpu`.

- [x] **Step 7: Commit**

```bash
git add ecs-dynamodb-rps-ceiling/Dockerfile ecs-dynamodb-rps-ceiling/.dockerignore ecs-dynamodb-rps-ceiling/docker-compose.test.yml ecs-dynamodb-rps-ceiling/test/integration.test.js ecs-dynamodb-rps-ceiling/package-lock.json
git commit -m "build(ecs-dynamodb-rps-ceiling): add container and dynamodb-local integration test"
```

---
## Phase 2 — Infrastructure (written and planned, not applied)

**TDD does not apply to HCL.** `CLAUDE.md` names configuration as the exception to the red-green loop, and the honest analogue is the measurement loop in Phase 4. The per-task verification here is Terraform's own: `fmt -check`, then `validate`, then a reviewed `plan`. Every HCL task ends with all three.

### Task 9: Terraform foundation — providers, network, ALB, ECR

**Files:**
- Create: `ecs-dynamodb-rps-ceiling/terraform/versions.tf`
- Create: `ecs-dynamodb-rps-ceiling/terraform/variables.tf`
- Create: `ecs-dynamodb-rps-ceiling/terraform/network.tf`
- Create: `ecs-dynamodb-rps-ceiling/terraform/alb.tf`
- Create: `ecs-dynamodb-rps-ceiling/terraform/ecr.tf`

**Interfaces:**
- Consumes: nothing.
- Produces: `aws_vpc.main`, `aws_subnet.public[*]`, `aws_route_table.public`, `aws_security_group.alb`, `aws_security_group.task`, `aws_lb.main`, `aws_lb_target_group.app`, `aws_lb_listener.http`, `aws_ecr_repository.app`, and the full variable set consumed by Task 10.

- [x] **Step 1: Write `versions.tf`**

```hcl
terraform {
  required_version = ">= 1.9"

  # Organization and workspace come from TF_CLOUD_ORGANIZATION / TF_WORKSPACE,
  # so no environment-specific value is committed here.
  cloud {}

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

# Region comes from AWS_REGION in the global .env.
provider "aws" {
  default_tags {
    tags = {
      Project = var.project
    }
  }
}

data "aws_region" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}
```

- [x] **Step 2: Write `variables.tf`**

```hcl
variable "project" {
  description = "Project name. Also the AWS Project tag and the commit scope. Do not change."
  type        = string
  default     = "ecs-dynamodb-rps-ceiling"
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "container_port" {
  type    = number
  default = 8080
}

variable "task_cpu" {
  description = "Fargate CPU units. 256 = 0.25 vCPU = 250ms of CPU per second."
  type        = number
  default     = 256
}

variable "task_memory" {
  type    = number
  default = 512
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "read_capacity" {
  description = "Provisioned RCU. Derived from slo.yaml via the capacity model; never guessed."
  type        = number
}

variable "write_capacity" {
  description = "Provisioned WCU. Derived from slo.yaml via the capacity model; never guessed."
  type        = number
}

variable "pbkdf2_iterations" {
  description = "CPU cost knob. Calibrated so the service ceiling lands at ~70% of the DB ceiling."
  type        = number
  default     = 0
}

variable "feed_page_size" {
  description = "Items per Query. Frozen at 20 — it sets the 2.5 RCU feed coefficient."
  type        = number
  default     = 20
}

variable "autoscaling_enabled" {
  type    = bool
  default = false
}

variable "autoscaling_min" {
  type    = number
  default = 1
}

variable "autoscaling_max" {
  type    = number
  default = 4
}

variable "autoscaling_cpu_target" {
  type    = number
  default = 60
}

variable "image_tag" {
  type    = string
  default = "latest"
}

variable "log_retention_days" {
  description = "Short. An implicitly-created log group survives destroy and bills forever."
  type        = number
  default     = 1
}
```

- [x] **Step 3: Write `network.tf`**

```hcl
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = var.project
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = var.project
  }
}

# Public subnets only. Tasks get public IPs so the ECR pull works without a NAT
# gateway (~$32/mo, and the most common teardown survivor).
resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.project}-public-${count.index}"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${var.project}-public"
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Gateway endpoints are not billed hourly, unlike interface endpoints.
resource "aws_vpc_endpoint" "dynamodb" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id]

  tags = {
    Name = "${var.project}-dynamodb"
  }
}

resource "aws_security_group" "alb" {
  name        = "${var.project}-alb"
  description = "Public ingress for the load balancer"
  vpc_id      = aws_vpc.main.id

  # Grafana Cloud k6 generators arrive from the public internet.
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project}-alb"
  }
}

resource "aws_security_group" "task" {
  name        = "${var.project}-task"
  description = "Tasks accept traffic only from the ALB"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project}-task"
  }
}
```

- [x] **Step 4: Write `alb.tf`**

```hcl
resource "aws_lb" "main" {
  name               = var.project
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
  idle_timeout       = 60
}

resource "aws_lb_target_group" "app" {
  name        = var.project
  port        = var.container_port
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  # Short, so a rolling deploy does not stretch out the measurement window.
  deregistration_delay = 10

  health_check {
    path                = "/healthz"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}
```

- [x] **Step 5: Write `ecr.tf`**

```hcl
resource "aws_ecr_repository" "app" {
  name = var.project

  # Disposable lab: destroy must not strand images and start billing storage.
  force_delete = true

  image_scanning_configuration {
    scan_on_push = false
  }
}
```

- [x] **Step 6: Format and validate**

```bash
cd ecs-dynamodb-rps-ceiling
terraform -chdir=terraform fmt -check -recursive
terraform -chdir=terraform init
terraform -chdir=terraform validate
```

Expected: `fmt -check` silent, `validate` reports "Success!". Two likely failures: `TF_CLOUD_ORGANIZATION` unset (`init` cannot resolve `cloud {}` — export it from the global `.env`), and `data.aws_region.current.region` unknown on AWS provider 5.x (this plan pins `~> 6.0`; on 5.x the attribute is `.name`).

- [x] **Step 7: Commit**

```bash
git add ecs-dynamodb-rps-ceiling/terraform
git commit -m "feat(ecs-dynamodb-rps-ceiling/terraform): add network, alb and ecr"
```

---

### Task 10: Terraform data and compute — DynamoDB, ECS, autoscaling, outputs

**Files:**
- Create: `ecs-dynamodb-rps-ceiling/terraform/dynamodb.tf`
- Create: `ecs-dynamodb-rps-ceiling/terraform/ecs.tf`
- Create: `ecs-dynamodb-rps-ceiling/terraform/autoscaling.tf`
- Create: `ecs-dynamodb-rps-ceiling/terraform/outputs.tf`
- Create: `ecs-dynamodb-rps-ceiling/terraform/dev.tfvars`

**Interfaces:**
- Consumes: everything from Task 9.
- Produces: outputs `base_url`, `table_name`, `ecr_repository_url`, `cluster_name`, `service_name`, `provisioned_capacity`. `/loadtest` reads `base_url` from `terraform output` — never from memory.

**Starting capacity is deliberately 25/25** — the DynamoDB monthly free tier. Enough to smoke test in Task 12, costs nothing, and keeps the first provisioning step a cheap mistake. Real capacity is derived from `slo.yaml` in Task 18.

- [x] **Step 1: Write `dynamodb.tf`**

```hcl
resource "aws_dynamodb_table" "items" {
  name           = var.project
  billing_mode   = "PROVISIONED"
  read_capacity  = var.read_capacity
  write_capacity = var.write_capacity
  hash_key       = "pk"
  range_key      = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  # Insurance against a long-lived environment only. TTL deletion is
  # asynchronous and will not keep the table small during a session.
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }
}
```

- [x] **Step 2: Write `ecs.tf`**

```hcl
resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.project}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_cluster" "main" {
  name = var.project
}

data "aws_iam_policy_document" "assume_ecs_tasks" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.project}-execution"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_tasks.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "task" {
  name               = "${var.project}-task"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_tasks.json
}

data "aws_iam_policy_document" "table_access" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:BatchWriteItem"]
    resources = [aws_dynamodb_table.items.arn]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "${var.project}-table-access"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.table_access.json
}

resource "aws_ecs_task_definition" "app" {
  family                   = var.project
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "app"
    image     = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
    essential = true

    portMappings = [{
      containerPort = var.container_port
      protocol      = "tcp"
    }]

    environment = [
      { name = "PORT", value = tostring(var.container_port) },
      { name = "TABLE_NAME", value = aws_dynamodb_table.items.name },
      { name = "AWS_REGION", value = data.aws_region.current.region },
      { name = "PBKDF2_ITERATIONS", value = tostring(var.pbkdf2_iterations) },
      { name = "FEED_PAGE_SIZE", value = tostring(var.feed_page_size) },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "app"
      }
    }
  }])
}

resource "aws_ecs_service" "app" {
  name            = var.project
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "app"
    container_port   = var.container_port
  }

  # Application Auto Scaling owns desired_count once enabled; without this,
  # every plan would try to reset it and fight the scaling policy.
  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.http]
}
```

- [x] **Step 3: Write `autoscaling.tf`**

```hcl
# Gated by a variable so enabling it is a one-line tfvars change — which is
# exactly the "change one thing" the before/after comparison requires.
resource "aws_appautoscaling_target" "ecs" {
  count              = var.autoscaling_enabled ? 1 : 0
  min_capacity       = var.autoscaling_min
  max_capacity       = var.autoscaling_max
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.app.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu" {
  count              = var.autoscaling_enabled ? 1 : 0
  name               = "${var.project}-cpu-target-tracking"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs[0].resource_id
  scalable_dimension = aws_appautoscaling_target.ecs[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs[0].service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }

    target_value = var.autoscaling_cpu_target

    # Scale out fast, in slowly: a spike profile must not be answered
    # and then un-answered inside the same run.
    scale_out_cooldown = 30
    scale_in_cooldown  = 120
  }
}
```

- [x] **Step 4: Write `outputs.tf`**

```hcl
output "base_url" {
  description = "Target for k6. /loadtest reads this, never a remembered URL."
  value       = "http://${aws_lb.main.dns_name}"
}

output "table_name" {
  value = aws_dynamodb_table.items.name
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "service_name" {
  value = aws_ecs_service.app.name
}

output "provisioned_capacity" {
  description = "Recorded in results.md alongside every run."
  value = {
    read_capacity  = aws_dynamodb_table.items.read_capacity
    write_capacity = aws_dynamodb_table.items.write_capacity
  }
}
```

- [x] **Step 5: Write `dev.tfvars`**

```hcl
# Starting capacity is the DynamoDB free tier (25/25) so the first provisioning
# step and the Task 12 smoke test cost nothing. Real capacity is derived from
# slo.yaml in Task 18 — do not hand-edit these two numbers.
read_capacity  = 25
write_capacity = 25

task_cpu      = 256
task_memory   = 512
desired_count = 1

pbkdf2_iterations = 0 # calibrated in Task 17
feed_page_size    = 20

autoscaling_enabled = false
```

- [x] **Step 6: Format, validate, and review the plan**

```bash
terraform -chdir=terraform fmt -check -recursive
terraform -chdir=terraform validate
terraform -chdir=terraform plan -var-file=dev.tfvars
```

Expected: `validate` succeeds; `plan` shows resources to add and **no** resources to destroy. Read the plan and confirm every billable item is expected: **1 ALB** (~$0.023/hr + LCU), **1 Fargate task** at 0.25 vCPU, **1 DynamoDB table at 25/25** (free tier), **1 ECR repository**, **1 log group**. If a NAT gateway appears anywhere, stop — the design has been broken.

- [x] **Step 7: Commit**

```bash
git add ecs-dynamodb-rps-ceiling/terraform
git commit -m "feat(ecs-dynamodb-rps-ceiling/terraform): add dynamodb, ecs service and autoscaling"
```

---

## Phase 3 — Provision and smoke

### Task 11: APPROVAL GATE — first provisioning run

**Files:** none changed.

**This task creates billable AWS resources and STOPS for explicit human approval.** A subagent must not proceed past step 3 without it. The `PreToolUse` hook in `.claude/hooks/guard-terraform.sh` will prompt, and it hard-denies any attempt to skip the prompt with an approval-bypass flag.

- [x] **Step 1: Assert the account before anything else**

```bash
[ -n "$AWS_ACCESS_KEY_ID" ] || { echo "no AWS creds loaded — create .env and run: set -a && source .env && set +a"; exit 1; }
ACTUAL=$(aws sts get-caller-identity --query Account --output text)
[ "$ACTUAL" = "$AWS_ACCOUNT_ID" ] || { echo "WRONG ACCOUNT: $ACTUAL != $AWS_ACCOUNT_ID"; exit 1; }
echo "account $ACTUAL confirmed"
```

**As of writing this plan there is no `.env` in the repo**, so this check fails closed — and without it the machine's default profile would be used silently. Create `.env` from `.env.example` first; this is step 1 of §13 in the spec, not an optional preliminary.

- [x] **Step 2: Re-plan and summarize in chat**

```bash
terraform -chdir=terraform plan -var-file=dev.tfvars -out=tfplan
```

Report counts of add/change/destroy and name every resource that costs money while idle.

- [x] **Step 3: STOP — get explicit approval**

Do not run step 4 until a human has said yes to the plan output from step 2.

- [x] **Step 4: Run it**

Use `/env up ecs-dynamodb-rps-ceiling`, which performs the account assertion, the plan summary and the gate in one place. It ends by applying the saved `tfplan`.

- [x] **Step 5: Record the outputs and the time**

```bash
terraform -chdir=terraform output
date -u +"environment up at %Y-%m-%dT%H:%M:%SZ"
```

Note the time so idle cost is visible later. The service will be unhealthy until Task 12 pushes an image — that is expected, not a failure.

---

### Task 12: Push the image, seed, and smoke the deployed service

**Files:** none changed.

**Interfaces:**
- Consumes: `ecr_repository_url`, `base_url`, `table_name` from Task 11's outputs.
- Produces: a healthy service and the first real per-class latency numbers, which Task 14 uses to check that the class thresholds are achievable at all.

- [x] **Step 1: Build and push**

```bash
cd ecs-dynamodb-rps-ceiling
REPO=$(terraform -chdir=terraform output -raw ecr_repository_url)
aws ecr get-login-password | docker login --username AWS --password-stdin "${REPO%%/*}"
docker build --platform linux/amd64 -t "$REPO:latest" .
docker push "$REPO:latest"
```

`--platform linux/amd64` is required on Apple Silicon — Fargate rejects an arm64 image on an x86 task definition with a cryptic `CannotPullContainerError`.

- [x] **Step 2: Force a new deployment and wait for health**

```bash
CL=$(terraform -chdir=terraform output -raw cluster_name)
SV=$(terraform -chdir=terraform output -raw service_name)
aws ecs update-service --cluster "$CL" --service "$SV" --force-new-deployment >/dev/null
aws ecs wait services-stable --cluster "$CL" --services "$SV"
```

- [x] **Step 3: Seed the table**

```bash
TABLE_NAME=$(terraform -chdir=terraform output -raw table_name) npm run seed
```

Expected: `seeded 1000 items`. At 25 WCU this is throttled and slow — the retry loop handles it; give it a few minutes. If it fails outright, the capacity is too low for even a seed, which is information worth recording.

- [x] **Step 4: Smoke every endpoint against the ALB**

```bash
BASE=$(terraform -chdir=terraform output -raw base_url)
curl -fsS "$BASE/healthz"; echo
curl -fsS -D- -o/dev/null "$BASE/items/feed-07/item-03" | grep -i server-timing
curl -fsS -D- -o/dev/null "$BASE/feeds/feed-07"          | grep -i server-timing
curl -fsS -X POST "$BASE/items" -d '{}'; echo
curl -fsS -X POST "$BASE/reports" -H 'content-type: application/json' -d '{"pk":"feed-12"}'; echo
curl -fsS "$BASE/stats" | head -c 300; echo
```

Expected: every call 2xx; `Server-Timing` present with `db` on item reads and both `db` and `cpu` on feed and report.

- [x] **Step 5: Record the baseline latency of each class**

```bash
for p in "/items/feed-07/item-03" "/feeds/feed-07"; do
  echo -n "$p  "
  curl -o /dev/null -s -w '%{time_total}\n' "$BASE$p"
done
```

Write these numbers down. If the *fast* class baseline is already near 50 ms, the class thresholds in `slo.yaml` are not achievable and Task 14 must revisit them before any run — a threshold that can never pass is not an SLO.

- [x] **Step 6: Report findings**

No files change in this task. Report the smoke results and the baseline latencies in chat.

---
## Phase 4 — SLO and load profiles

### Task 13: Teach `/slo` the class-threshold ratio SLI

**Files:**
- Modify: `.claude/skills/slo/SKILL.md`

**Why this task exists.** `/slo` documents exactly two SLI types, `success_rate` and `latency_percentile`. The spec's objective is neither: it is *the share of requests meeting their own class's threshold*. Without this extension `/slo` cannot generate the thresholds this project needs, and the k6 and Grafana definitions would be hand-written in two places — the precise failure the skill exists to prevent.

**Interfaces:**
- Consumes: nothing.
- Produces: a documented `class_threshold_ratio` SLI type and a documented `capacity:` block, both consumed by Task 14.

- [x] **Step 1: Add the new SLI type to the skill's source-file section**

Insert after the existing `slo.yaml` example:

````markdown
### SLI type: `class_threshold_ratio`

For a service whose endpoints have different natural costs. A percentile cannot compose across them —
it measures the traffic mix, not the system — and it cannot produce an error budget. This type judges
each request against a threshold appropriate to its own class and reports one ratio.

```yaml
slos:
  - name: latency-classes
    sli: class_threshold_ratio
    objective: 99.0          # percent of requests meeting their class threshold
    tail_objective: 99.9     # percent meeting tail_multiplier x their threshold
    tail_multiplier: 3
    classes:
      fast:     { threshold_ms: 50,  endpoints: [getItem, putItem] }
      standard: { threshold_ms: 200, endpoints: [feed] }
      heavy:    { threshold_ms: 800, endpoints: [report] }
```

Every endpoint named in the service must appear in exactly one class. An endpoint in no class is
silently unmeasured, which is worse than an endpoint with a wrong threshold.

**Generated k6:** a custom `Rate` per objective plus tagged per-class sub-metric thresholds. The
per-class entries are diagnostic and are **not** the gate — the gate is the ratio.

**Generated Grafana:** `grafana_slo` takes a Success/Total ratio query, so this type maps onto it
directly; `latency_percentile` does not, and never did.
````

- [x] **Step 2: Add the `capacity:` block to the same section**

````markdown
### The `capacity:` block

Where the SLO sizes the database. One file, so the objective and the provisioned capacity cannot
drift apart.

```yaml
capacity:
  target_rps: 1000
  mix: { read: 0.55, write: 0.15, feed: 0.25, report: 0.05 }
  cost_per_request:                 # capacity units, from the datastore's own rules
    read:   { rcu: 0.5, wcu: 0 }
    write:  { rcu: 0,   wcu: 1 }
    feed:   { rcu: 2.5, wcu: 0 }
    report: { rcu: 2.5, wcu: 1 }
```

Generates `<project>/terraform/capacity.auto.tfvars`:

```hcl
# GENERATED from slo.yaml by /slo. Do not edit by hand.
read_capacity  = 1025   # 1.025 x 1000 rps
write_capacity = 200    # 0.200 x 1000 rps
```

The `mix` shares must sum to 1.0. Refuse to generate otherwise — a mix that does not sum to one
produces capacity numbers that are quietly wrong rather than obviously wrong.
````

- [x] **Step 3: Add a third generated output to the skill's output list**

````markdown
## Generated output 3 — Terraform capacity variables

Into `<project>/terraform/capacity.auto.tfvars`, from the `capacity:` block. Terraform loads
`*.auto.tfvars` automatically, so no `-var-file` flag changes. Note `.gitignore` covers
`*.auto.tfvars` at the repo root — for a generated, non-secret file that is wrong; add a negation
(`!<project>/terraform/capacity.auto.tfvars`) so the derived capacity is committed alongside the
`slo.yaml` it came from.
````

- [x] **Step 4: Verify the skill still parses as a skill**

Run: `head -5 .claude/skills/slo/SKILL.md`
Expected: the YAML frontmatter (`name: slo`, `description: ...`) is intact and first in the file.

- [x] **Step 5: Commit**

```bash
git add .claude/skills/slo/SKILL.md
git commit -m "feat(repo): teach /slo the class-threshold ratio sli and capacity block"
```

---

### Task 14: Write `slo.yaml` and generate its outputs

**Files:**
- Create: `ecs-dynamodb-rps-ceiling/slo.yaml`
- Create: `ecs-dynamodb-rps-ceiling/k6/lib/slo.js` (generated)
- Create: `ecs-dynamodb-rps-ceiling/terraform/capacity.auto.tfvars` (generated)
- Create: `ecs-dynamodb-rps-ceiling/grafana/alerts.tf` (generated)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: the `class_threshold_ratio` and `capacity:` schema from Task 13; the baseline latencies measured in Task 12.
- Produces: `CLASS_THRESHOLD_MS`, `TAIL_MULTIPLIER`, `thresholds` exported from `k6/lib/slo.js`, consumed by Tasks 15 and 16; `read_capacity`/`write_capacity` consumed by Task 18.

**Before writing this file, check it against Task 12's measured baselines.** If the *fast* class already measures near 50 ms unloaded, the threshold is unachievable and must be raised now — a threshold that can never pass is not an SLO, and every subsequent run would be meaningless.

- [x] **Step 1: Write `slo.yaml`**

```yaml
service: ecs-dynamodb-rps-ceiling
window: 30d

slos:
  - name: latency-classes
    sli: class_threshold_ratio
    objective: 99.0
    tail_objective: 99.9
    tail_multiplier: 3
    classes:
      fast:     { threshold_ms: 50,  endpoints: [getItem, putItem] }
      standard: { threshold_ms: 200, endpoints: [feed] }
      heavy:    { threshold_ms: 800, endpoints: [report] }

  - name: availability
    sli: success_rate
    objective: 99.9

capacity:
  target_rps: 1000
  mix: { read: 0.55, write: 0.15, feed: 0.25, report: 0.05 }
  cost_per_request:
    read:   { rcu: 0.5, wcu: 0 }
    write:  { rcu: 0,   wcu: 1 }
    feed:   { rcu: 2.5, wcu: 0 }
    report: { rcu: 2.5, wcu: 1 }
```

- [x] **Step 2: Generate the outputs**

Run: `/slo ecs-dynamodb-rps-ceiling`

Expected `k6/lib/slo.js`:

```javascript
// GENERATED from slo.yaml by /slo. Do not edit by hand.
export const CLASS_THRESHOLD_MS = { fast: 50, standard: 200, heavy: 800 };
export const TAIL_MULTIPLIER = 3;

export const thresholds = {
  // PRIMARY gate: >=99.0% of requests meet their own class threshold.
  slo_met: ['rate>0.99'],
  // TAIL: >=99.9% meet 3x their class threshold.
  slo_met_tail: ['rate>0.999'],
  // Availability 99.9%. k6's rate metric counts FAILURES, so the objective inverts:
  // 99.9% success  ->  failure rate < 0.001.
  http_req_failed: ['rate<0.001'],
  // Secondary, per class. Diagnostic only — these are NOT the gate.
  'http_req_duration{class:fast}': ['p(99)<50'],
  'http_req_duration{class:standard}': ['p(99)<200'],
  'http_req_duration{class:heavy}': ['p(99)<800'],
};
```

Expected `terraform/capacity.auto.tfvars`:

```hcl
# GENERATED from slo.yaml by /slo. Do not edit by hand.
# 0.55*0.5 + 0.25*2.5 + 0.05*2.5 = 1.025 RCU per rps
# 0.15*1.0 + 0.05*1.0             = 0.200 WCU per rps
read_capacity  = 1025
write_capacity = 200
```

- [x] **Step 3: Un-ignore the generated tfvars**

Append to `.gitignore`:

```
# Generated by /slo from slo.yaml — non-secret and must be committed alongside it.
!ecs-dynamodb-rps-ceiling/terraform/capacity.auto.tfvars
```

- [x] **Step 4: Remove the hand-written capacity from `dev.tfvars`**

Delete the `read_capacity` / `write_capacity` lines from `terraform/dev.tfvars` — they now come from the generated file, and two sources for one number is exactly the drift this design exists to prevent. Leave a comment in their place:

```hcl
# read_capacity / write_capacity come from capacity.auto.tfvars, generated by /slo.
```

- [x] **Step 5: Verify no drift**

Run: `/slo ecs-dynamodb-rps-ceiling --check`
Expected: no drift reported. Then `terraform -chdir=terraform plan -var-file=dev.tfvars` and confirm the only change is DynamoDB capacity 25/25 → 1025/200. **Do not apply yet** — that is Task 18.

- [x] **Step 6: Commit**

```bash
git add ecs-dynamodb-rps-ceiling/slo.yaml ecs-dynamodb-rps-ceiling/k6/lib/slo.js \
        ecs-dynamodb-rps-ceiling/terraform/capacity.auto.tfvars ecs-dynamodb-rps-ceiling/terraform/dev.tfvars \
        ecs-dynamodb-rps-ceiling/grafana/alerts.tf .gitignore
git commit -m "feat(ecs-dynamodb-rps-ceiling): define slo and generate thresholds, alerts and capacity"
```

---

### Task 15: k6 mix and request library

**Files:**
- Create: `ecs-dynamodb-rps-ceiling/k6/lib/mix.js`
- Create: `ecs-dynamodb-rps-ceiling/k6/lib/request.js`

**Interfaces:**
- Consumes: `CLASS_THRESHOLD_MS`, `TAIL_MULTIPLIER` from `k6/lib/slo.js` (Task 14).
- Produces: `pick(iteration) -> 'read'|'write'|'feed'|'report'`; `doRequest(baseUrl)`; `pollStats(baseUrl)`; and the metrics `slo_met`, `slo_met_tail`, `db_ms`, `cpu_ms`, `el_delay_p99_ms`. All three profiles in Task 16 import these, so no profile can quietly assert something different.

- [x] **Step 1: Write `k6/lib/mix.js`**

```javascript
// The frozen 55/15/25/5 mix, expressed deterministically over a 20-iteration
// cycle: 11 reads, 3 writes, 5 feeds, 1 report. Not Math.random() — sampling
// variance between runs would surface as a difference in the result, and this
// mix is the thing every recorded number is stated at.
export const CYCLE = [
  'read', 'read', 'feed', 'read', 'write',
  'read', 'feed', 'read', 'read', 'feed',
  'write', 'read', 'feed', 'read', 'read',
  'report', 'feed', 'read', 'write', 'read',
];

export function pick(iteration) {
  return CYCLE[iteration % CYCLE.length];
}
```

- [x] **Step 2: Verify the cycle really is 55/15/25/5**

```bash
node -e "
const { CYCLE } = await import('./ecs-dynamodb-rps-ceiling/k6/lib/mix.js');
const c = {}; for (const k of CYCLE) c[k] = (c[k]||0)+1;
console.log(c, 'total', CYCLE.length);
const want = { read: 11, write: 3, feed: 5, report: 1 };
for (const k in want) if (c[k] !== want[k]) { console.error('WRONG', k, c[k], '!=', want[k]); process.exit(1); }
console.log('mix OK: 55/15/25/5');
" --input-type=module
```

Expected: `mix OK: 55/15/25/5`. This check is cheap and catches a mis-typed cycle array, which would silently change every capacity coefficient.

- [x] **Step 3: Write `k6/lib/request.js`**

```javascript
import http from 'k6/http';
import exec from 'k6/execution';
import { Rate, Trend } from 'k6/metrics';
import { pick } from './mix.js';
import { CLASS_THRESHOLD_MS, TAIL_MULTIPLIER } from './slo.js';

export const sloMet = new Rate('slo_met');
export const sloMetTail = new Rate('slo_met_tail');
export const dbMs = new Trend('db_ms', true);
export const cpuMs = new Trend('cpu_ms', true);
export const elDelay = new Trend('el_delay_p99_ms', true);

const PARTITIONS = 50;
const ITEMS_PER_PARTITION = 20;
const pad = (n) => String(n).padStart(2, '0');

const CLASS_OF = { read: 'fast', write: 'fast', feed: 'standard', report: 'heavy' };
const JSON_HEADERS = { 'Content-Type': 'application/json' };

function parseServerTiming(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(',')) {
    const m = /([a-zA-Z_]+);dur=([\d.]+)/.exec(part.trim());
    if (m) out[m[1]] = parseFloat(m[2]);
  }
  return out;
}

export function doRequest(baseUrl) {
  const i = exec.scenario.iterationInTest;
  const kind = pick(i);
  const cls = CLASS_OF[kind];
  const tags = { class: cls, kind };
  const feed = `feed-${pad(i % PARTITIONS)}`;

  let res;
  if (kind === 'read') {
    res = http.get(`${baseUrl}/items/${feed}/item-${pad(i % ITEMS_PER_PARTITION)}`, { tags });
  } else if (kind === 'feed') {
    res = http.get(`${baseUrl}/feeds/${feed}`, { tags });
  } else if (kind === 'write') {
    res = http.post(`${baseUrl}/items`, '{}', { headers: JSON_HEADERS, tags });
  } else {
    res = http.post(`${baseUrl}/reports`, JSON.stringify({ pk: feed }), { headers: JSON_HEADERS, tags });
  }

  // The primary SLI: did THIS request meet the threshold for ITS class?
  const ok = res.status >= 200 && res.status < 300;
  const limit = CLASS_THRESHOLD_MS[cls];
  sloMet.add(ok && res.timings.duration < limit, tags);
  sloMetTail.add(ok && res.timings.duration < limit * TAIL_MULTIPLIER, tags);

  // Server-side attribution: which resource is the ceiling?
  const st = parseServerTiming(res.headers['Server-Timing']);
  if (st.db !== undefined) dbMs.add(st.db, tags);
  if (st.cpu !== undefined) cpuMs.add(st.cpu, tags);

  return res;
}

export function pollStats(baseUrl) {
  const res = http.get(`${baseUrl}/stats`, { tags: { class: 'stats' } });
  if (res.status === 200) {
    const body = res.json();
    if (body && body.eventLoopDelayMs) elDelay.add(body.eventLoopDelayMs.p99);
  }
}
```

**Note on `http_req_failed`:** the 1 RPS stats scenario contributes to it. At one request per second against hundreds it cannot move a 0.1% threshold, but if the primary load ever drops below ~1000 RPS *and* stats starts failing, check it before blaming the service.

- [x] **Step 4: Commit**

```bash
git add ecs-dynamodb-rps-ceiling/k6/lib
git commit -m "test(ecs-dynamodb-rps-ceiling/k6): add deterministic mix and request library"
```

---

### Task 16: The three load profiles, and teaching `/loadtest` cloud runs

**Files:**
- Create: `ecs-dynamodb-rps-ceiling/k6/discovery.js`
- Create: `ecs-dynamodb-rps-ceiling/k6/constant.js`
- Create: `ecs-dynamodb-rps-ceiling/k6/stress.js`
- Modify: `.claude/skills/loadtest/SKILL.md`

**Interfaces:**
- Consumes: `thresholds` from `k6/lib/slo.js`; `doRequest`/`pollStats` from `k6/lib/request.js`.
- Produces: three profiles, frozen after Task 18.

**The discovery profile finds the knee by aborting at it.** A k6 summary is aggregate over the whole run, so it cannot tell you *where* the SLO broke. Instead the ramp is a single linear function of time with `abortOnFail`, so the run stops at the knee and the arrival rate at that moment is computable:

```
knee_rps = START_RATE + (MAX_RATE - START_RATE) x (elapsed_seconds / RAMP_SECONDS)
```

This also saves VU-hours, which §10 of the spec names as the binding budget.

- [x] **Step 1: Write `k6/discovery.js`**

```javascript
import { thresholds } from './lib/slo.js';
import { doRequest, pollStats } from './lib/request.js';

const BASE_URL = __ENV.BASE_URL;
export const START_RATE = Number(__ENV.START_RATE || 50);
export const MAX_RATE = Number(__ENV.MAX_RATE || 2000);
export const RAMP_SECONDS = Number(__ENV.RAMP_SECONDS || 900);

export const options = {
  cloud: {
    name: 'ecs-dynamodb-rps-ceiling discovery',
    distribution: { frankfurt: { loadZone: 'amazon:de:frankfurt', percent: 100 } },
  },
  // Abort at the knee: the run stops the moment the primary SLI drops below
  // objective, and the arrival rate at that instant IS the capacity number.
  thresholds: {
    ...thresholds,
    slo_met: [{ threshold: 'rate>0.99', abortOnFail: true, delayAbortEval: '30s' }],
  },
  scenarios: {
    ramp: {
      executor: 'ramping-arrival-rate',
      startRate: START_RATE,
      timeUnit: '1s',
      // Pre-allocated, never grown mid-test: k6 documents that allocating VUs
      // during a run costs CPU and memory on the generator and skews results.
      preAllocatedVUs: Number(__ENV.PRE_VUS || 400),
      stages: [{ target: MAX_RATE, duration: `${RAMP_SECONDS}s` }],
      gracefulStop: '10s',
    },
    stats: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '1s',
      duration: `${RAMP_SECONDS}s`,
      preAllocatedVUs: 2,
      exec: 'stats',
      gracefulStop: '5s',
    },
  },
};

export default function () { doRequest(BASE_URL); }
export function stats() { pollStats(BASE_URL); }
```

- [x] **Step 2: Write `k6/constant.js`**

```javascript
import { thresholds } from './lib/slo.js';
import { doRequest, pollStats } from './lib/request.js';

const BASE_URL = __ENV.BASE_URL;
const RATE = Number(__ENV.RATE);        // the knee from discovery. No default: guessing it is the bug.
const DURATION = __ENV.DURATION || '5m';

if (!RATE) throw new Error('RATE is required — it is the discovered knee, not a guess');

export const options = {
  cloud: {
    name: 'ecs-dynamodb-rps-ceiling constant',
    distribution: { frankfurt: { loadZone: 'amazon:de:frankfurt', percent: 100 } },
  },
  thresholds,
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Number(__ENV.PRE_VUS || 400),
      gracefulStop: '10s',
    },
    stats: {
      executor: 'constant-arrival-rate',
      rate: 1, timeUnit: '1s', duration: DURATION,
      preAllocatedVUs: 2, exec: 'stats', gracefulStop: '5s',
    },
  },
};

export default function () { doRequest(BASE_URL); }
export function stats() { pollStats(BASE_URL); }
```

- [x] **Step 3: Write `k6/stress.js`**

```javascript
import { thresholds } from './lib/slo.js';
import { doRequest, pollStats } from './lib/request.js';

const BASE_URL = __ENV.BASE_URL;
const RATE = Number(__ENV.RATE);          // the knee
const MULTIPLIER = Number(__ENV.MULTIPLIER || 3);

if (!RATE) throw new Error('RATE is required — it is the discovered knee, not a guess');

const PEAK = Math.round(RATE * MULTIPLIER);

export const options = {
  cloud: {
    name: 'ecs-dynamodb-rps-ceiling stress',
    distribution: { frankfurt: { loadZone: 'amazon:de:frankfurt', percent: 100 } },
  },
  // No abortOnFail here: this profile is SUPPOSED to breach. Aborting would
  // discard exactly the error-budget burn it exists to measure.
  thresholds,
  scenarios: {
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: RATE,
      timeUnit: '1s',
      preAllocatedVUs: Number(__ENV.PRE_VUS || 1200),
      stages: [
        { target: RATE, duration: '1m' },   // hold at the known-good rate
        { target: PEAK, duration: '30s' },  // spike
        { target: PEAK, duration: '2m' },   // hold past the burst window
        { target: RATE, duration: '30s' },  // recover
        { target: RATE, duration: '1m' },
      ],
      gracefulStop: '15s',
    },
    stats: {
      executor: 'constant-arrival-rate',
      rate: 1, timeUnit: '1s', duration: '5m',
      preAllocatedVUs: 2, exec: 'stats', gracefulStop: '5s',
    },
  },
};

export default function () { doRequest(BASE_URL); }
export function stats() { pollStats(BASE_URL); }
```

The 2-minute hold at peak is deliberate: DynamoDB banks burst capacity for ~300 s, so a shorter spike could be absorbed entirely and would prove nothing.

- [x] **Step 4: Verify the scripts parse without running them**

```bash
cd ecs-dynamodb-rps-ceiling
BASE_URL=http://x RATE=100 k6 inspect k6/discovery.js >/dev/null && echo "discovery OK"
BASE_URL=http://x RATE=100 k6 inspect k6/constant.js  >/dev/null && echo "constant OK"
BASE_URL=http://x RATE=100 k6 inspect k6/stress.js    >/dev/null && echo "stress OK"
```

Expected: three OK lines. `k6 inspect` parses options without generating load, so this costs nothing.

- [x] **Step 5: Establish how cloud runs produce a machine-readable summary**

```bash
k6 cloud run --help | grep -iE 'summary|export|out' || echo "no summary-export flag on cloud run"
k6 cloud load-zone list
```

This is a genuine unknown and must be resolved before Task 18, not during it. Two outcomes:
- **`k6 cloud run` supports `--summary-export`** — use it directly and `/loadtest`'s existing `jq` parsing applies unchanged.
- **It does not** — the run's results live in Grafana Cloud. Record the run URL and read the metrics from the Grafana Cloud k6 result page or its API. In that case `/loadtest`'s summary-JSON steps do not apply to cloud runs and the skill must say so rather than silently produce nothing.

Also confirm `amazon:de:frankfurt` appears in the zone list for this stack — the whole load-origin decision in the spec rests on it.

- [x] **Step 6: Extend `.claude/skills/loadtest/SKILL.md`**

Add a cloud-run section recording what step 5 found, and replace the results table header with the columns the spec requires:

````markdown
### Cloud runs

This repo's projects run from Grafana Cloud so the generator is not the bottleneck and RTT is not
charged against the latency budget. The command is `k6 cloud run`, not `k6 run`.

Capture the exit code on the k6 line itself — behind a pipe you get the pipe's status. `99` means a
threshold was breached; `0` means all passed.

### Results table

| date | profile | infra change | RPS | bound resource | evidence | SLO attainment | budget burn x | p95 fast/std/heavy | db ms | cpu ms | EL lag p99 | throttles | RCU/WCU | $/hr |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

`bound resource` and `evidence` are not optional. A ceiling with no attributed cause is a number,
not a result — DynamoDB `ThrottledRequests` climbing means DB-bound; event-loop lag climbing with
flat `db_ms` means service-bound.

`budget burn x` is the burn-rate multiple: observed error rate / budgeted error rate. A k6 run is
minutes and a Grafana SLO window is 30 days, so a raw "0.03% of budget" figure does not travel
between runs. The multiple does.
````

- [x] **Step 7: Commit**

```bash
git add ecs-dynamodb-rps-ceiling/k6 .claude/skills/loadtest/SKILL.md
git commit -m "test(ecs-dynamodb-rps-ceiling/k6): add discovery, constant and stress profiles"
```

---

### Task 17: Calibrate the CPU knob

**Files:**
- Create: `ecs-dynamodb-rps-ceiling/scripts/calibrate.js`
- Modify: `ecs-dynamodb-rps-ceiling/terraform/dev.tfvars`

**Interfaces:**
- Consumes: `burn` from `src/cpu.js`.
- Produces: `iterationsFor(targetMs) -> number`, and the calibrated `pbkdf2_iterations` value.

**Target.** §9 of the spec wants the service ceiling at ~70% of the budgeted DB ceiling, so that run A binds on the service and autoscaling has something real to release. From §5's budget: at 0.25 vCPU and 1000 RPS the whole request has 250 µs of CPU, and the *report* endpoint — 5% of traffic — can afford roughly **1.4 ms** while the cheap paths stay under ~150 µs. Calibrate the report endpoint's burn to that.

**This must run on the target CPU, not a laptop.** An M-series core is several times faster than a 0.25 vCPU Fargate slice, so a locally-calibrated iteration count would be badly wrong. Run it in the deployed container.

- [x] **Step 1: Write `scripts/calibrate.js`**

```javascript
import { burn } from '../src/cpu.js';

/** Binary-search the iteration count whose cost is closest to targetMs on THIS cpu. */
export function iterationsFor(targetMs, { lo = 1, hi = 200000, samples = 7 } = {}) {
  const cost = (n) => {
    const runs = [];
    for (let i = 0; i < samples; i++) {
      const t0 = process.hrtime.bigint();
      burn(n, `calibrate-${i}`);
      runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    runs.sort((a, b) => a - b);
    return runs[Math.floor(runs.length / 2)]; // median, to shrug off scheduler noise
  };

  burn(2000, 'warmup');
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (cost(mid) < targetMs) lo = mid; else hi = mid;
  }
  return lo;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = Number(process.argv[2] || 1.4);
  const n = iterationsFor(target);
  console.log(JSON.stringify({ targetMs: target, iterations: n }));
}
```

- [x] **Step 2: Run it inside a task on the real CPU**

```bash
CL=$(terraform -chdir=terraform output -raw cluster_name)
TASK=$(aws ecs list-tasks --cluster "$CL" --query 'taskArns[0]' --output text)
aws ecs execute-command --cluster "$CL" --task "$TASK" --container app --interactive \
  --command "node scripts/calibrate.js 1.4"
```

If `execute-command` is not enabled on the service, the cheaper alternative is a one-off local run inside the same image with a CPU quota matching Fargate's slice:

```bash
docker run --rm --cpus 0.25 ecs-dynamodb-rps-ceiling:local node scripts/calibrate.js 1.4
```

`--cpus 0.25` is what makes this representative; without it the number is a laptop's, not a task's.

- [x] **Step 3: Record the result in `dev.tfvars`**

```hcl
# Calibrated on a 0.25 vCPU slice for ~1.4ms per report request (Task 17).
# Re-calibrate if task_cpu changes — this number is CPU-specific.
pbkdf2_iterations = <the number from step 2>
```

- [x] **Step 4: Commit**

```bash
git add ecs-dynamodb-rps-ceiling/scripts/calibrate.js ecs-dynamodb-rps-ceiling/terraform/dev.tfvars
git commit -m "test(ecs-dynamodb-rps-ceiling): calibrate the cpu knob against a 0.25 vcpu slice"
```

---

## Phase 5 — Measure

> **HISTORY, not instructions.** These tasks were re-homed on 2026-09-01 to
> `docs/superpowers/plans/2026-09-02-ecs-dynamodb-rps-ceiling-scale-and-measure.md`, which applies
> their amendment banners inline. Execute that plan, not this section.

### Task 18: APPROVAL GATE — real capacity, then the discovery run

**Files:** none changed (results are recorded in Task 22).

**This task changes billable capacity from 25/25 to 1025/200 and STOPS for approval.** At the fetched `eu-central-1` rates that is **$0.3212/hour** — about 96¢ for a three-hour session, and $234/month if the environment is forgotten.

- [ ] **Step 1: Plan and review**

```bash
terraform -chdir=terraform plan -var-file=dev.tfvars
```

Expected changes: DynamoDB `read_capacity` 25 → 1025, `write_capacity` 25 → 200, and the task definition's `PBKDF2_ITERATIONS`. Capacity changes are in-place — if the plan proposes to *replace* the table, stop: the seeded data would be lost.

> **AMENDED 2026-08-31 by the SLI-collection plan. This step no longer works as written — the
> capacity raise is now pinned shut in TWO places and both must be released.**
>
> ```bash
> # 1. delete these two lines from terraform/dev.tfvars
> read_capacity  = 25
> write_capacity = 25
>
> # 2. delete the matching HCP WORKSPACE variables, or they silently win anyway
> #    (workspace vars outrank both dev.tfvars and capacity.auto.tfvars in a remote run)
> #    Terraform-category vars named read_capacity and write_capacity, workspace ws-pPiZ7mfesjrzZ8sx
> ```
>
> Miss the second and the plan comes back `No changes` on the table while you wonder why. Do **not**
> edit `capacity.auto.tfvars` — it is generated and byte-checked by `npm run slo:check`.
>
> **`PBKDF2_ITERATIONS` is no longer part of this step.** It was re-derived to **2662** and applied
> on 2026-08-31, so the task definition already carries it. Expect the plan to show the DynamoDB
> table only.
>
> Note also that the workspace now runs in **remote execution** — the plan runs in HCP and reads
> credentials from workspace variables, not your shell.

- [ ] **Step 2: STOP — get explicit approval, then run `/env up ecs-dynamodb-rps-ceiling`**

- [ ] **Step 3: Redeploy so the new iteration count takes effect**

> **AMENDED 2026-08-31.** The iteration count is already live, so this redeploy is a no-op for that
> purpose. Keep the step anyway: it is also how a **new container image** reaches the service.
> Terraform does not rebuild the image — any change under `src/` needs an explicit
> build / push / `--force-new-deployment` cycle (see the SLI plan's Task 11 Step 7). If you have not
> changed `src/`, this step is harmless and fast.

```bash
CL=$(terraform -chdir=terraform output -raw cluster_name)
SV=$(terraform -chdir=terraform output -raw service_name)
aws ecs update-service --cluster "$CL" --service "$SV" --force-new-deployment >/dev/null
aws ecs wait services-stable --cluster "$CL" --services "$SV"
```

- [ ] **Step 4: MANDATORY — drain for 6 minutes before the run**

```bash
echo "idling to refill the DynamoDB burst bucket; started $(date -u +%H:%M:%S)"
```

Wait a full six minutes with no traffic. DynamoDB banks unused capacity for ~300 s, so a run starting from a partially-drained bucket is not comparable to one starting full. **Every run in this plan starts from a full bucket after a fixed 6-minute idle.** A run performed without this is not comparable and must not be recorded.

- [ ] **Step 5: Run shape A**

```bash
/loadtest ecs-dynamodb-rps-ceiling discovery
```

- [ ] **Step 6: Compute the knee**

The run aborts when `slo_met` drops below 0.99. Read the elapsed time at abort and apply the ramp function:

```
knee_rps = START_RATE + (MAX_RATE - START_RATE) x (elapsed_seconds / RAMP_SECONDS)
         = 50 + 1950 x (elapsed / 900)
```

If the run completes without aborting, the ceiling is above `MAX_RATE` — raise `MAX_RATE` and re-run rather than reporting 2000 as the answer.

- [ ] **Step 7: Attribute the ceiling — this is the actual deliverable**

> **⚠ BLOCKED 2026-08-31. Use the four-row table in §5 of
> `docs/superpowers/specs/2026-08-31-ecs-dynamodb-rps-ceiling-attribution-via-metrics-design.md`, not the one below.**
> That document also deletes the `Server-Timing` header and `/stats`, so `db_ms`, `cpu_ms` and
> `el_delay` no longer exist in the k6 summary at all — the numbers this step reads come from
> Grafana. It must land **before Task 18 runs**: once baselines B and C exist the k6 scripts are
> frozen, and changing them afterwards invalidates every recorded row.
>
> **Addendum 2026-09-01.** The four-row table this banner points to was itself deleted; nothing
> derives a bound resource any more. See
> `docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-attribution-simplified-design.md`.

> **Corrected 2026-08-29. The original table here could not work, and read literally it would
> have attributed a service ceiling to the database — the exact inversion this project exists to
> avoid.** It relied on `db_ms` staying flat while the service saturated. It cannot:
> `timer.measure('db', …)` is wall-clock around an `await`, so the `finally` cannot run while
> another request's `pbkdf2Sync` blocks the event loop. Measured against the committed code with
> the database held constant, `db;dur` went **10.884 ms → 131.945 ms, a 12.1× inflation**. Under
> CPU saturation `db_ms` climbs hard with DynamoDB perfectly healthy, so the row "`db_ms` flat"
> never occurs and both original rows appear to match at once.

**`ThrottledRequests` is the discriminator.** It is the only signal here that cannot be
contaminated by the Node event loop — it is measured inside DynamoDB.

> **AMENDED 2026-08-31: the discriminator is unchanged, but you no longer need the CloudWatch CLI
> to read it.** The Alloy collector scrapes CloudWatch by `Project` tag and forwards to Grafana
> Cloud, so all three signals in the table below are queryable from one datasource alongside the
> service-side histogram:
>
> ```
> aws_dynamodb_throttled_requests_sum          aws_dynamodb_successful_request_latency_average
> aws_dynamodb_consumed_read_capacity_units_sum   aws_applicationelb_target_response_time_p95
> ```
>
> Verified working for DynamoDB, ALB **and** ECS discovery on this account.
>
> Event-loop delay is also now emitted directly as `nodejs_eventloop_delay_*` by
> `instrumentation-runtime-node`, in addition to the `/stats` poll the k6 scripts read. Prefer the
> OTel series for attribution: `/stats` resets on read, so two consumers race for the same window.

| `ThrottledRequests` | `SuccessfulRequestLatency` | `el_delay_p99_ms` (windowed) | bound resource |
|---|---|---|---|
| **zero** | flat | **climbing** | **service** — the DB is keeping up; the queue is in Node |
| **rising** | **climbing** | flat or mildly up | **database** |
| rising | climbing | climbing | both — the two ceilings are too close to separate; re-check the CPU calibration |
| zero | flat | flat | neither yet — the knee is elsewhere (ALB, generator, network). Do not report a ceiling. |

**`db_ms` is still worth recording, but never on its own.** Its value is the *gap*:

```
queueing_delay ≈ db_ms − SuccessfulRequestLatency
```

`SuccessfulRequestLatency` is measured server-side by DynamoDB and carries no event-loop
contamination; `db_ms` is measured by the service and carries all of it. **A widening gap with
`ThrottledRequests` at zero is the strongest positive evidence of a service-bound ceiling** —
stronger than event-loop lag alone, because it is a difference between two independent clocks
rather than one absolute number.

Note `el_delay_p99_ms` is only meaningful because `/stats` was changed to report a **windowed**
histogram. The original reported a since-boot value that was monotonic — it could never fall, so
"climbing" was not a distinguishable state and a prior stress run would poison every later run on
the same task.

```bash
WINDOW_START="$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ)"   # GNU date: -d '30 minutes ago'
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# The discriminator. Sum over 60s buckets; anything above zero means the DB is the constraint.
aws cloudwatch get-metric-statistics --namespace AWS/DynamoDB \
  --metric-name ThrottledRequests --dimensions Name=TableName,Value=ecs-dynamodb-rps-ceiling \
  --start-time "$WINDOW_START" --end-time "$NOW" --period 60 --statistics Sum --output table

# Server-side DB latency, uncontaminated by the Node event loop. Compare against db_ms.
for OP in GetItem PutItem Query; do
  echo "== $OP =="
  aws cloudwatch get-metric-statistics --namespace AWS/DynamoDB \
    --metric-name SuccessfulRequestLatency \
    --dimensions Name=TableName,Value=ecs-dynamodb-rps-ceiling Name=Operation,Value=$OP \
    --start-time "$WINDOW_START" --end-time "$NOW" --period 60 \
    --statistics Average Maximum --output table
done

# Which side throttled, when both paths are in play (report does Query + PutItem).
aws cloudwatch get-metric-statistics --namespace AWS/DynamoDB \
  --metric-name ReadThrottleEvents --dimensions Name=TableName,Value=ecs-dynamodb-rps-ceiling \
  --start-time "$WINDOW_START" --end-time "$NOW" --period 60 --statistics Sum --output table
aws cloudwatch get-metric-statistics --namespace AWS/DynamoDB \
  --metric-name WriteThrottleEvents --dimensions Name=TableName,Value=ecs-dynamodb-rps-ceiling \
  --start-time "$WINDOW_START" --end-time "$NOW" --period 60 --statistics Sum --output table
```

All four metrics are free with basic CloudWatch and need no Grafana datasource — read them
directly here. **Throttling presents as latency before it presents as errors** (spec §10): the
SDK retries `ProvisionedThroughputExceededException` with backoff, and those retries sit *inside*
`db_ms`. So a latency breach must always be checked against `ThrottledRequests` before it is
attributed to the service.

- [ ] **Step 8: FREEZE the scripts**

From here the three k6 files do not change. Any later edit invalidates every comparison; if one is genuinely wrong, that is a separate `test(...)` commit which explicitly voids the prior rows.

```bash
git commit --allow-empty -m "test(ecs-dynamodb-rps-ceiling/k6): freeze load profiles after discovery run"
```

---

### Task 19: Baseline runs B and C

> **AMENDED 2026-08-31.** Every run from here on records **two** attainment figures, not one:
>
> | column | where it comes from |
> |---|---|
> | `k6 attainment` | the run's `slo_met` rate — the **gate**, client-side, includes Frankfurt RTT and ALB queueing |
> | `service attainment` | the Grafana SLO query over the run's own window — the **SLO**, server-side only |
>
> Expect the k6 number to be the lower of the two. If it is *higher*, one of them is wrong.
>
> **Query the service figure through the Grafana datasource proxy** — `K6_PROMETHEUS_RW_*` is
> write-scoped and returns `invalid scope requested`, which a naive parser reads as "no data":
>
> ```bash
> PROXY="$GRAFANA_URL/api/datasources/proxy/uid/grafanacloud-prom/api/v1"
> curl -s -H "Authorization: Bearer $GRAFANA_AUTH" --data-urlencode "query=<class-ratio>" "$PROXY/query"
> ```
>
> **k6 traffic will label itself.** `traffic_source` is derived from the User-Agent in
> `src/otel.js`, and k6 sends `k6/x.y.z`, so runs appear as `traffic_source="k6"` while the
> heartbeat stays `heartbeat`. That is the evidence spec §17.1 needs — whether load-generator
> traffic belongs in the SLO population — and it is now decidable, because the split exists from
> before the first run.
>
> **The heartbeat keeps running during load tests.** At 4 req/min against thousands it is
> statistically irrelevant, but it is not zero: exclude it with `traffic_source="k6"` if a run's
> population needs to be exactly the generated load.

**Files:** none changed.

- [ ] **Step 1: Drain 6 minutes, then run shape B at the knee**

```bash
/loadtest ecs-dynamodb-rps-ceiling constant
```

with `RATE=<knee>`. Expected: all thresholds satisfied (k6 exit `0`). If B breaches at the knee, the knee was read too high — recompute from the abort time rather than adjusting the threshold.

- [ ] **Step 2: Drain 6 minutes, then run shape C**

```bash
/loadtest ecs-dynamodb-rps-ceiling stress
```

with `RATE=<knee>`. Expected: thresholds breached (k6 exit `99`). **A stress run that passes is a failed experiment** — the multiplier is too low; raise `MULTIPLIER` and note that C's definition changed before any comparison is drawn.

- [ ] **Step 3: Record both rows** via `/loadtest`, with `infra change` = "baseline: 1 task, no autoscaling, 1025/200".

---

## Phase 6 — Improve and re-measure

> **HISTORY, not instructions.** These tasks were re-homed on 2026-09-01 to
> `docs/superpowers/plans/2026-09-02-ecs-dynamodb-rps-ceiling-scale-and-measure.md`, which applies
> their amendment banners inline. Execute that plan, not this section.

### Task 20: APPROVAL GATE — enable autoscaling, then re-run B and C

**Files:**
- Modify: `ecs-dynamodb-rps-ceiling/terraform/dev.tfvars`

**One change only.** If Task 18 attributed the ceiling to the *database* rather than the service, autoscaling tasks will change nothing — skip to Task 21, raise capacity instead, and record why the order was swapped. That is a result, not a deviation.

> **AMENDED 2026-08-31 — this is the task the `instance` label fix exists for.** Scaling 1→4 is the
> first time more than one task serves the SLI, and until 2026-08-31 **every task reported
> `instance="local-1"`**: the AWS resource detector supplies no `service.instance.id` on Fargate, so
> the fallback `local-${process.pid}` applied, and the app is PID 1 in every container. Four tasks
> would have collapsed onto one series and the ratio behind this comparison would have been
> silently wrong — in the one task whose entire purpose is a before/after comparison.
>
> It now reads the task id from `ECS_CONTAINER_METADATA_URI_V4`, verified with two distinct
> `instance` values under `desired-count 2`. Nothing to do here; recorded because a reader who
> hits a corrupt-looking 4-task ratio should know this was already found and fixed.
>
> Series growth is not a concern: roughly 10–20 active series per task against a 10,000 free-tier
> ceiling.

- [ ] **Step 1: Flip the flag**

```hcl
autoscaling_enabled = true
```

- [ ] **Step 2: Plan and review**

```bash
terraform -chdir=terraform plan -var-file=dev.tfvars
```

Expected: exactly two resources added (`aws_appautoscaling_target.ecs[0]`, `aws_appautoscaling_policy.cpu[0]`) and nothing else changed. If anything else appears, more than one thing is changing and the comparison would be worthless.

- [ ] **Step 3: STOP — approval, then `/env up ecs-dynamodb-rps-ceiling`**

- [ ] **Step 4: Drain 6 minutes; re-run B and C byte-identical**

```bash
/loadtest ecs-dynamodb-rps-ceiling constant --compare
/loadtest ecs-dynamodb-rps-ceiling stress --compare
```

Same `RATE`, same scripts, same load zone. `--compare` refuses if the profile or the script changed — that refusal is the guard working, not an error to route around.

- [ ] **Step 5: Attribute again**

Autoscaling should move the service ceiling to roughly 4× its baseline. Re-run the Task 18 step-7 table. The expected outcome is that the bound resource has now moved to the **database** — which is what Task 21 exists for.

- [ ] **Step 6: Commit**

```bash
git add ecs-dynamodb-rps-ceiling/terraform/dev.tfvars
git commit -m "perf(ecs-dynamodb-rps-ceiling/terraform): enable ecs autoscaling 1->4 on cpu target"
```

The commit body carries the before/after numbers — per `CLAUDE.md`, `git log --grep '^perf'` is the history of what actually moved the needle.

---

### Task 21: APPROVAL GATE — raise capacity if the database now binds

**Files:**
- Modify: `ecs-dynamodb-rps-ceiling/slo.yaml`
- Regenerate: `terraform/capacity.auto.tfvars`

**Skip this task entirely if Task 20 left the service still bound.** Raising capacity that is not the constraint spends money and proves nothing.

- [ ] **Step 1: Raise `target_rps` in `slo.yaml`** to the new service ceiling measured in Task 20, then regenerate:

```bash
/slo ecs-dynamodb-rps-ceiling
```

Capacity comes from the model, never from a hand-edited number. Read the new `$/hour` off `capacity-model.html` before approving — this is the point where the cost of the improved SLO becomes a real figure.

- [ ] **Step 2: Plan, review, STOP for approval, then `/env up ecs-dynamodb-rps-ceiling`**

Confirm the plan is an in-place capacity change, not a table replacement.

- [ ] **Step 3: Drain 6 minutes; re-run B and C**

```bash
/loadtest ecs-dynamodb-rps-ceiling constant --compare
/loadtest ecs-dynamodb-rps-ceiling stress --compare
```

- [ ] **Step 4: Commit**

```bash
git add ecs-dynamodb-rps-ceiling/slo.yaml ecs-dynamodb-rps-ceiling/terraform/capacity.auto.tfvars
git commit -m "perf(ecs-dynamodb-rps-ceiling): raise provisioned capacity to release the db ceiling"
```

---

## Phase 7 — Record and tear down

> **HISTORY, not instructions.** These tasks were re-homed on 2026-09-01 to
> `docs/superpowers/plans/2026-09-02-ecs-dynamodb-rps-ceiling-scale-and-measure.md`, which applies
> their amendment banners inline. Execute that plan, not this section.

### Task 22: Write up the results

**Files:**
- Create: `ecs-dynamodb-rps-ceiling/README.md`
- Modify: `ecs-dynamodb-rps-ceiling/results.md`
- Modify: `README.md` (repo root)

**Every number in these files must come from a run in this session**, quoted with the k6 output or CloudWatch query that produced it. No remembered figures, no extrapolation — this is `CLAUDE.md`'s verification rule applied literally.

- [ ] **Step 1: Write `ecs-dynamodb-rps-ceiling/README.md`**

> **⚠ SUPERSEDED 2026-08-31 by §8 of
> `docs/superpowers/specs/2026-08-31-ecs-dynamodb-rps-ceiling-attribution-via-metrics-design.md`.**
> A rewrite, not an amendment: the README is reorganised around the question a reader arrives
> with, answered by generated Grafana deep-links, with the CLI runbook demoted to an appendix.
> Do not execute the paragraph below — build §8's structure instead.

Sections, in this order: what it provisions and the hourly cost; how to run it (`/env up`, push, seed, `/loadtest`); the endpoint catalogue and the frozen 55/15/25/5 mix; the SLO and why it is a ratio rather than a percentile; **the measured results** — the knee, the bound resource and its evidence, and the two before/after pairs; the mandatory 6-minute drain and why; and the capacity/cost model with a link to `capacity-model.html`.

- [ ] **Step 2: Check every results row is complete**

```bash
grep -c '^|' ecs-dynamodb-rps-ceiling/results.md
awk -F'|' 'NR>2 && NF>3 && ($4 ~ /^ *$/ || $6 ~ /^ *$/ || $8 ~ /^ *$/ || $9 ~ /^ *$/) \
  { print "INCOMPLETE ROW:", $0 }' ecs-dynamodb-rps-ceiling/results.md
```

A row with a blank `infra change` or a blank `bound resource` is not a result. Fill it or delete it.

> **UPDATED 2026-08-31 by the SLI-collection plan.** The schema gained a second attainment column
> (`k6 attainment` and `service attainment`; see `.claude/skills/loadtest/SKILL.md`).
>
> That plan expected the column positions to shift and this check to break. **They did not.** The new
> column is inserted at position 7, and this check reads `$4` (`infra change`) and `$6`
> (`bound resource`), so both still resolve correctly — verified by running the header through `awk`
> rather than by counting pipes in a text editor.
>
> The check is extended anyway, to `$8` (`k6 attainment`) and `$9` (`service attainment`). Those two
> columns are the entire reason the schema changed, and a row carrying only one of them is exactly
> the ambiguity the split exists to remove.

- [ ] **Step 3: Update the repo README project table**

Replace the `ecs-dynamodb-rps-ceiling` row's status with the headline figure — the knee, at the mix, with the bound resource — and confirm `ecs-document-db` still reads "not built yet".

- [ ] **Step 4: Commit**

```bash
git add ecs-dynamodb-rps-ceiling/README.md ecs-dynamodb-rps-ceiling/results.md README.md
git commit -m "docs(ecs-dynamodb-rps-ceiling): record measured capacity and before/after results"
```

---

### Task 23: APPROVAL GATE — tear down and sweep

**Files:** none changed.

**This deletes data and infrastructure and STOPS for approval.** Do not run it until Task 22 is committed — the measurements are the deliverable and the environment is not.

- [ ] **Step 1: Confirm the results are committed**

```bash
git status --short
git log --oneline -1
```

- [ ] **Step 2: STOP — approval, then `/env down ecs-dynamodb-rps-ceiling`**

- [ ] **Step 3: Sweep, because a clean teardown is not evidence of a clean account**

`/env down` runs the sweep. The tag query is the primary check:

```bash
aws resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=ecs-dynamodb-rps-ceiling \
  --query 'ResourceTagMappingList[].ResourceARN' --output table
```

Then the known survivors, which AWS often creates untagged: NAT gateways (there should be none by design — one appearing means the design was broken somewhere), unattached EIPs, log groups, and ECR repositories.

> **AMENDED 2026-08-31 — the SLI-collection plan added resources this sweep does not mention, and
> one of them can make `destroy` itself fail.**
>
> - **Cloud Map** (`aws_service_discovery_private_dns_namespace.internal`, `..._service.collector`).
>   A namespace **refuses deletion while a service is still registered**, which surfaces as a
>   `destroy` error rather than a silent survivor. If `destroy` fails here, let it finish removing
>   the ECS service first and re-run; do not delete the namespace by hand while Terraform still
>   tracks it.
> - **The collector**: ECS service, task definition, security group, IAM role + inline policy, and
>   log group `/ecs/ecs-dynamodb-rps-ceiling-collector`.
> - **The heartbeat**: Lambda `ecs-dynamodb-rps-ceiling-heartbeat`, its EventBridge **Scheduler**
>   schedule (not an EventBridge *rule* — check `aws scheduler list-schedules`, it does not appear
>   under `aws events`), two IAM roles, and log group `/aws/lambda/ecs-dynamodb-rps-ceiling-heartbeat`.
>   **The schedule keeps firing until it is deleted**, so a half-torn-down environment goes on
>   generating traffic and Lambda invocations.
> - **Grafana Cloud is not in the AWS tag sweep at all.** `terraform destroy` removes the folder,
>   dashboard, four rule groups and `grafana_slo`, but nothing in `resourcegroupstaggingapi` would
>   ever have told you if it had not. Confirm separately:
>   `curl -H "Authorization: Bearer $GRAFANA_AUTH" "$GRAFANA_URL/api/prometheus/grafana/api/v1/rules"`
>   should list no `latency-classes` rules afterwards.
>
> Metrics already shipped to Grafana Cloud are **not** deleted by teardown and age out on the
> 14-day free-tier retention. That is fine, and worth knowing before someone hunts for a leak.

- [ ] **Step 4: Report the sweep output**

List anything found with the reason it costs money. **Do not delete anything the sweep finds without asking** — a survivor may belong to another project in this account.

---

## Self-review

Run against the spec, `2026-08-29-ecs-dynamodb-rps-ceiling-design.md`.

**Spec coverage.** §1 success criteria → Tasks 18 (knee + attribution), 19–21 (before/after), 21 (cost per SLO level), 23 (clean teardown). §2 D1–D10 → D1/D6 Task 10, D2 Task 18, D3 Task 16, D4 Tasks 6/15, D5 Tasks 13–14, D7 Task 15, D8 Task 7, D9 Tasks 2/17, D10 Tasks 3/4/15. §4 infrastructure → Tasks 9–10. §5 service, budget, endpoints, instrumentation, seed → Tasks 1–8, 17. §6 capacity model → Task 14 (generated), `pricing.json` and `capacity-model.html` already committed. §7 SLO → Tasks 13–14. §8 profiles and protocol → Tasks 15–16, drain in 18/19/20/21. §9 improvement → Tasks 20–21. §10 hazards → burst drain (18 step 4), throttle-before-error (18 step 7), event-loop blocking (Task 2 rationale), frozen mix (Task 15 step 2 check), TTL (Task 10), VU-hours (Task 16 abort design), public subnets (Task 9). §11 open parameters → each resolved: budget Task 14, capacity Task 14, task size Task 17, iterations Task 17, ramp Task 18, multiplier Task 19, drain Task 18, load zone Task 16 step 5, `.env` Task 11 step 1. §13 sequencing → Tasks 9–23 in order.

**Placeholder scan.** No TBD/TODO. Two values are deliberately deferred with a defined resolution method rather than guessed: `pbkdf2_iterations` (measured in Task 17 on the target CPU — a laptop number would be wrong) and `RATE` for shapes B and C (the discovered knee; both scripts `throw` rather than default, so a guess cannot silently become a result). One genuine unknown is flagged as a verification step rather than assumed: whether `k6 cloud run` supports `--summary-export` (Task 16 step 5, with both branches documented).

**Type consistency.** `loadConfig` fields flow unchanged into `createRepo`/`createHandlers`. `buildItem`/`itemSizeBytes`/`randomId` are used identically in `handlers.js`, `seed.js` and the tests. `createTimer`'s `measure`/`measureSync`/`header` match every call site. `CLASS_THRESHOLD_MS` keys (`fast`/`standard`/`heavy`) match `CLASS_OF`'s values in `request.js`, the class names in `slo.yaml`, and the tag values in the generated thresholds. Route names in `matchRoute` match the handler keys exactly. Terraform variable names in `variables.tf` match `dev.tfvars`, `capacity.auto.tfvars`, and every `var.` reference.

**One gap accepted deliberately:** `grafana/dashboard.json` is listed in the file structure but has no task. Dashboards are diagnostic, not the SLI source (D7), and every attribution signal this plan depends on is available from k6 output and ad-hoc CloudWatch queries. Add it as follow-up work if the panels prove necessary during Task 18.
