# ecs-dynamodb-rps-ceiling — attribution via metrics

- **Date:** 2026-08-31
- **Status:** **complete** (2026-08-31) — **except §5, whose attribution table was deleted on
  2026-09-01.** Everything this document built is live and unaffected: the three OpenTelemetry
  histograms, the removal of the `Server-Timing` header and the `GET /stats` endpoint, and the
  generated shared query set. What is void is the *model* §5 wrapped around them — it misattributed a
  DynamoDB throttling event to the service on its first real test. Read the banner at §5 before using
  anything in that section.
  Plan: `docs/superpowers/plans/2026-08-31-ecs-dynamodb-rps-ceiling-attribution-via-metrics.md`,
  executed and deployed. Every decision A1–A10 shipped as written, with one addition made during
  execution: **Task 10b**, fixing a pre-existing `NaN` in the SLO query that only appears with more
  than one instance — see that plan's status header.
  > Project renamed to `ecs-dynamodb-rps` on 2026-09-03; paths and names below are pre-rename. See `docs/superpowers/specs/2026-09-02-ecs-dynamodb-rps-restructure-design.md`.
- **Project directory:** `ecs-dynamodb-rps-ceiling/`
- **Amended by:** `docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-attribution-simplified-design.md`
  (2026-09-01), which **deletes the four-row attribution table in §5** after it misattributed a
  DynamoDB throttling event to the service, and replaces it with two metrics read side by side:
  request latency, and DynamoDB throttle events. A pointer sits at the table itself — do not rely on
  this line alone. Everything else in this document stands.
- **Amends:** `docs/superpowers/specs/2026-08-29-ecs-dynamodb-rps-ceiling-design.md` (reverses **D10**)
  and `docs/superpowers/specs/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection-design.md` (§11).
  See §13 for the decision-by-decision map. Neither is superseded.
- **Supersedes:** **Task 22 Step 1** of `docs/superpowers/plans/2026-08-29-ecs-dynamodb-rps-ceiling.md`
  (the README write-up). That step is replaced by §8 below, not amended.
- **Blocks:** Tasks 18–23 of the 2026-08-29 plan. This must land **before** Task 18 — see §11.

> **Decisions here are numbered `A1…A10`,** continuing neither `D1…D10` (2026-08-29) nor `S1…S12`
> (2026-08-30). Three documents describe this project; a decision reference must resolve to exactly
> one row, forever.

---

## 1. Purpose

The service currently publishes two things over HTTP that are not business responses: a
`Server-Timing` header on every response, and a `GET /stats` endpoint. Both exist to carry
measurement data to k6. Neither belongs on a service's public surface, and both predate the
metrics pipeline that S1–S12 built.

This document moves every measurement signal into the OpenTelemetry pipeline, deletes the two HTTP
surfaces, and — because the move forces it — **rewrites the attribution model that the 2026-08-29
plan already flags as unreachable**.

### Success criteria

1. No response carries a `Server-Timing` header. `GET /stats` returns 404. `GET /healthz` still 200.
2. Per-route DB and CPU time are queryable in Grafana, with the same `class` labels as the SLI.
3. Every row of the attribution table in §5 is falsifiable from metrics, and at least one row is
   **observed** during the discovery run rather than assumed.
4. A non-technical reader can answer "are we meeting the SLO?", "what is the bottleneck?" and "is it
   about to break?" from Grafana links in the README, without a terminal.

### What was measured before writing this

Verified live against Grafana Cloud on 2026-08-31, environment up in `eu-central-1`:

- `nodejs_eventloop_delay_p99_seconds{job="ecs-dynamodb-rps-ceiling"}` = **0.010903551**, labelled by
  `instance` (ECS task id). The same instant, `GET /stats` returned p99 **10.797 ms**. The signal
  `/stats` exists to expose is *already in Grafana* and has been since the collector shipped.
- `v8js_memory_heap_used_bytes` is present, covering `/stats`'s `memoryMb`.
- Series under `job="ecs-dynamodb-rps-ceiling"`: `http_server_request_duration_seconds`, the
  `nodejs_eventloop_*` family, the `v8js_*` family, `target_info`. **No `db`, `cpu`, or `aws_*`
  series exist.**
- The dashboard has **35 CloudWatch targets and zero panels on service-emitted metrics**.

Two consequences drove the design: `/stats` is pure duplication and needs no replacement instrument,
while the DB/CPU split is genuinely new work.

