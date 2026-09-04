# ecs-dynamodb-rps-ceiling Attribution-via-Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every measurement signal off the service's HTTP surface and into the OpenTelemetry pipeline, and replace the attribution model that the 2026-08-29 plan already flags as unreachable.

**Architecture:** `Server-Timing` and `GET /stats` are deleted. The phase timings they carried become two exponential histograms — `http.server.db.duration` and `http.server.cpu.duration` — sharing the existing view, attributes and collector rules. Event-loop lag and memory are *not* rebuilt: `RuntimeNodeInstrumentation` already emits them. Attribution becomes a four-row table driven by `ThrottledRequests`, DynamoDB's own `SuccessfulRequestLatency`, the **gap** between that and in-process `db` (which is the queueing measurement), and `rate(cpu_sum)` against the 0.25 vCPU allocation.

**Tech Stack:** Node.js 22 (`node:http`, `node:test`), `@opentelemetry/sdk-metrics` v2, Grafana Alloy on ECS Fargate, Terraform ~1.14 with HCP Terraform (remote execution), Grafana Cloud (Mimir native histograms), k6 1.4 as a run gate only.

**Spec:** `docs/superpowers/specs/2026-08-31-ecs-dynamodb-rps-ceiling-attribution-via-metrics-design.md`

**Amends:** `docs/superpowers/plans/2026-08-29-ecs-dynamodb-rps-ceiling.md`. Its Tasks 18–23 stay on hold and **are not renumbered**; this plan numbers its own tasks from 1 and uses its own SDD ledger directory. **Task 22 Step 1 of that plan is superseded** by Task 12 here. Task 18 of that plan resumes after Task 13 of this one.

---

## Status — **complete**, 2026-08-31

> Project renamed to `ecs-dynamodb-rps` on 2026-09-03; paths and names below are pre-rename. See `docs/superpowers/specs/2026-09-02-ecs-dynamodb-rps-restructure-design.md`.

All 16 tasks executed (15 planned, plus **Task 10b** added during execution — see below). Deployed
and verified against the live environment in `eu-central-1`, account `042945885621`.

**The goal is met and observable.** No measurement leaves the service over HTTP; the SLI and all four
attribution discriminators are computed from service-emitted metrics and visible in Grafana. Verified
after the apply, with no load test running:

```
sli_ratio             1                     (the same query returned NaN before Task 10b)
cpu_saturation_ratio  0.000229              (0.023% of the 0.25 vCPU ceiling, idle)
db_wall_avg_by_route  4 series, 5.081 ms
alert rules           4/4 health=ok, state=inactive
```

| | |
|---|---|
| Service emits | `http.server.request.duration`, `http.server.db.duration`, `http.server.cpu.duration` — three native exponential histograms, one shared attribute set |
| Deleted | `Server-Timing` header, `GET /stats`, `src/stats.js`, `AwsInstrumentation`, four k6 trends and the k6 `stats` scenario |
| Reused, not rebuilt | `nodejs_eventloop_delay_*`, `v8js_memory_heap_used_bytes` — already flowing since the collector shipped |
| Collector | **unchanged** — the OTTL rules key on `http.route` with no metric-name condition, so both new histograms classified for free |
| Generated | `grafana/queries.json`, a sixth output of `scripts/generate-slo.js`, feeding dashboard panels, `/loadtest` and the README from one definition |
| Dashboard | panels 18–24 added; the five CloudWatch rows survive with **zero deleted lines** |
| Tests | 82 unit, 9 integration (the integration suite genuinely ran for the first time — see below) |
| Cost | unchanged, ~$0.055/hour idle. No AWS resource added, changed or destroyed |

### Task completion record

All 16 tasks executed and every step checked off. **The work landed on `master` as a single squashed
commit, `b6234a3`.** The per-task commits below exist on branch `worktree-attribution-via-metrics`
(retained at `.claude/worktrees/attribution-via-metrics`); a squash merge does not carry them into
`master`'s history, so treat them as a record of how the work was done, not as reachable refs once
that branch is deleted.

| task | outcome | commit(s) on the branch |
|---|---|---|
| 1 — pre-change CPU baseline | measurement only, no commit. cpu median **1.4985 ms**, n=10 | — |
| 2 — db + cpu phase histograms | reviewed PASS 7/7 | `f16ec60` |
| 3 — timer exposes `phases()` in seconds | batched with 4 and 5 | `7b74631` |
| 4 — delete `Server-Timing` and the `app` phase | reviewed PASS 6/6 | `85fc7eb` |
| 5 — delete `GET /stats` | " | `d5db482` |
| 6 — `AwsInstrumentation` verdict | branch 2 fired literally; controller ruling **R-1** overrode it and removed the package | `7f56917` |
| 7 — `attribution:` block and `queries.json` | one fix round (native-histogram + gauge shapes), then PASS 7/7 | `415c5e2`, `3084137`, `9dfc57b` |
| 8 — dashboard SLI and attribution panels | reviewed PASS 7/7 | `41e3318` |
| 9 — k6 becomes a pure gate | controller-verified (ruling **R-5**) | `b06a48d` |
| 10 — **APPROVAL GATE**, rebuild and deploy | approved and executed; artifact verified, not just the source tree | — |
| 10b — SLI aggregation order | **added during execution**; controller-verified (ruling **R-6**) | `1e13dc5` |
| 11 — **APPROVAL GATE**, apply the Grafana module | approved; applied twice (once after the final fix round). `grafana_slo` id preserved both times | — |
| 12 — `pbkdf2_iterations` verdict | **unchanged at 2662**, on evidence, not on noise | — |
| 13 — `/loadtest` reads Grafana | verified live | `6244d24` |
| 14 — README rewritten by reader's question | 20/20 links HTTP 200 | `a9d1b75` |
| 15 — close out the documents | controller-written; its sweep caught a live defect this plan shipped | `547d184` |
| final review fix round | 10 findings, 2 blocking; re-review **APPROVED** | `0b90df5`, `76d71de`, `8cefefe` |

Plan-text corrections made during execution are their own commits: `6f000a1`, `d7d3a11`, `ea50c61`,
`57f57ac`, `71c9aa5`, `596a8a5`.

### Task 10b, added during execution

Task 10's deploy exposed a defect that **predates this plan**: `ratioExpr` applied
`histogram_fraction` per series and summed afterwards, so any series with zero observations in the
window contributed 0/0 = `NaN` and poisoned the whole SLI. It had worked only because the service ran
as a single instance with steady heartbeat traffic — the one regime where no series is ever empty.
It would have broken permanently at **Task 20 of the 2026-08-29 plan**, which scales 1 → 4 tasks.
Fixed by aggregating before taking the fraction. `grafana_slo` and all four rule groups now carry the
corrected query; the SLO's recorded history was preserved (in-place update, id unchanged).

### What this plan got wrong, corrected in place

Listed because a reader who lands on the original text will otherwise reintroduce a fixed defect.

| # | where | what was wrong |
|---|---|---|
| 1 | Tasks 4, 5 | every integration command would have **skipped**, not run: the suite is wrapped in `describe(…, { skip: !process.env.DYNAMO_ENDPOINT })` and `npm run test:integration` does not set it. `node --test` exits 0 on a skip |
| 2 | Tasks 4, 5 | both edit `integration.test.js`, Task 4 by a line range that shifts the offset Task 5 quotes |
| 3 | Tasks 1, 6, 10, 12 | ended with `git add .superpowers/ && git commit`; that directory is git-ignored by design, so the add stages nothing and the commit fails |
| 4 | Task 3 | leaves `npm test` **red** — it deletes `header()` while `server.js` still calls it. Task 3 is not independently green, and Task 4's prescribed red step *hangs* rather than failing (double throw inside `send`'s catch, `res.end()` never reached) |
| 5 | Task 7 | queried native histograms with the classic `_sum`/`_count` companion series, **which do not exist** — success with no data, forever |
| 6 | Task 7 | wrapped a non-monotonic CloudWatch per-period gauge in `rate()` |
| 7 | Task 9 | `k6 inspect`'s `jq` path was `.options.scenarios`; scenarios are top level, so the check returned `null has no keys` and verified nothing |
| 8 | Task 10b | the regression regex I wrote matched **both** the broken and fixed forms (`[^)]*` does not exclude `(`), so it could never fail |
| 9 | Task 12 | read the cpu phase via `_sum`/`_count` again — third instance of defect 5 |
| 10 | Task 13 | said to extend an existing `awk` check in `SKILL.md`; there was none — the remembered one lives in the 2026-08-29 plan, for a different file |
| 11 | Task 14 | discovered the dashboard uid from `/api/search`'s first hit, which is the **folder**; every generated deep-link would have 404'd |
| 12 | Task 11 | omitted that a worktree has no `.terraform/` (git-ignored) and that HCP credentials come from the root `.env`, which direnv does not load non-interactively |