---

## 2. Decisions and why

| # | decision | why |
|---|---|---|
| A1 | **Delete `Server-Timing` and `GET /stats`.** No measurement leaves the service over HTTP. | A response header is a transport for the client's benefit; k6 was the only client and k6 is a test harness, not a consumer. The pipeline that replaced the SLI (S1–S12) is the right transport for everything else too. |
| A2 | **Event-loop lag and memory are reused, not rebuilt.** `RuntimeNodeInstrumentation` already emits them. | Verified flowing (§1). Building a custom histogram would duplicate a live metric to gain a fleet-wide query-time percentile — and for knee detection `max by (instance)` over four tasks is *more* informative, because it shows the imbalance a blended percentile hides. `src/otel.js` already said this: *"superseding the /stats poll — which stays anyway, because the k6 scripts are frozen."* They are no longer frozen; nothing has been measured. |
| A3 | **Two new exponential histograms — `http.server.db.duration` and `http.server.cpu.duration`.** Not one metric with a `phase` label. | A single name holding two distributions with different shapes means any query that omits the `phase` selector silently averages unlike things. Two names cost nothing and cannot be misread. |
| A4 | **`app` is dropped.** | It existed only as the base for `other = app − db − cpu`. That remainder is one subtraction at query time — `histogram_sum(rate(http_server_request_duration_seconds{…}[60s])) − histogram_sum(rate(http_server_db_duration_seconds{…}[60s])) − histogram_sum(rate(http_server_cpu_duration_seconds{…}[60s]))`. One fewer hot-path timer for a value one subtraction away. **Corrected 2026-09-01:** this row originally wrote that as `rate(request_sum) − rate(db_sum) − rate(cpu_sum)`, which is wrong for the native histograms the service actually emits — there is no `_sum` series, and that form returns "success" while matching nothing, forever. |
| A5 | **In-process `db` is kept AND CloudWatch `SuccessfulRequestLatency` stays the clean clock.** | In-process `db` wraps an `await` and absorbs event-loop queueing (measured 12.1× inflation, DB unchanged). That is not a defect to hide — **the gap between the two clocks is the queueing measurement**, and queueing is precisely the service-bound-vs-DB-bound discriminator. Neither number alone is attribution; the pair is. |
| A6 | **`histogram_sum(rate(http_server_cpu_duration_seconds{…}[60s]))` against the vCPU allocation is the saturation measure.** | CPU-seconds consumed per wall-second per task. Against 0.25 vCPU, approaching 0.25 *is* saturation — absolute, not relative. Underivable before: k6's `cpu_ms` gave per-request cost, never utilization. **Corrected 2026-09-01:** originally written `rate(http_server_cpu_duration_seconds_sum)`. The instrument is a NATIVE histogram, so no `_sum` series exists and that query would have matched nothing while reporting success; the sum comes out of the single native series via `histogram_sum`. **Sufficient, not necessary** — see the caveat under §5's table. |
| A7 | **k6 becomes a pure gate.** It records only what a client can observe. | Removes the last piece of service surface that exists for the load generator's benefit. Consistent with S-series moving the SLI off k6. |
| A8 | **Attribution queries are generated from `slo.yaml`, like everything else.** One definition, three consumers: dashboard panels, `/loadtest`, README deep-links. | The drift this project keeps rediscovering. `generate-slo.js` already renders **five** outputs — `k6/lib/slo.js`, `terraform/capacity.auto.tfvars`, `grafana/classmap.json`, `grafana/alerts.tf`, `grafana/locals.tf` — and `npm run slo:check` byte-checks every one. `queries.json` is the sixth, not a new mechanism. |
| A9 | **The README is organised by question, not by phase.** CLI is demoted to an appendix. | The current README is a nine-phase operator runbook. Someone asking "is it healthy?" should not read a Terraform command to find out. |
| A10 | **`pbkdf2_iterations` stays at 2662 unless a fixed-rate run moves p99 beyond noise.** | See §11 risk 2. Churning it changes the service ceiling and makes runs incomparable — a worse error than a sub-1% CPU drift. |

---

## 3. What the service emits

Three histograms, sharing `buildViews()` (exponential, `maxSize: 160`) and one attribute set:

| instrument | unit | records |
|---|---|---|
| `http.server.request.duration` | s | unchanged — callback start to response finish. **The SLI.** |
| `http.server.db.duration` | s | wall-clock around the AWS SDK `await`, summed per request |
| `http.server.cpu.duration` | s | wall-clock around the synchronous block, summed per request |

Attributes on all three, identical: `http.route` (template, never a concrete path),
`http.request.method`, `http.response.status_code`, `traffic_source`. `class` is **not** set by the
service — Alloy applies it from `grafana/classmap.json`. **The collector needs no change at all:**
the generated OTTL statements run at `context = "datapoint"` and are keyed solely on
`attributes["http.route"]`, with no metric-name condition (`terraform/collector.tf:94`), so any
datapoint carrying a route template is classified — including the two new histograms, for free.

`createTimer()` keeps `measure` / `measureSync` unchanged; handlers are untouched. Only the sink
moves: `marks` are read by `recordRequest` instead of being stringified by `header()`, which is
deleted.

A request may make more than one DB call — `/reports` issues `Query` then `PutItem`. `marks` already
accumulates per phase name, so `db` is the per-request **sum**. This is deliberate and §5 depends on
it.

**Reused as-is:** `nodejs_eventloop_delay_{p50,p90,p99,max}_seconds`,
`nodejs_eventloop_utilization_ratio`, `v8js_memory_heap_used_bytes`.

---

## 4. What is deleted

| deleted | where | note |
|---|---|---|
| `Server-Timing` header | `src/server.js`, `src/timing.js` `header()` | |
| `GET /stats` route | `src/handlers.js` ROUTES | `/healthz` **stays** — ALB target-group health check (`alb.tf:21`) |
| `src/stats.js` | whole module | `monitorEventLoopDelay` duplicated by `RuntimeNodeInstrumentation` |
| `stats` scenario | `k6/constant.js`, `k6/discovery.js`, `k6/stress.js` | |
| `parseServerTiming`, `dbMs`, `cpuMs`, `appMs`, `elDelay`, `pollStats` | `k6/lib/request.js` | |
| `AwsInstrumentation` | `src/otel.js` | **Conditional.** It emits no series under this job despite the code claiming call counts, errors and retries. The plan verifies whether that is a config fault before deleting; a dead component goes, a misconfigured one gets fixed. |
| `/stats` from the `SCOPE` selector | `scripts/generate-slo.js`, the `SCOPE` constant | The route ceases to exist, so the exclusion becomes `http_route!~"/healthz"`. Change it **in the generator** and regenerate — `alerts.tf` and `locals.tf` are generated files. The population is already selected on `class`, so this is documentation of intent, not load-bearing. |

---

## 5. The attribution model

### The derived signal

```
queueing(route) ≈ 1000 * histogram_sum(rate(http_server_db_duration_seconds{http_route=R}[60s]))
                       / histogram_count(rate(http_server_db_duration_seconds{http_route=R}[60s]))
                − Σ SuccessfulRequestLatency{dimension_Operation=op}  for op in operations(R)
```

**Corrected 2026-09-01.** This block originally read
`rate(http_server_db_duration_seconds_sum[60s]) / rate(..._count[60s]) − SuccessfulRequestLatency`.
Both halves were wrong and both fail silently:

- **`_sum` / `_count` do not exist.** The instrument is a NATIVE histogram — one series carrying the
  whole distribution. `rate(X_sum[60s])` parses, the API answers `"success"`, and it matches nothing
  forever. `histogram_sum(rate(X{…}[60s]))` and `histogram_count(...)` are the real accessors.
- **The subtrahend is per route, and it is a SUM over that route's operations.** Written without a
  route, it invites the implementation this spec actually shipped: one
  `avg(SuccessfulRequestLatency{dimension_TableName=…})` over every operation on the table,
  subtracted identically from all four routes. Measured live 2026-09-01: GetItem 0.912 ms, PutItem
  2.018 ms, Query 1.1625 ms, and BatchWriteItem 0 (`scripts/seed.js`, not request traffic — its zero
  drags the mean down). That average was **1.01 ms** where `/reports` needs Query + PutItem =
  **2.79 ms**: a ~1.8 ms error on a signal whose entire job is detecting a few ms of queueing.

Three properties the implementation must encode, each of which silently produces a wrong number if
missed:

1. **Units differ.** CloudWatch `SuccessfulRequestLatency` is **milliseconds**; the histogram is
   **seconds**.
2. **Resolution differs.** The service exports every **15 s** (`OTEL_EXPORT_INTERVAL_MS`); Alloy
   scrapes CloudWatch every **60 s** and DynamoDB publishes at 60 s. The comparison is evaluated on
   60 s windows.