**Five of these — 1, 4, 7, 8, and arguably 11 — are the same defect: a verification step that cannot
fail.** Each was written from memory and never executed once at authoring time. That is the single
most valuable correction to make to how plans in this repo are written: **any command a plan asks an
executor to run, especially one that talks to a live API, should be executed once while the plan is
being written.** Cheap then; three fix rounds and a near-miss on a shipped-broken dashboard otherwise.

### The `pbkdf2_iterations` verdict

**Unchanged at 2662.** Not "within noise" — the numbers moved (baseline 1.5522 ms mean, post-change
1.6733 ms idle, 2.3363 ms under a burst). The reason is that the measured span *cannot contain* the
instrumentation: `handlers.js:64` wraps `burn()` alone, and `recordRequest` runs in `res.on('finish')`
after the response, outside every span. `burn()` is byte-identical across this change.

An incidental finding for Task 18: **the `cpu` phase is load-dependent.** Burst figures run ~40%
above idle ones, in the wrong direction for a warming effect — at 0.25 vCPU the container hits its
CPU quota, so identical `pbkdf2` work takes longer wall-clock. It measures wall-clock, not CPU-time.
Expect it; it is the mechanism that makes the service bind, not instrumentation drift.

### Hand back

The **2026-08-29 plan's Tasks 18–23 are unblocked.** See its status header.

---

## Global Constraints

Copied from the spec and `CLAUDE.md`. Every task's requirements implicitly include this section.

- **Project name is fixed:** `ecs-dynamodb-rps-ceiling` — directory name, AWS `Project` tag value, commit scope.
- **`terraform apply` / `destroy` are approval gates.** Each gets its own task that STOPS. Never `-auto-approve` — the `PreToolUse` hook blocks it outright.
- **Terraform does not rebuild the container image.** Any `src/` change needs an explicit build → push → `--force-new-deployment` cycle. Omitting it leaves the collector receiving nothing from a service healthy by every other indicator.
- **Do not raise DynamoDB capacity.** It stays 25/25 here. Raising it is Task 18 of the *old* plan.
- **Generated files are never hand-edited.** `k6/lib/slo.js`, `terraform/capacity.auto.tfvars`, `grafana/classmap.json`, `grafana/alerts.tf`, `grafana/locals.tf` and (new) `grafana/queries.json` are rendered by `scripts/generate-slo.js`. Change `slo.yaml` or the generator, then `npm run slo:generate`. `npm run slo:check` must exit 0 before every commit.
- **`pbkdf2_iterations` stays at 2662** unless Task 10 shows otherwise (spec A10).
- **Node 22, `"type": "module"`.** ESM throughout. Tests are `node:test`.
- **Commit format:** Conventional Commits, scope `ecs-dynamodb-rps-ceiling` or `ecs-dynamodb-rps-ceiling/<layer>`.
- **All commands run from `ecs-dynamodb-rps-ceiling/`** unless stated otherwise.

## File Structure

| file | responsibility | change |
|---|---|---|
| `src/otel.js` | all OTel wiring; instrument definitions | **modify** — two new histograms, `recordRequest` takes `phases` |
| `src/timing.js` | per-request phase stopwatch | **modify** — `header()` → `phases()` (seconds) |
| `src/server.js` | HTTP plumbing, one request lifecycle | **modify** — no `Server-Timing`, no `app` phase |
| `src/handlers.js` | route table + handlers | **modify** — `/stats` route and handler removed |
| `src/stats.js` | event-loop + memory snapshot | **delete** — duplicated by `RuntimeNodeInstrumentation` |
| `test/stats.test.js` | tests for the above | **delete** |
| `scripts/generate-slo.js` | one source → six generated outputs | **modify** — `SCOPE` drops `/stats`; adds `renderQueries` |
| `slo.yaml` | the single source | **modify** — adds `attribution:` |
| `grafana/queries.json` | shared query set | **create (generated)** |
| `grafana/dashboard.json` → `.tftpl` | dashboard, now templated | **rename + modify** |
| `grafana/folder.tf` | dashboard resource | **modify** — `file()` → `templatefile()` |
| `k6/lib/request.js` | k6 request + metrics | **modify** — client-observable metrics only |
| `k6/{constant,discovery,stress}.js` | load shapes | **modify** — `stats` scenario removed |
| `.claude/skills/loadtest/SKILL.md` | run + record | **modify** — query step, two columns |
| `README.md` | the runbook | **rewrite** — question-led, Grafana-first |

---

## Phase 1 — Service (local only, no AWS spend)

### Task 1: Capture the pre-change CPU baseline

**Files:** none changed. This task produces a recorded number that Task 10 compares against, and it must run **before** any `src/` edit — once `Server-Timing` is gone the baseline is unrecoverable.

**Interfaces:**
- Produces: a `cpu;dur` figure for `POST /reports` from the live service, written into the ledger.

- [x] **Step 1: Read the live CPU phase from the deployed service**

The environment is up and the heartbeat keeps it warm. Ten samples is enough — this is a CPU phase driven by a fixed iteration count, not a latency distribution.

```bash
B="$BASE_URL"   # from the root .env; never hard-code the ALB hostname in git
for i in $(seq 1 10); do
  curl -s -D- -o /dev/null -m 15 -H 'content-type: application/json' \
    -d '{"pk":"feed-07"}' "$B/reports" | grep -i '^server-timing:'
done
```

Expected: ten lines of the form `Server-Timing: db;dur=9.956, cpu;dur=1.590, app;dur=11.611`.

- [x] **Step 2: Record the median `cpu;dur` in the ledger**

Write the ten raw lines and their median into `.superpowers/sdd/2026-08-31-ecs-dynamodb-rps-ceiling-attribution-via-metrics/progress.md` under a heading `Pre-change CPU baseline`. The target is ~1.4 ms (the value `pbkdf2_iterations = 2662` was calibrated to produce).

**Do not average.** One sample landing on a GC pause or a heartbeat collision moves a mean and not a median.

- [x] **Step 3: Confirm the baseline is recorded**

**No commit.** `.superpowers/sdd/` is git-ignored by design (`.superpowers/sdd/.gitignore` is `*`), so
`git add` on it is a silent no-op and the commit would fail with nothing staged. The ledger is
scratch that survives on disk, which is all Task 12 needs. Verify the entry exists and move on:

```bash
grep -A3 'Pre-change CPU baseline' .superpowers/sdd/2026-08-31-ecs-dynamodb-rps-ceiling-attribution-via-metrics/progress.md
```

---

### Task 2: The two phase histograms

**Files:**
- Modify: `src/otel.js`
- Test: `test/otel.test.js`

**Interfaces:**
- Produces: `DB_DURATION = 'http.server.db.duration'`, `CPU_DURATION = 'http.server.cpu.duration'` (both exported); `recordRequest({ route, method, status, durationSeconds, userAgent, phases })` where `phases` is `{ db?: number, cpu?: number }` **in seconds**.
- Consumes: nothing new.

- [x] **Step 1: Write the failing test**

Append to `test/otel.test.js`. `collectOne()`, `TestReader`, `DataPointType` and `REQUEST_DURATION` already exist at the top of that file — reuse them, do not redefine. **Add `CPU_DURATION` and `DB_DURATION` to the existing `../src/otel.js` import line** rather than writing a second import statement for the same module.

```javascript
test('phase histograms record db and cpu with the request attributes', async () => {
  const { reader, provider } = await collectOne();
  recordRequest({
    route: '/reports', method: 'POST', status: 200, durationSeconds: 0.012,
    userAgent: 'k6/1.4.0', phases: { db: 0.0099, cpu: 0.0016 },
  });
  const { resourceMetrics } = await reader.collect();
  const metrics = resourceMetrics.scopeMetrics[0].metrics;
  const byName = (n) => metrics.find((m) => m.descriptor.name === n);

  for (const name of [DB_DURATION, CPU_DURATION]) {
    const m = byName(name);
    assert.ok(m, `${name} was not recorded`);
    // The view must apply to these exactly as it does to request duration,
    // or they land as explicit buckets and histogram_fraction stops working.
    assert.equal(m.dataPointType, DataPointType.EXPONENTIAL_HISTOGRAM);
    assert.equal(m.descriptor.unit, 's');
    assert.equal(m.dataPoints[0].attributes['http.route'], '/reports');
    assert.equal(m.dataPoints[0].attributes['traffic_source'], 'k6');
  }
  assert.equal(byName(DB_DURATION).dataPoints[0].value.sum, 0.0099);
  assert.equal(byName(CPU_DURATION).dataPoints[0].value.sum, 0.0016);
  await provider.shutdown();
});

test('a request with no phases records duration only, and does not throw', async () => {
  const { reader, provider } = await collectOne();
  recordRequest({ route: '/healthz', method: 'GET', status: 200, durationSeconds: 0.0004 });
  const { resourceMetrics } = await reader.collect();
  const names = resourceMetrics.scopeMetrics[0].metrics.map((m) => m.descriptor.name);
  assert.ok(names.includes(REQUEST_DURATION));
  assert.ok(!names.includes(DB_DURATION), 'healthz must not mint a db series');
  await provider.shutdown();
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `npm test -- test/otel.test.js`
Expected: FAIL — `SyntaxError: The requested module '../src/otel.js' does not provide an export named 'CPU_DURATION'`.

- [x] **Step 3: Add the instruments**

In `src/otel.js`, beside the existing `REQUEST_DURATION` constant:

```javascript
export const REQUEST_DURATION = 'http.server.request.duration';
export const DB_DURATION = 'http.server.db.duration';
export const CPU_DURATION = 'http.server.cpu.duration';
```

Replace `bindHistogram` and the module-level `let histogram = null;`:

```javascript
let histogram = null;
let dbHistogram = null;
let cpuHistogram = null;