3. **`SuccessfulRequestLatency` counts only successful calls.** Once throttling begins the gap stops
   being interpretable — acceptable, because throttling has already answered the question.

Route → operation mapping: `/items/:pk/:sk` → `GetItem`; `POST /items` → `PutItem`; `/feeds/:pk` →
`Query`. `/reports` issues `Query` **and** `PutItem`, so its `db` sum compares against the sum of both
operations (§3). That mapping lives in `slo.yaml` under `attribution.operations` and is the *input to
the generated query*, not documentation of it: `queueingExpr` in `scripts/generate-slo.js` renders one
term per classified route, each subtracting `sum()` of exactly that route's operations, `or`-joined so
a route with no traffic drops out instead of emptying the result. `loadSlo` refuses a classified
endpoint with no `operations` entry, so the mapping cannot be quietly incomplete.

### The table

> ### ⛔ DELETED 2026-09-01. Do not use this table.
>
> Replaced by two plainly-read metrics in
> `docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-attribution-simplified-design.md`:
> **request latency** (`http_server_request_duration_seconds`, unchanged) and **DynamoDB throttle
> events** (`ReadThrottleEvents` / `WriteThrottleEvents`, per-minute counts of rejected requests at
> table level). Nothing computes a bound resource any more.
>
> **Why: evaluated once against a case whose answer was known, this table gave the opposite answer.**
> Driven at 250 requests/second against a table provisioned at 25 read capacity units, with DynamoDB
> rejecting **5,588 reads per minute**, it matched the *service* row on every signal — including the
> event-loop fallback added below to make that row robust. Measured mid-throttle: `ThrottledRequests`
> **0** (it is a per-60s gauge and reads zero between throttling minutes),
> `SuccessfulRequestLatency` **0.887 ms — below its 1.473 ms idle value**, the queueing gap
> **642–938 ms**, `nodejs_eventloop_utilization_ratio` **1.000**, CPU **3–16%**.
>
> The three failures are structural, not fixable by reordering the rows:
>
> 1. `ThrottledRequests` reads zero at instants during sustained throttling, and is published only
>    with a `TableName`+`Operation` dimension pair — so the table-level CLI form used below matches
>    nothing, forever.
> 2. `SuccessfulRequestLatency` **falls** when DynamoDB throttles, because rejected requests are
>    never served and so never enter the statistic. The database row requires it to climb, so that
>    row cannot match a capacity event at all.
> 3. Every service-row signal is downstream of throttling: SDK retries with backoff are held inside
>    Node, inflating both the queueing gap and event-loop utilization while consuming almost no CPU.
>
> The rest of this document stands — the three histograms, the deletion of `Server-Timing` and
> `GET /stats`, and the generated query set are all unaffected.

~~This **replaces** the table at Task 18 Step 7 of the 2026-08-29 plan, whose service-bound row
(`db_ms` flat while lag climbs) can never occur.~~

| observation | bound resource | the knob |
|---|---|---|
| `ThrottledRequests > 0` | DynamoDB capacity | raise RCU/WCU (Task 21) |
| Throttled = 0, **`SuccessfulRequestLatency` climbing** | DynamoDB server-side | item size / hot partition — not a capacity knob |
| Throttled = 0, SRL flat, **gap climbing**, `nodejs_eventloop_utilization_ratio` → 1, `histogram_sum(rate(http_server_cpu_duration_seconds{…}[60s]))` → 0.25/task | service CPU / event loop | scale out 1→4 tasks (Task 20) |
| all of the above flat, ALB `TargetResponseTime` rising, `HealthyHostCount` < desired | edge / deployment | not a capacity story |

Every row is falsifiable, and no row requires `db` to be a clean clock.

**The CPU term is SUFFICIENT, not NECESSARY** (added 2026-09-01, and the same caveat is on dashboard
panel 23). `http.server.cpu.duration` sums only the two explicitly bracketed synchronous blocks in
`src/handlers.js:57,64`. JSON serialisation, AWS SDK marshalling, the OTel export itself, and every
other bit of compute on the request path are **not** counted, and `getItem`/`putItem` bracket nothing
at all, so they mint no `cpu` series. `cpu_saturation_ratio` reaching 1.0 therefore proves the task is
CPU-bound; it reading 0.2 proves nothing — a task can be genuinely pinned while this panel sits low.
When the row's other three signals point at the service, treat a low CPU ratio as *unaccounted* CPU,
not as *absent* CPU, and fall back to `nodejs_eventloop_utilization_ratio` and ECS
`CPUUtilization`, which measure the whole process. Widening the brackets would be a service change
with its own measurement; it is deliberately not made here.

---

## 6. The shared query set

`slo.yaml` gains an `attribution:` block. `generate-slo.js` gains a **sixth** entry in its `OUTPUTS`
table — `grafana/queries.json` — carrying every query in §5 plus the SLI and budget queries, each
with a stable key. The five existing outputs are untouched.

Three consumers read it:

- **the dashboard**, via `templatefile` — panels stop being hand-maintained JSON;
- **`/loadtest`**, for the server-side `results.md` columns;
- **the README**, for deep-links (§8).

`npm run slo:check` byte-checks it, exactly as it does the other five. A route present in
`classmap.json` with no attribution query is a test failure.

---

## 7. Dashboard

The dashboard is already Terraform-managed — `grafana_dashboard "attribution"` in `grafana/folder.tf`,
with `config_json = file("${path.module}/dashboard.json")`. Generating it is a `file()` →
`templatefile()` change at that one line.

Two new rows, generated from `queries.json`:

**SLI** — per-class latency distribution, the SLI ratio as the alert rules compute it, error budget
remaining over the 7 d window.

**Attribution** — db-wall vs `SuccessfulRequestLatency` with the gap called out; `rate(cpu_sum)`
against the 0.25 vCPU ceiling; `nodejs_eventloop_delay_p99` and `max` **`by (instance)`**;
`nodejs_eventloop_utilization_ratio` **`by (instance)`**.

Per-instance breakdown is not decoration: it is what makes the 1→4 task step of Task 20 legible, and
a blended fleet percentile would hide exactly the imbalance that step creates.

The existing five CloudWatch rows are unchanged.

---

## 8. README — the runbook, restructured

**Supersedes Task 22 Step 1 of the 2026-08-29 plan.**

Organised by the question a reader arrives with. Each section: a Grafana deep-link, what a good
reading looks like, what a bad one looks like, and what to do about it.

- *Is the service up?* → ALB / ECS panels
- *Are we meeting the SLO?* → SLI panel — "green above 99%; server-side, excludes network"
- *How much error budget is left?* → budget panel, and what exhausting it means
- *What is the bottleneck right now?* → attribution row, and the §5 table in plain words
- *Is it about to break?* → alert rules, and what each burn rate means in ordinary language
- *What did the last load test show?* → `results.md`

Deep-links are **generated** alongside the queries: a hand-typed `viewPanel` id rots the moment a
panel moves, and a rotted link in a runbook is worse than no link.

The nine-phase CLI runbook survives as an appendix for the operator path. Demoted, not deleted.

---

## 9. k6 and `/loadtest`

k6 keeps only what a client can observe: `http_req_duration`, `http_req_failed`, `slo_met`,
`slo_met_tail`. Before touching anything, the plan confirms the generated thresholds in `renderK6`
reference only `slo_met` and not the deleted trends.

`/loadtest` gains the query step from §6 and two `results.md` columns — **`bound resource`** and
**`queueing ms`** — alongside the existing `k6 attainment` / `service attainment` pair. `GRAFANA_AUTH`
becomes required rather than optional; it was verified working against the datasource proxy on
2026-08-31. Note `K6_PROMETHEUS_RW_*` is write-scoped and returns `invalid scope requested`, which a
naive parser reads as "no data".

---

## 10. Testing

Terraform HCL is configuration and gets `fmt -check` → `validate` → reviewed `plan`, not unit tests.
The code does get tests.

**Unit** (`node:test`, in-memory metric reader):

- `recordRequest` writes db and cpu to the right instruments with the right attributes;
- two DB calls in one request sum into a single `db` value (the `/reports` case);
- `matchRoute('GET', '/stats')` returns `null`;
- `generate-slo.js` emits `queries.json` deterministically; `--check` fails on drift;
- every route in `classmap.json` has an attribution query.

**Integration** (existing pinned `dynamodb-local:2.5.2` compose): no `Server-Timing` header on any
response; `/stats` → 404; `/healthz` → 200.

**The measurement analogue of red-green.** §5's table is a set of predictions. The plan includes a
step that drives the service deliberately into the CPU-bound row and confirms the four discriminators
read as predicted. This costs no extra VU-hours — it happens during the discovery run regardless. A
table nobody has watched fire is a table nobody should trust.