export function bindHistogram(meterProvider) {
  const meter = meterProvider.getMeter(METER_NAME);
  histogram = meter.createHistogram(REQUEST_DURATION, {
    unit: 's',
    description: 'Duration of inbound HTTP requests, callback start to response finish.',
  });
  dbHistogram = meter.createHistogram(DB_DURATION, {
    unit: 's',
    description:
      'Wall-clock inside AWS SDK calls, summed per request. INCLUDES event-loop queueing '
      + 'by construction -- it brackets an await, so its clock runs while the resolved promise '
      + 'waits behind other work. Not a DynamoDB latency. Compare against CloudWatch '
      + 'SuccessfulRequestLatency: the GAP between them is the queueing measurement.',
  });
  cpuHistogram = meter.createHistogram(CPU_DURATION, {
    unit: 's',
    description:
      'Wall-clock in synchronous CPU work, summed per request. Uncontaminated -- it brackets '
      + 'no await. rate(_sum) is CPU-seconds per wall-second; against the task vCPU allocation '
      + 'that ratio is saturation.',
  });
}
```

Replace `recordRequest`:

```javascript
export function recordRequest({ route, method, status, durationSeconds, userAgent, phases }) {
  if (!histogram) return;
  // One attribute object, shared by all three instruments. Identical labels are
  // what let a query subtract one from another without a join that silently
  // drops series.
  const attrs = {
    'http.route': route,
    'http.request.method': method,
    'http.response.status_code': status,
    'traffic_source': trafficSource(userAgent),
  };
  histogram.record(durationSeconds, attrs);
  // Absent, not zero. /healthz does no measured work and must not mint a series
  // that a later query would read as "the database answered instantly".
  if (phases?.db !== undefined) dbHistogram.record(phases.db, attrs);
  if (phases?.cpu !== undefined) cpuHistogram.record(phases.cpu, attrs);
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/otel.test.js`
Expected: PASS, all tests in the file.

- [x] **Step 5: Run the whole unit suite**

Run: `npm test`
Expected: PASS. `test/integration.test.js` needs Docker; if it is skipped that is fine here — Task 5 covers it.

- [x] **Step 6: Commit**

```bash
git add src/otel.js test/otel.test.js
git commit -m "feat(ecs-dynamodb-rps-ceiling): add db and cpu phase histograms"
```

---

### Task 3: Timer exposes phases in seconds

**Files:**
- Modify: `src/timing.js`
- Test: `test/timing.test.js`

**Interfaces:**
- Produces: `timer.phases()` → `{ [name]: seconds }`. `timer.header()` is **removed**.
- Consumes: nothing.

- [x] **Step 1: Write the failing test**

Append to `test/timing.test.js`:

```javascript
test('phases() reports seconds, and sums repeated marks of the same name', async () => {
  const t = createTimer();
  await t.measure('db', async () => { const end = Date.now() + 12; while (Date.now() < end); });
  await t.measure('db', async () => { const end = Date.now() + 8;  while (Date.now() < end); });
  t.measureSync('cpu', () => { const end = Date.now() + 5; while (Date.now() < end); });

  const p = t.phases();
  // Seconds, not milliseconds: recordRequest feeds these straight into a
  // histogram whose unit is 's'. A 1000x error here is invisible until a
  // Grafana panel reads 20 seconds of database time per request.
  assert.ok(p.db >= 0.019 && p.db < 0.1, `db was ${p.db}, expected ~0.020 s`);
  assert.ok(p.cpu >= 0.004 && p.cpu < 0.1, `cpu was ${p.cpu}, expected ~0.005 s`);
});

test('phases() is empty when nothing was measured', () => {
  assert.deepEqual(createTimer().phases(), {});
});

test('header() is gone -- measurement no longer leaves over HTTP', () => {
  assert.equal(createTimer().header, undefined);
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `npm test -- test/timing.test.js`
Expected: FAIL — `TypeError: t.phases is not a function`.

- [x] **Step 3: Replace `header()` with `phases()`**

In `src/timing.js`, delete the `header()` method and add:

```javascript
    /**
     * Marks in SECONDS, because that is the unit of the histograms in otel.js.
     * The conversion lives here, once, rather than at every call site.
     */
    phases() {
      const out = {};
      for (const [name, ms] of marks) out[name] = ms / 1000;
      return out;
    },
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/timing.test.js`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/timing.js test/timing.test.js
git commit -m "refactor(ecs-dynamodb-rps-ceiling): timer exposes phases in seconds, not a header"
```

---

### Task 4: Delete the `Server-Timing` header and the `app` phase

**Files:**
- Modify: `src/server.js`
- Test: `test/integration.test.js:45-70`

**Interfaces:**
- Consumes: `timer.phases()` (Task 3), `recordRequest({..., phases})` (Task 2).
- Produces: no response carries `Server-Timing`.

- [x] **Step 1: Rewrite the three integration assertions**

In `test/integration.test.js`, replace three tests **found by name, not by line number** — `healthz responds without a Server-Timing header` and the two after it that assert the header's contents. Task 5 edits this same file afterwards and any offset quoted here will have moved by then:

```javascript
  test('no response carries a Server-Timing header', async () => {
    for (const [path, init] of [
      ['/healthz', undefined],
      ['/feeds/feed-00', undefined],
      ['/items/feed-00/item-00', undefined],
      ['/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
      ['/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"pk":"feed-00"}' }],
    ]) {
      const res = await fetch(url(path), init);
      assert.equal(res.headers.get('server-timing'), null, `${path} still emits Server-Timing`);
    }
  });
```

- [x] **Step 2: Run it and watch it fail**

```bash
docker compose -f docker-compose.test.yml up -d
DYNAMO_ENDPOINT=http://localhost:8000 npm run test:integration
```

Expected: FAIL — `/feeds/feed-00 still emits Server-Timing`.

> **`DYNAMO_ENDPOINT` is mandatory.** The suite is wrapped in
> `describe('integration', { skip: !process.env.DYNAMO_ENDPOINT && … })` and `npm run test:integration`
> does **not** set it, despite the comment in that file claiming otherwise. Without it every test
> SKIPS and `node --test` exits 0 — this red step would come back green having run nothing.
> Confirm the output says `# skipped 0`.

- [x] **Step 3: Strip the header and the `app` phase from `src/server.js`**

Replace `send` (lines 48–54) with:

```javascript
    const send = (status, body) => {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };
```

Extend the `finish` handler to carry the phases:

```javascript
    res.on('finish', () => recordRequest({
      route: template,
      method: req.method,
      status: res.statusCode,
      durationSeconds: (performance.now() - startedAt) / 1000,
      // Mapped to a closed set inside recordRequest; the raw value never reaches
      // the histogram, so an internet scanner cannot mint a time series.
      userAgent: req.headers['user-agent'],
      // Read on finish, when every mark is complete. /healthz touches no timer,
      // so this is {} there and no phase series is minted for it.
      phases: timer.phases(),
    }));
```

Replace the dispatch line (line 66) and its comment. The `app` phase is dropped per spec A4 — the unattributed remainder is `rate(request_sum) − rate(db_sum) − rate(cpu_sum)` at query time, so the wrapper and its `/healthz` special case both go:

```javascript
      const result = await handlers[route.name]({ params: route.params, body, timer });
```

- [x] **Step 4: Run the integration tests to verify they pass**

Run: `DYNAMO_ENDPOINT=http://localhost:8000 npm run test:integration`
Expected: PASS, with `# skipped 0` — a skipped suite is not a passing one.

- [x] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/server.js test/integration.test.js
git commit -m "feat(ecs-dynamodb-rps-ceiling)!: remove the Server-Timing response header

BREAKING CHANGE: k6 scripts parsing Server-Timing stop receiving phase
timings. Task 7 rewrites them. No infrastructure is replaced."
```

---

### Task 5: Delete `GET /stats`

**Files:**
- Modify: `src/handlers.js`
- Delete: `src/stats.js`, `test/stats.test.js`
- Test: `test/handlers.test.js:22,100,104`, `test/integration.test.js` (the test named `stats reports event-loop lag in milliseconds`)

**Interfaces:**
- Produces: `matchRoute('GET', '/stats')` → `null`.

- [x] **Step 1: Rewrite the failing assertions**

In `test/handlers.test.js`, delete the assertions at lines 22 and 100, change the template list at line 104 to drop `/stats`, and add:

```javascript
test('/stats is gone -- event-loop lag comes from nodejs_eventloop_delay_*', () => {
  assert.equal(matchRoute('GET', '/stats'), null);
});
```

In `test/integration.test.js`, replace the test named `stats reports event-loop lag in milliseconds` (Task 4 has already changed this file's line numbering — find it by name):

```javascript
  test('stats is not a route', async () => {
    assert.equal((await fetch(url('/stats'))).status, 404);
  });

  test('healthz still answers -- the ALB target group health-checks it', async () => {
    assert.equal((await fetch(url('/healthz'))).status, 200);
  });
```

- [x] **Step 2: Run them and watch them fail**

Run: `npm test -- test/handlers.test.js`
Expected: FAIL — `matchRoute('GET','/stats')` returns an object, not `null`.

- [x] **Step 3: Remove the route, the handler and the module**

In `src/handlers.js`: delete the `stats` line from `ROUTES`, delete the `async stats()` handler, and drop `snapshot` from the `./stats.js` import (the import line goes entirely).

```bash
git rm src/stats.js test/stats.test.js
```

- [x] **Step 4: Run both suites to verify they pass**

Run: `npm test && DYNAMO_ENDPOINT=http://localhost:8000 npm run test:integration`
Expected: PASS, with `# skipped 0` on the integration run. Unit count drops by the number of tests that were in `stats.test.js`.

- [x] **Step 5: Commit**

```bash
git add -A src/handlers.js src/stats.js test/
git commit -m "feat(ecs-dynamodb-rps-ceiling)!: delete GET /stats

RuntimeNodeInstrumentation has been emitting nodejs.eventloop.delay all
along -- verified live at 0.0109 s p99 the same instant /stats reported
10.797 ms, plus v8js_memory_heap_used_bytes for the memory half. The
endpoint was pure duplication kept only because the k6 scripts were
frozen; nothing has been measured, so they are not.

BREAKING CHANGE: GET /stats now returns 404. The k6 stats scenario is
removed in Task 7."
```

---

### Task 6: Decide the fate of `AwsInstrumentation`

**Files:**
- Modify: `src/otel.js` (conditional — outcome decides)

**This task ends in a recorded decision, not a guaranteed deletion.** Spec risk 3: emitting nothing may be a configuration fault rather than a dead component, and a misconfigured component should be repaired, not removed.

- [x] **Step 1: Confirm it emits nothing in the live tenant**

```bash
set -a && . ../.env && set +a
P="$GRAFANA_URL/api/datasources/proxy/uid/grafanacloud-prom/api/v1"
curl -s -H "Authorization: Bearer $GRAFANA_AUTH" --get \
  --data-urlencode 'match[]={job="ecs-dynamodb-rps-ceiling"}' "$P/series" \
  | jq -r '.data[]?.__name__' | sort -u
```

Expected (verified 2026-08-31): `http_server_request_duration_seconds`, the `nodejs_eventloop_*` family, the `v8js_*` family, `target_info`. **No `aws_*`, no `db_*`, no `rpc_*`.**

- [x] **Step 2: Establish whether metrics are even reachable for this instrumentation**

Read the installed package's own surface rather than guessing:

```bash
grep -rn "createHistogram\|createCounter\|meter\|metric" \
  node_modules/@opentelemetry/instrumentation-aws-sdk/build/src/*.js | head -20
```

Decision rule, applied literally:

- **If the package registers no instruments at all** — it is a tracing-only instrumentation and no configuration makes it emit metrics without a tracer provider. It is dead weight on a 250 µs/request budget. **Delete it.**
- **If it registers instruments** but they are absent from Step 1, it is misconfigured. **Do not delete.** Record what is missing in the ledger, leave the code untouched, and open it as a follow-up — repairing it is not in this plan's scope and must not expand into it mid-task.

- [x] **Step 3: Apply the decision**

If deleting: remove the `AwsInstrumentation` import and its entry in the `registerInstrumentations` array in `src/otel.js`, and remove `@opentelemetry/instrumentation-aws-sdk` from `package.json` dependencies. Update the block comment above `registerInstrumentations`, which currently claims the instrumentation "gives DynamoDB call counts, errors and SDK RETRIES" — that sentence is false and must not survive.

Then: `npm install` to update the lockfile.

If keeping: change nothing in `src/`; write the finding into the ledger.

- [x] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS either way.

- [x] **Step 5: Commit**

```bash
git add -A src/otel.js package.json package-lock.json
git commit -m "refactor(ecs-dynamodb-rps-ceiling): <remove|retain> AwsInstrumentation

<one line: which branch of the decision rule fired, and the evidence>"
```

---

## Phase 2 — The shared query set (local only, no AWS spend)

### Task 7: `attribution:` in `slo.yaml`, and `grafana/queries.json`

**Files:**
- Modify: `slo.yaml`, `scripts/generate-slo.js`
- Create (generated): `grafana/queries.json`
- Test: `test/generate-slo.test.js`

**Interfaces:**
- Produces: `renderQueries(doc)` → JSON string; `grafana/queries.json` as `{ "<key>": "<promql>" }`.
- Consumes: `loadSlo`, `ratioExpr`, `SCOPE` (existing in `scripts/generate-slo.js`).

- [x] **Step 1: Add the attribution block to `slo.yaml`**

Append:

```yaml
# Attribution inputs. The route -> DynamoDB operation map is what lets in-process
# db time be compared against DynamoDB's own clock; /reports issues TWO calls, so
# its comparison is against the sum of both operations.
attribution:
  vcpu_per_task: 0.25
  operations:
    getItem: [GetItem]
    putItem: [PutItem]
    feed:    [Query]
    report:  [Query, PutItem]
```

- [x] **Step 2: Write the failing test**

Append to `test/generate-slo.test.js`. That file's existing import is `{ burnWindows, loadSlo, renderCapacityTfvars, renderK6 }` — **add `renderAlerts` and `renderQueries` to it**; both are used below and neither is imported today.

```javascript
test('queries.json carries one query per attribution key, all non-empty', () => {
  const doc = loadSlo('slo.yaml');
  const q = JSON.parse(renderQueries(doc));
  for (const key of [
    'sli_ratio', 'db_wall_avg_by_route', 'cloudwatch_srl_by_operation',
    'queueing_ms_by_route', 'cpu_seconds_per_second', 'cpu_saturation_ratio',
    'eventloop_delay_p99', 'eventloop_utilization', 'throttled_requests',
  ]) {
    assert.ok(q[key] && q[key].trim().length > 0, `${key} missing from queries.json`);
  }
});

test('every classified route has a DynamoDB operation mapping', () => {
  const doc = loadSlo('slo.yaml');
  const classified = Object.values(doc.slos.find((s) => s.sli === 'class_threshold_ratio').classes)
    .flatMap((c) => c.endpoints);
  for (const endpoint of classified) {
    assert.ok(doc.attribution.operations[endpoint],
      `${endpoint} is classified but has no attribution.operations entry`);
  }
});

test('the cpu saturation query divides by the real vCPU allocation', () => {
  const q = JSON.parse(renderQueries(loadSlo('slo.yaml')));
  assert.match(q.cpu_saturation_ratio, /0\.25/);
});

test('the SLO scope no longer excludes /stats, because /stats no longer exists', () => {
  const out = renderAlerts(loadSlo('slo.yaml'));
  assert.match(out, /http_route!~"\/healthz"/);
  assert.ok(!out.includes('/stats'), 'a deleted route is still named in a generated selector');
});
```

Then **change the existing assertion at line 140** from `/http_route!~"\/healthz\|\/stats"/` to `/http_route!~"\/healthz"/`, and update the comment at line 112 which mentions `/stats`.

- [x] **Step 3: Run it and watch it fail**

Run: `npm test -- test/generate-slo.test.js`
Expected: FAIL — no export named `renderQueries`.

- [x] **Step 4: Drop `/stats` from `SCOPE`**

In `scripts/generate-slo.js`:

```javascript
const SCOPE = (doc) => `job="${doc.service}", http_route!~"/healthz", class=~"${CLASSES(doc)}"`;
```

Update the doc comment above it: the exclusion now documents intent for **one** health endpoint, not two.

- [x] **Step 5: Write `renderQueries`**

Add above the `OUTPUTS` table. Every query is written against the label set the service actually emits — `job`, `instance`, `http_route`, `class`, `traffic_source` — and the CloudWatch series Alloy already forwards.

```javascript
const DB = 'http_server_db_duration_seconds';
const CPU = 'http_server_cpu_duration_seconds';

/**
 * grafana/queries.json: every query the dashboard panels, /loadtest and the
 * README deep-links read, defined once.
 *
 * Three properties are load-bearing and each produces a silently wrong number
 * if dropped:
 *  - CloudWatch SuccessfulRequestLatency is MILLISECONDS; the histograms are
 *    SECONDS. queueing_ms_by_route converts explicitly.
 *  - CloudWatch publishes at 60s and Alloy scrapes at 60s, while the service
 *    exports at 15s. Every cross-source query uses a 60s range or wider.
 *  - SuccessfulRequestLatency counts only SUCCESSFUL calls, so the gap stops
 *    being interpretable once throttling starts -- by which point
 *    throttled_requests has already answered the question.
 */
export function renderQueries(doc) {
  const scope = SCOPE(doc);
  const vcpu = doc.attribution.vcpu_per_task;
  const q = {
    sli_ratio: ratioExpr(doc, { range: '$__rate_interval' }),

    db_wall_avg_by_route:
      `1000 * sum by (http_route) (rate(${DB}_sum{${scope}}[60s]))`
      + ` / sum by (http_route) (rate(${DB}_count{${scope}}[60s]))`,

    cloudwatch_srl_by_operation:
      'aws_dynamodb_successful_request_latency_average{dimension_TableName="'
      + `${doc.service}"}`,

    // The queueing signal, in milliseconds. Positive and growing means requests
    // are waiting on the event loop, not on DynamoDB.
    queueing_ms_by_route:
      `1000 * sum by (http_route) (rate(${DB}_sum{${scope}}[60s]))`
      + ` / sum by (http_route) (rate(${DB}_count{${scope}}[60s]))`
      + ' - on() group_left avg(aws_dynamodb_successful_request_latency_average{'
      + `dimension_TableName="${doc.service}"})`,

    // CPU-seconds burned per wall-second, per task.
    cpu_seconds_per_second: `sum by (instance) (rate(${CPU}_sum{${scope}}[60s]))`,

    // The same number as a fraction of the allocation. 1.0 is saturation.
    cpu_saturation_ratio: `sum by (instance) (rate(${CPU}_sum{${scope}}[60s])) / ${vcpu}`,

    eventloop_delay_p99: `nodejs_eventloop_delay_p99_seconds{job="${doc.service}"}`,
    eventloop_delay_max: `nodejs_eventloop_delay_max_seconds{job="${doc.service}"}`,
    eventloop_utilization: `nodejs_eventloop_utilization_ratio{job="${doc.service}"}`,

    throttled_requests:
      `sum(rate(aws_dynamodb_throttled_requests_sum{dimension_TableName="${doc.service}"}[60s]))`,
  };
  return `${JSON.stringify(q, null, 2)}\n`;
}
```

Add to `OUTPUTS`, after `grafana/classmap.json`:

```javascript
  ['grafana/queries.json', renderQueries],
```

- [x] **Step 6: Generate, and confirm only the intended files moved**

```bash
npm run slo:generate
git status --short
```

Expected: `grafana/queries.json` created; `grafana/alerts.tf` and `grafana/locals.tf` modified (the `/stats` selector). `k6/lib/slo.js`, `terraform/capacity.auto.tfvars` and `grafana/classmap.json` **unchanged** — the attribution block must not perturb the thresholds or the capacity model.

```bash
git diff --stat grafana/alerts.tf grafana/locals.tf
git diff grafana/alerts.tf | grep '^[-+].*http_route' | sort -u
```

Expected: every changed line differs only by dropping `|/stats`.

- [x] **Step 7: Verify `--check` is green and the suite passes**

```bash
npm run slo:check && npm test
```
Expected: `slo.yaml and its generated outputs agree`, exit 0; all unit tests PASS.

- [x] **Step 8: Prove the queries actually resolve before anything depends on them**

A query that parses but matches nothing is the failure mode this whole project exists to remove. The db/cpu series do not exist yet (Task 9 deploys them), so only the four that should already resolve are checked here.

```bash
set -a && . ../.env && set +a
P="$GRAFANA_URL/api/datasources/proxy/uid/grafanacloud-prom/api/v1"
for k in sli_ratio eventloop_delay_p99 eventloop_utilization throttled_requests; do
  Q=$(jq -r --arg k "$k" '.[$k]' grafana/queries.json | sed 's/\$__rate_interval/5m/g')
  printf '%-24s ' "$k"
  curl -s -H "Authorization: Bearer $GRAFANA_AUTH" --get \
    --data-urlencode "query=$Q" "$P/query" | jq -c '.status, (.data.result|length)'
done
```

Expected: `"success"` and a non-zero result length for each. A `0` length is a failure — fix the query now, not after a panel is built on it.

- [x] **Step 9: Commit**

```bash
git add slo.yaml scripts/generate-slo.js grafana/queries.json grafana/alerts.tf grafana/locals.tf test/generate-slo.test.js
git commit -m "feat(ecs-dynamodb-rps-ceiling/grafana): generate the shared attribution query set"
```

---

### Task 8: Dashboard panels for the service's own metrics

**Files:**
- Rename: `grafana/dashboard.json` → `grafana/dashboard.json.tftpl`
- Modify: `grafana/folder.tf:8-11`

**The dashboard currently has 35 CloudWatch targets and zero panels on service-emitted metrics.** Those five CloudWatch rows must survive this task byte-equivalent.

- [x] **Step 1: Rename, and template only the new content**

```bash
git mv grafana/dashboard.json grafana/dashboard.json.tftpl
```

Every existing panel stays exactly as it is. `${...}` sequences are Terraform template syntax, so **check first that the committed JSON contains none** — if it does, they must be escaped as `$${...}` or the render fails:

```bash
grep -c '\${' grafana/dashboard.json.tftpl
```
Expected: `0`. If non-zero, escape each occurrence before continuing.

- [x] **Step 2: Add two rows**

Append two row panels to the `panels` array, before the closing bracket. Panel `id` values must not collide with existing ones — take the current maximum and continue from it:

```bash
jq '[.panels[].id] | max' grafana/dashboard.json.tftpl
```

Row **"6. Service SLI — as the alert rules compute it"**: one timeseries panel, target expression `${sli_ratio}`, datasource the Prometheus one (`grafanacloud-prom`), unit `percentunit`.

Row **"7. Attribution — the four discriminators"**: four timeseries panels, each `datasource` Prometheus:

| panel | expr | unit | note |
|---|---|---|---|
| DB wall-clock vs DynamoDB's own clock | `${db_wall_avg_by_route}` and `${cloudwatch_srl_by_operation}` as two targets | `ms` | the visible gap is the queueing |
| Queueing delay by route | `${queueing_ms_by_route}` | `ms` | positive and growing ⇒ service-bound |
| CPU saturation | `${cpu_saturation_ratio}` | `percentunit` | 1.0 is the 0.25 vCPU ceiling |
| Event-loop delay p99 by task | `${eventloop_delay_p99}` | `s` | `by (instance)` — four lines after Task 20 |

- [x] **Step 3: Switch the resource to `templatefile`**

In `grafana/folder.tf`:

```hcl
resource "grafana_dashboard" "attribution" {
  folder = grafana_folder.project.uid
  config_json = templatefile("${path.module}/dashboard.json.tftpl",
    jsondecode(file("${path.module}/queries.json"))
  )
}
```

`jsondecode` of `queries.json` supplies exactly the variables the template names, so a key added to the generator becomes available with no second edit — and a `${...}` with no matching key fails the plan loudly rather than rendering empty.

- [x] **Step 4: Validate, and prove the CloudWatch rows are untouched**

```bash
terraform -chdir=../terraform fmt -check
terraform -chdir=../terraform validate
terraform -chdir=../terraform plan -var-file=dev.tfvars -out=tfplan-dash
terraform -chdir=../terraform show -json tfplan-dash \
  | jq -r '.resource_changes[] | select(.address|test("grafana_dashboard")) | .change.after.config_json' \
  > /tmp/rendered-dashboard.json
```

Then confirm the five existing rows survived:

```bash
jq -r '.panels[] | select(.type=="row") | .title' /tmp/rendered-dashboard.json
jq '[.panels[] | select(.datasource.type=="cloudwatch")] | length' /tmp/rendered-dashboard.json
```

Expected: seven row titles, the original five first and unchanged; the CloudWatch panel count matches the committed file's. Compare directly:

```bash
jq '[.panels[] | select(.datasource.type=="cloudwatch")]' /tmp/rendered-dashboard.json > /tmp/after.json
git show HEAD~1:ecs-dynamodb-rps-ceiling/grafana/dashboard.json \
  | jq '[.panels[] | select(.datasource.type=="cloudwatch")]' > /tmp/before.json
diff /tmp/before.json /tmp/after.json && echo "CLOUDWATCH ROWS IDENTICAL"
```

Expected: `CLOUDWATCH ROWS IDENTICAL`. **If they differ, stop and fix** — this task must add panels, never disturb existing ones.

- [x] **Step 5: Commit**

```bash
git add grafana/dashboard.json.tftpl grafana/folder.tf
git commit -m "feat(ecs-dynamodb-rps-ceiling/grafana): add SLI and attribution panels"
```

---

## Phase 3 — k6 becomes a pure gate (local only, no AWS spend)

### Task 9: Strip server-side metrics from k6

**Files:**
- Modify: `k6/lib/request.js`, `k6/constant.js`, `k6/discovery.js`, `k6/stress.js`

**Interfaces:**
- Produces: `doRequest(baseUrl)` unchanged in signature. `pollStats` is **removed**.

- [x] **Step 1: Confirm the generated thresholds do not name a deleted metric**

The thresholds are generated; deleting a metric a threshold names would make every run fail to start.

```bash
grep -nE 'db_ms|cpu_ms|app_ms|el_delay' k6/lib/slo.js
```
Expected: **no output.** If anything matches, the fix belongs in `renderK6` in `scripts/generate-slo.js`, not in the generated file.

- [x] **Step 2: Reduce `k6/lib/request.js` to client-observable metrics**

Delete the four `Trend` declarations (lines 9–12), the `parseServerTiming` function (lines 21–29), the attribution block (lines 55–62) and `pollStats` (lines 67–73). Drop `Trend` from the `k6/metrics` import, keeping `Rate`.

The file keeps `sloMet`, `sloMetTail`, `doRequest`, and gains this comment above the `Rate` declarations:

```javascript
// k6 records ONLY what a client can observe. Phase timings and event-loop lag
// are emitted by the service into OpenTelemetry and read from Grafana -- see
// docs/superpowers/specs/2026-08-31-ecs-dynamodb-rps-ceiling-attribution-via-metrics-design.md.
// Nothing in the service exists for this file's benefit.
```

- [x] **Step 3: Remove the `stats` scenario from all three profiles**

In each of `k6/constant.js`, `k6/discovery.js` and `k6/stress.js`: delete the `stats:` scenario block from `options.scenarios`, delete `export function stats() { pollStats(BASE_URL); }`, and drop `pollStats` from the `./lib/request.js` import.

- [x] **Step 4: Verify all three still parse and carry the right shape**

`k6 inspect` ignores the shell environment while `k6 run` honours it, so pass `-e` explicitly — an unset `BASE_URL` has no guard and silently targets `undefined/…`.

```bash
for f in k6/constant.js k6/discovery.js k6/stress.js; do
  echo "--- $f"
  k6 inspect -e BASE_URL=http://example.invalid -e RATE=100 -e VUS=10 "$f" \
    | jq -r '.scenarios | keys | join(", ")'   # top level, NOT .options.scenarios
done
```

Expected: `constant.js` -> `steady`, `discovery.js` -> `ramp`, `stress.js` -> `spike`. No file
reports a scenario named `stats`.

> **The `jq` path is `.scenarios`, not `.options.scenarios`.** In k6 v1.4.0 `inspect` emits the
> resolved options at the top level, so the `.options.` prefix yields
> `jq: error … null (null) has no keys` and verifies nothing.

```bash
grep -rn 'pollStats\|db_ms\|cpu_ms\|app_ms\|el_delay\|Server-Timing' k6/
```
Expected: no output.

- [x] **Step 5: Commit**

```bash
git add k6/
git commit -m "test(ecs-dynamodb-rps-ceiling/k6): record only client-observable metrics"
```

---

## Phase 4 — Deploy and verify (touches live infrastructure)

### Task 10: APPROVAL GATE — rebuild the image and deploy

**Files:** none changed.

**This task changes what is running in AWS and STOPS for approval.** It creates no new billable resource: one image push to an existing ECR repository and one rolling task replacement. Cost is unchanged at ~$0.055/hour.

> **Terraform does not rebuild the container image.** This step exists because omitting it leaves the collector receiving nothing from a service that is healthy by every other indicator — the exact failure that cost a full debugging cycle in the 2026-08-30 plan.

- [x] **Step 1: STOP — get approval before building**

Present: the commits from Tasks 2–6, that this replaces the running task, and that rollback is a redeploy of the previous task-definition revision.

- [x] **Step 2: Build, push, and force a new deployment**

```bash
ACC=042945885621; REG=eu-central-1
REPO=$ACC.dkr.ecr.$REG.amazonaws.com/ecs-dynamodb-rps-ceiling
aws ecr get-login-password --region $REG | docker login --username AWS --password-stdin $ACC.dkr.ecr.$REG.amazonaws.com
docker build --platform linux/amd64 -t $REPO:attribution -t $REPO:latest .
docker push $REPO:attribution && docker push $REPO:latest
aws ecs update-service --cluster ecs-dynamodb-rps-ceiling \
  --service ecs-dynamodb-rps-ceiling --force-new-deployment --region $REG >/dev/null
```

`--platform linux/amd64` is not optional on an Apple-silicon host: the task definition targets X86_64 and an arm64 image fails at task start with `exec format error`.

- [x] **Step 3: Wait for the deployment to stabilise**

```bash
aws ecs wait services-stable --cluster ecs-dynamodb-rps-ceiling \
  --services ecs-dynamodb-rps-ceiling --region eu-central-1
aws ecs describe-services --cluster ecs-dynamodb-rps-ceiling \
  --services ecs-dynamodb-rps-ceiling --region eu-central-1 \
  --query 'services[0].{running:runningCount,desired:desiredCount}'
```
Expected: `running == desired == 1`.

- [x] **Step 4: Confirm the HTTP surface actually changed**

```bash
B="$BASE_URL"   # from the root .env; never hard-code the ALB hostname in git
curl -s -o /dev/null -w '%{http_code}\n' "$B/stats"      # expect 404
curl -s -o /dev/null -w '%{http_code}\n' "$B/healthz"    # expect 200
curl -s -D- -o /dev/null "$B/feeds/feed-00" | grep -ci '^server-timing:'  # expect 0
```

- [x] **Step 5: Confirm the new series arrive**

Wait 90 seconds — two 15 s export intervals plus scrape and ingest.

```bash
set -a && . ../.env && set +a
P="$GRAFANA_URL/api/datasources/proxy/uid/grafanacloud-prom/api/v1"
curl -s -H "Authorization: Bearer $GRAFANA_AUTH" --get \
  --data-urlencode 'match[]={job="ecs-dynamodb-rps-ceiling"}' "$P/series" \
  | jq -r '.data[]?.__name__' | sort -u | grep -E 'db_duration|cpu_duration'
```
Expected: `http_server_cpu_duration_seconds` and `http_server_db_duration_seconds`.

Then confirm Alloy classified them with **no collector change**, which is the claim spec §3 rests on:

```bash
curl -s -H "Authorization: Bearer $GRAFANA_AUTH" --get \
  --data-urlencode 'match[]=http_server_cpu_duration_seconds' "$P/series" \
  | jq -r '.data[] | "\(.http_route)\t\(.class)"' | sort -u
```
Expected: `/reports heavy`, `/feeds/:pk standard`, `/items fast`, `/items/:pk/:sk fast`. **A blank `class` column means the OTTL statements did not match** — stop and inspect the collector logs before proceeding.

If the deployment fails or the series never appear, roll back:

```bash
aws ecs update-service --cluster ecs-dynamodb-rps-ceiling --service ecs-dynamodb-rps-ceiling \
  --task-definition ecs-dynamodb-rps-ceiling:<previous-revision> --region eu-central-1
```

- [x] **Step 6: Record the outcome in the ledger**

**No commit** — the ledger is git-ignored (see Task 1 Step 3). Write the verified series names, the
`http_route`/`class` pairs from Step 5, and the deployed task-definition revision into the ledger, so
a rollback target survives a lost context.

---

### Task 10b: Fix the SLI aggregation order, which goes NaN with more than one instance

**Added 2026-08-31 during execution, after Task 10's deploy exposed it. Approved as in-scope by the user.**

**Files:**
- Modify: `scripts/generate-slo.js` (`ratioExpr`)
- Regenerate: `grafana/alerts.tf`, `grafana/locals.tf`, `grafana/queries.json`
- Test: `test/generate-slo.test.js`

**The defect.** `ratioExpr` applies `histogram_fraction` **per series, then sums**:

```promql
sum(histogram_fraction(0, B, rate(sel[range])) * histogram_count(rate(sel[range])))
```

A series whose rate window holds zero observations has `count = 0`, so its fraction is 0/0 = `NaN`,
and one `NaN` poisons the entire `sum()`. Measured against the live tenant immediately after the
Task 10 deploy, with the retired task still in range:

```
count per instance, fast class                     7 series, first = 0
fraction per instance, fast class                  7 series, first = NaN
CURRENT   sum(fraction * count)                    NaN
PROPOSED  fraction(sum(rate)) * count(sum(rate))   0.0880065…
PROPOSED  full SLI, all three classes              1
```

**This predates this plan** — `ratioExpr` comes from the 2026-08-30 plan and feeds `grafana_slo` and
all four burn-rate rule groups. It has worked only because the service ran as one instance with
steady heartbeat traffic, the single regime where no series is ever empty.

**Why it is fixed here rather than deferred:** Task 11 applies the rule groups containing it, and
**Task 20 of the 2026-08-29 plan scales the service 1 → 4 tasks**, after which any window where one
task serves no `fast` request makes the SLO and every burn alert evaluate to `NaN`. The project's
deliverable is SLO attainment measured across that autoscaling change.

- [x] **Step 1: Write the failing test**

Add to `test/generate-slo.test.js`. This pins the *shape*, which is what stops the defect returning:

```javascript
test('histogram_fraction is applied to an AGGREGATED histogram, never per series', () => {
  const out = renderLocals(loadSlo('slo.yaml'));
  // The broken form applies the fraction to a bare rate() and sums afterwards.
  // One empty series then contributes NaN and poisons the whole sum.
  assert.ok(!/histogram_fraction\([^)]*rate\(/.test(out.replace(/\s+/g, ' ')),
    'histogram_fraction is being applied to a per-series rate() -- it must wrap sum(rate(...))');
  // The correct form aggregates first.
  assert.match(out.replace(/\s+/g, ' '), /histogram_fraction\(0, [\d.]+, sum\(rate\(/);
  assert.match(out.replace(/\s+/g, ' '), /histogram_count\(sum\(rate\(/);
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `npm test -- test/generate-slo.test.js`
Expected: FAIL on the first assertion — the generated output currently applies the fraction per series.

- [x] **Step 3: Change `ratioExpr`**

Aggregate inside, so exactly one fraction is taken per class:

```javascript
  const good = Object.entries(slo.classes).map(([name, c]) => {
    const bound = ((c.threshold_ms * multiplier) / 1000);
    const sel = `${METRIC}{${base}, class="${name}"}`;
    // Aggregate BEFORE taking the fraction. Applying histogram_fraction per
    // series and summing afterwards yields NaN whenever any one series has zero
    // observations in the window -- which happens on every deploy (the retired
    // task lingers in range) and continuously once the service runs more than
    // one task. Native histograms sum exactly, so one fraction over the summed
    // histogram is both correct and NaN-safe.
    return `    histogram_fraction(0, ${bound}, sum(rate(${sel}[${range}]))) * histogram_count(sum(rate(${sel}[${range}])))`;
  }).join('\n  +\n');
  return `(\n${good}\n  )\n  /\n  histogram_count(sum(rate(${METRIC}{${base}}[${range}])))`;
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/generate-slo.test.js` — expected PASS.

- [x] **Step 5: Regenerate, and check what moved**

```bash
npm run slo:generate
git status --short
npm run slo:check
```

`grafana/alerts.tf`, `grafana/locals.tf` and `grafana/queries.json` (its `sli_ratio` key) must change.
`k6/lib/slo.js`, `terraform/capacity.auto.tfvars` and `grafana/classmap.json` must **not** — the
thresholds and capacity model are untouched by an aggregation-order change. If any of those three
moves, stop.

- [x] **Step 6: Prove the new expression evaluates on live data, and the old one does not**

Read-only; `.env` is symlinked one level up.

```bash
set -a && . ../.env && set +a
P="$GRAFANA_URL/api/datasources/proxy/uid/grafanacloud-prom/api/v1"
EXPR=$(jq -r '.sli_ratio' grafana/queries.json | sed 's/\$__rate_interval/5m/g')
curl -s -H "Authorization: Bearer $GRAFANA_AUTH" --get \
  --data-urlencode "query=$EXPR" "$P/query" | jq -c '.data.result[0].value[1]'
```

Expected: a real number in `[0,1]`, **not** `NaN`. A `NaN` here means the fix did not take.

- [x] **Step 7: Run the whole suite and commit**

`npm test` (expect 82 pass) and `npm run slo:check` exit 0.

```bash
git add scripts/generate-slo.js grafana/ test/generate-slo.test.js
git commit -m "fix(ecs-dynamodb-rps-ceiling/grafana)!: aggregate histograms before taking the fraction

histogram_fraction was applied per series and summed afterwards, so any
series with zero observations in the window contributed 0/0 = NaN and
poisoned the whole SLI. Measured NaN against the live tenant right after a
deploy, with the retired task still in range; the aggregated form returns
1 from identical data.

This predates this plan -- it worked only while the service ran as a single
instance with steady heartbeat traffic, the one regime where no series is
ever empty. It would have broken permanently at Task 20 of the 2026-08-29
plan, which scales the service 1 -> 4 tasks: any window where one task
serves no fast request would take the SLO and every burn alert to NaN.

BREAKING CHANGE: grafana_slo and all four burn-rate rule groups carry a
rewritten query. No resource is replaced; the SLO's recorded history is
unaffected."
```

---

### Task 11: APPROVAL GATE — apply the Grafana module

**Files:** none changed.

Applies the regenerated `alerts.tf` / `locals.tf` (the `/stats` selector) and the templated dashboard. **No AWS resource changes; no cost change.** The workspace runs remotely with `working-directory = "terraform"` and credentials from HCP workspace variables, not your shell.

- [x] **Step 1: Plan and review**

```bash
terraform -chdir=../terraform plan -var-file=dev.tfvars -out=tfplan-attribution
```

Expected: `grafana_dashboard.attribution` updated in place; four `grafana_rule_group` resources updated in place; `grafana_slo.latency_classes` updated in place. **If anything proposes to destroy and recreate `grafana_slo`, stop** — recreating it resets the error-budget history this project is accruing.

Confirm no AWS resource is touched:

```bash
terraform -chdir=../terraform show -json tfplan-attribution \
  | jq -r '.resource_changes[] | select(.change.actions[0] != "no-op") | .address'
```
Expected: only `grafana_*` addresses.

- [x] **Step 2: STOP — approval, then apply**

Use `/env up ecs-dynamodb-rps-ceiling`, or `terraform -chdir=../terraform apply tfplan-attribution`. Never `-auto-approve`.

- [x] **Step 3: Confirm the rules still evaluate and the panels resolve**

```bash
set -a && . ../.env && set +a
curl -s -H "Authorization: Bearer $GRAFANA_AUTH" \
  "$GRAFANA_URL/api/v1/provisioning/alert-rules" \
  | jq -r '.[] | select(.ruleGroup|test("latency_classes")) | "\(.title)\t\(.title)"' | head
```

Then check health is `ok` for each rule group in the Grafana UI (Alerting → Alert rules), and open the dashboard: rows 6 and 7 must render data, not "No data". Row 7's queueing panel may be empty until enough 60 s windows accumulate — wait three minutes before calling it a failure.

- [x] **Step 4: Commit any drift the apply revealed**

```bash
npm run slo:check
git status --short
```
Expected: `slo.yaml and its generated outputs agree`, clean tree.

---

### Task 12: Settle whether `pbkdf2_iterations` moves

**Files:** `terraform/dev.tfvars` (only if the evidence demands it)

Spec A10: leave it at **2662** unless the evidence says otherwise. `scripts/calibrate.js` measures `burn()` in isolation and **cannot observe instrumentation cost at all**, so recalibrating it would prove nothing about this change.

- [x] **Step 1: Read the post-change CPU phase from the histogram**

The heartbeat drives all four routes at 1/min, so a population exists without spending a VU-hour.

```bash
set -a && . ../.env && set +a
P="$GRAFANA_URL/api/datasources/proxy/uid/grafanacloud-prom/api/v1"
# Native histograms: no _sum/_count companion series exist, and the fraction/sum
# must wrap an AGGREGATED histogram or a single empty series yields NaN.
Q='1000 * histogram_sum(sum(rate(http_server_cpu_duration_seconds{job="ecs-dynamodb-rps-ceiling", http_route="/reports"}[30m])))
   / histogram_count(sum(rate(http_server_cpu_duration_seconds{job="ecs-dynamodb-rps-ceiling", http_route="/reports"}[30m])))'
curl -s -H "Authorization: Bearer $GRAFANA_AUTH" --get --data-urlencode "query=$Q" "$P/query" \
  | jq -r '.data.result[0].value[1]'
```

Expected: a value in milliseconds, near the Task 1 baseline (~1.4 ms).

Wait at least 30 minutes after Task 10's deploy before running this, or the range covers pre-change tasks too.

- [x] **Step 2: Apply the decision rule**

Compare against the Task 1 median.

- **Within ±5%:** change nothing. Record both numbers and the verdict in the ledger. This is the expected outcome — the equivalent change when OpenTelemetry was first added moved it −0.49%.
- **Beyond ±5%:** the instrumentation materially altered the CPU budget. Record it, and note in the ledger that Task 18 of the 2026-08-29 plan must re-derive the value **before** the discovery run. Do not re-derive it here: it would need a Fargate calibration run and belongs with the task that reads the ceiling.

**Do not adjust `pbkdf2_iterations` to chase the baseline.** The number's job is to place the service ceiling at ~70% of the DB ceiling; a sub-5% CPU drift does not move that, and churning it makes future runs incomparable.

- [x] **Step 3: Record the verdict in the ledger**

**No commit** — the ledger is git-ignored (see Task 1 Step 3). Record both numbers, the percentage
delta, and the verdict. If the verdict is "beyond ±5%", Task 15 must carry it into the 2026-08-29
plan's hand-back note, where it changes what Task 18 does.

---

## Phase 5 — The reader's surface

### Task 13: `/loadtest` records the server-side columns

**Files:**
- Modify: `.claude/skills/loadtest/SKILL.md` (repo root, not the project directory)

- [x] **Step 1: Delete the stale local-run example**

Line 29 shows `k6 run --no-color --summary-export=…`. The skill already states at line 110 that "The command is `k6 cloud run`, not `k6 run`", and load must originate in Frankfurt rather than on a laptop. Remove the local variant so the wrong one cannot be copied.

- [x] **Step 2: Add the attribution query step**

After the k6 run and summary parse, before the results row is written:

````markdown
### Read the server-side numbers from Grafana

k6 records only what a client can observe. `bound resource`, `queueing ms` and
`service attainment` come from the SLO and the attribution queries, over the
run's own window.

```bash
set -a && . .env && set +a
P="$GRAFANA_URL/api/datasources/proxy/uid/grafanacloud-prom/api/v1"
Q=ecs-dynamodb-rps-ceiling/grafana/queries.json
for k in sli_ratio queueing_ms_by_route cpu_saturation_ratio throttled_requests; do
  EXPR=$(jq -r --arg k "$k" '.[$k]' "$Q" | sed "s/\$__rate_interval/${RUN_WINDOW:-5m}/g")
  printf '%-24s ' "$k"
  curl -s -H "Authorization: Bearer $GRAFANA_AUTH" --get \
    --data-urlencode "query=$EXPR" "$P/query" | jq -c '.data.result[]?.value[1]'
done
```

`GRAFANA_AUTH` is **required**, not optional. `K6_PROMETHEUS_RW_*` is write-scoped
and returns `invalid scope requested`, which a naive parser reads as "no data".
````

- [x] **Step 3: Extend the results schema**

Add two columns to the `results.md` table definition, documented beside the existing pair:

| column | source |
|---|---|
| `bound resource` | the four-row table in spec §5 — `db-capacity` \| `db-latency` \| `service-cpu` \| `edge` |
| `queueing ms` | `queueing_ms_by_route`, the worst route over the run window |

Keep `k6 attainment` and `service attainment` distinct and never write one number into both. Extend the `awk` completeness check to cover the new column indices, and **verify the existing `$4`/`$6` indices still resolve** after the addition rather than assuming they do.

- [x] **Step 4: Commit**

```bash
git add .claude/skills/loadtest/SKILL.md
git commit -m "feat(repo): loadtest reads attribution from grafana, not the k6 summary"
```

---

### Task 14: Rewrite the README around the reader's question

**Files:**
- Rewrite: `ecs-dynamodb-rps-ceiling/README.md`

**Supersedes Task 22 Step 1 of the 2026-08-29 plan.** The current README is a nine-phase operator runbook; someone asking "is it healthy?" should not have to read a Terraform command to find out.

- [x] **Step 1: Collect the stable deep-link bases**

A hand-typed panel id rots the moment a panel moves, so read them:

```bash
set -a && . ../.env && set +a
# type=dash-db is REQUIRED. Without it the first hit is the FOLDER
# (uid bfwtjvbftsu0we, type dash-folder), not the dashboard (uid agbp7d) --
# and every deep-link built from the folder uid 404s.
curl -s -H "Authorization: Bearer $GRAFANA_AUTH" \
  "$GRAFANA_URL/api/search?query=ecs-dynamodb-rps-ceiling&type=dash-db" \
  | jq -r '.[] | select(.title | test("attribution")) | "\(.uid)\t\(.url)\t\(.title)"'
```

Panel ids come from the **applied** dashboard, not a local render — by now Task 11 has applied it,
and reading the live copy is what guarantees the link works:

```bash
UID=$(curl -s -H "Authorization: Bearer $GRAFANA_AUTH" \
  "$GRAFANA_URL/api/search?query=ecs-dynamodb-rps-ceiling&type=dash-db" \
  | jq -r '.[] | select(.title | test("attribution")) | .uid')
curl -s -H "Authorization: Bearer $GRAFANA_AUTH" "$GRAFANA_URL/api/dashboards/uid/$UID" \
  | jq -r '.dashboard.panels[] | select(.type!="row") | "\(.id)\t\(.title)"'
```

Panel ids **do** survive apply through the Grafana provider — verified against the live dashboard,
which carries ids 1-17 exactly as committed. Deep-links built on them are stable.

A link is then `$GRAFANA_URL<url>?viewPanel=<id>&from=now-6h&to=now`.

- [x] **Step 2: Write the README**

Structure — each section is one question, answered with a link, a good reading, a bad reading, and what to do:

1. **What is this?** — two paragraphs: a Node service on ECS Fargate over provisioned DynamoDB, built to find the request rate where a class-based SLO breaks, then release one constraint at a time and re-measure. Name the hourly cost.
2. **Is the service up?** — ALB and ECS panels. Good: `HealthyHostCount` equals desired, 2XX dominant.
3. **Are we meeting the SLO?** — SLI panel. "Green above 99%. This is **server-side** and excludes network time, so it reads higher than a number measured from your laptop."
4. **How much error budget is left?** — budget panel, over a 7 d window. Explain what exhausting it means and that the window is 7 d because Grafana Cloud Free retains 14 days — it was not a free choice.
5. **What is the bottleneck right now?** — the attribution row, and the spec §5 table restated in plain words, each row naming the panel that shows it.
6. **Is it about to break?** — the alert rules, and what 14.4×/14m and 6×/84m mean in ordinary language.
7. **What did the last load test show?** — `results.md`, and how to read the two attainment columns.
8. **Appendix — running it yourself.** The existing nine-phase CLI runbook, moved here intact. Demoted, not deleted.

Every number in this file must come from a query run in the same session, quoted with the query — `CLAUDE.md`'s verification rule. Where a measured result does not exist yet, say "not yet measured" rather than leaving a plausible-looking gap.

- [x] **Step 3: Check every link resolves**

```bash
set -a && . ../.env && set +a
grep -oE 'https://[^ )]*grafana[^ )]*' README.md | sort -u | while read -r u; do
  printf '%-100s ' "$u"
  curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $GRAFANA_AUTH" "$u"
done
```
Expected: `200` for each. A `404` means a stale dashboard uid.

- [x] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(ecs-dynamodb-rps-ceiling): rewrite the readme around the reader's question"
```

---

### Task 15: Close out the documents

**Files:**
- Modify: this plan, the 2026-08-31 spec, `docs/superpowers/plans/2026-08-29-ecs-dynamodb-rps-ceiling.md`

- [x] **Step 1: Set this plan's status**

Change the Status line to `complete`, dated, with the table of what shipped and any corrections found during execution recorded in the "what this plan got wrong" style the 2026-08-30 plan uses.

- [x] **Step 2: Hand Tasks 18–23 back**

In `docs/superpowers/plans/2026-08-29-ecs-dynamodb-rps-ceiling.md`, replace the gate banner added on 2026-08-31 with an UNBLOCKED note stating: the attribution table now lives in spec §5; `db_ms`/`cpu_ms`/`el_delay` no longer exist in the k6 summary and those numbers come from Grafana; whether `pbkdf2_iterations` moved (Task 12's verdict); and that Task 22 Step 1 is superseded by the README that now exists.

- [x] **Step 3: Verify no document contradicts another**

```bash
grep -rn "Server-Timing\|/stats" docs/superpowers/ ecs-dynamodb-rps-ceiling/README.md \
  | grep -v "REVERSED\|DELETED\|SUPERSEDED\|no longer\|superseded\|deleted"
```
Expected: no output. Any hit is a document telling the next reader to act on a reversed decision.

- [x] **Step 4: Commit**

```bash
git add -A docs/
git commit -m "docs(ecs-dynamodb-rps-ceiling): close the attribution plan, unblock tasks 18-23"
```

---

## Self-review — spec coverage

| spec section | task |
|---|---|
| A1 — delete `Server-Timing` and `/stats` | 4, 5 |
| A2 — reuse event-loop and memory metrics | 5 (deletion), 10 Step 5 (verification) |
| A3 — two separate histograms | 2 |
| A4 — drop `app` | 4 Step 3 |
| A5 — both DB clocks, gap is the signal | 7 (`queueing_ms_by_route`), 8 |
| A6 — cpu saturation against vCPU | 7 (`cpu_saturation_ratio`), 8 |
| A7 — k6 as a pure gate | 9 |
| A8 — generated query set | 7 |
| A9 — question-led README | 14 |
| A10 — `pbkdf2_iterations` | 1, 12 |
| §4 — `AwsInstrumentation` | 6 |
| §4 — `/stats` out of `SCOPE` | 7 Step 4 |
| §7 — dashboard panels | 8 |
| §9 — `/loadtest` | 13 |
| §10 — testing | 2, 3, 4, 5, 7 |
| §11 risk 1 — container rebuild | 10 |
| §11 risk 5 — CloudWatch rows survive | 8 Step 4 |
| §13 — amendment map | 15 |

**Observing the attribution table (§10) is deliberately *not* a task here.** It requires load, and load is Task 18 of the 2026-08-29 plan. Task 15 Step 2 hands that requirement forward explicitly.