---

## 11. Sequencing, risks, rollback

**This lands before Task 18.** Once baselines B and C exist the k6 scripts are frozen by the
2026-08-29 plan's Global Constraints, and making this change afterwards invalidates every recorded
row. Nothing has been measured yet. This is the last free moment.

| # | risk | handling |
|---|---|---|
| 1 | **Terraform does not rebuild the container image.** A `src/` change with no build/push/force-new-deployment leaves the collector receiving nothing from a service that is healthy by every other indicator. | Explicit build/push/force-new-deployment task step, and a post-deploy Grafana query confirming the new series exist with `class` labels. This exact omission cost a full debugging cycle in the 2026-08-30 plan. |
| 2 | **`pbkdf2_iterations` may drift.** Removing header construction and adding two `record()` calls changes hot-path CPU. | `scripts/calibrate.js` measures `burn()` in isolation and **cannot observe instrumentation cost at all**, so recalibrating it proves nothing. The honest check is a fixed-rate run comparing p99 before and after. Per A10, leave 2662 alone unless that comparison moves beyond noise. |
| 3 | **`AwsInstrumentation` emitting nothing may be a config fault rather than a dead component.** | Verify before deleting. If removal shifts CPU, it folds into risk 2. |
| 4 | **Cardinality.** | Three native histograms × ~4 routes × ≤5 `traffic_source` × ≤4 instances ≈ 240 series against a 10,000 active-series ceiling. A non-issue, recorded so nobody re-derives it. |
| 5 | **Generated dashboard replaces hand-written JSON.** | The existing five CloudWatch rows must survive the move byte-equivalent; the plan diffs the rendered output against the committed `dashboard.json` before applying, the same way Task 1 of the 2026-08-30 plan proved the SLO generator faithful. |

**Rollback** is a redeploy of the previous task-definition revision plus a Terraform revert of the
Grafana module. No state, no data, no DynamoDB involvement. Cheap and complete.

**Cost:** no new AWS resources. OTLP volume rises with two more histograms; within free tier.

---

## 12. Out of scope

- **Fixing `db`'s contamination in-process.** Separating queueing from DB time around an `await` is
  not solvable in-process; A5 makes the contamination a measurement instead of a defect.
- Tracing, spans, `auto-instrumentations-node`.
- Moving CPU work to worker threads — a legitimate future "change one thing", not this one.
- Renaming or restructuring the CloudWatch dashboard rows.

---

## 13. Amendment map

### `docs/superpowers/specs/2026-08-29-ecs-dynamodb-rps-ceiling-design.md`

| where | change |
|---|---|
| **D10** (§2 decisions table) | **REVERSED.** `Server-Timing` + `/stats` are deleted; attribution moves to OTel instruments plus CloudWatch. Forward-pointer added at the row. |
| **§5 "Attribution instrumentation (D10)"** | Superseded in full by §3–§5 here. The existing amendment banner is extended. |
| **§8**, the 1 RPS `stats` scenario | Deleted. See §4. |
| **§9**, the run A/B narrative | Its evidence clauses ("`db_ms` stays flat", "event-loop lag stays flat") are restated against §5's table. The *sequence* — service binds first, then DB — is unchanged. |
| **§9**, the `results.md` field list | `db_ms`/`cpu_ms` split and event-loop lag now come from Grafana, not k6; adds `bound resource` and `queueing ms`. |

### `docs/superpowers/specs/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection-design.md`

| where | change |
|---|---|
| **§11** | Confirmed and extended: `AwsInstrumentation` does not merely fail to fix attribution, it emits nothing at all under this job. See A2 and risk 3. |
| S1–S12 | **All stand.** This document extends the pipeline they built; it reverses nothing in it. |

### `docs/superpowers/plans/2026-08-29-ecs-dynamodb-rps-ceiling.md`

| where | change |
|---|---|
| **Task 18 Step 7** attribution table | Replaced by §5. The plan's own "Open issues" section already says it cannot work as written. |
| **Task 22 Step 1** | **Superseded** by §8 — a rewrite, not an amendment. |
| Tasks 1–17 | Stand. Tasks 3, 4, 15 and 16 built things this document deletes; that is a reversal of a decision, not an invalidation of executed work. |
| Tasks 18–23 | Remain unblocked, and now additionally gated on this document's plan. |
