# Research — `ecs-rds-postgres-pool`

Status: **superseded in part** by `docs/superpowers/specs/2026-09-19-ecs-rds-postgres-pool-design.md`
(2026-09-19), which settles D5 and D7 and corrects C2, C6 and research question 3. The rest of this
document still stands and the spec builds on it. Forward-pointers are attached at each superseded
decision below.
Created: 2026-09-04 (placeholder) · Researched: 2026-09-11 · Revised: 2026-09-11 after review
Next step: execute `docs/superpowers/plans/2026-09-20-ecs-rds-postgres-pool-service.md` (plan 1 of 4,
approved 2026-09-20). Plans 2–4 are written as the work reaches them.

## Decisions made on review, 2026-09-11

Recorded on the review page <https://claude.ai/code/artifact/6f818fbd-e1bd-47cd-86cc-bfe7adefa251>.
Everything below this section is written to match them.

| # | question | answer |
|---|---|---|
| D1 | What is the SLI? | **Unchanged** — class thresholds + availability; pool wait is evidence, not an objective |
| D2 | Instance class | **db.t4g.micro, autoscaling off** — "minimal one, and use auto-scaling after to improve it", so ECS autoscaling is an optional third knob at the end |
| D3 | How the pool binds | **Real query cost**, calibrated — on the deployed instance, not locally |
| D4 | Migrations and seed | **On service boot, behind a flag** |
| D5 | Second knob | ~~open~~ → **answered 2026-09-19**, and none of the three options below was chosen: the knob is a three-step sequence, `pool_size` 5→25, then `desired_count` 1→4 (100 connections against a ~112 ceiling), then the proxy. See the design spec, "The knob sequence" |
| D6 | Fork depth | **Keep the shape, design the SQL workload on its own terms** |
| D7 | Pool wait under Prisma | ~~open~~ → **answered 2026-09-19**: option (a), own the `pg.Pool` through `@prisma/adapter-pg` and attribute per request with `AsyncLocalStorage`. Options (b) and (c) are impossible — Prisma's metrics feature was removed in v7. See the design spec, "Prisma's metrics feature has been removed" |

Three further instructions from the same review, applied throughout:

- **Prisma, not raw `pg`.** Changes C2, C3, research question 3, and creates D7.
- **No local test runs.** Everything is exercised on the deployed instance; there is no integration
  suite and no local Postgres. The cost is that a schema or pool mistake surfaces after an apply and
  a deploy rather than immediately — smaller than it looks, because Prisma removes the connection
  leak that test was mainly for.
- **Both knobs wired in from the first apply.** `pool_size` and `proxy_enabled` are Terraform
  variables and the proxy resources are `count`-gated, so releasing either knob is a `dev.tfvars`
  edit and an apply: no code change, no image rebuild, no redeploy.

This is still not a spec. It is the answer to the six questions the placeholder listed, plus the
technical challenges that came out of answering them, plus a proposed split of the work. Nothing
here has been measured; every number below is either a documented AWS value, a value read out of
`ecs-dynamodb-rps`, or an estimate explicitly labelled as one.

---

## The short answer

**Postgres does announce itself — just not per request.** The placeholder assumed there was no
analogue to DynamoDB's `ThrottledRequests`. There is one, and it is better than a throttle count:
Performance Insights publishes `DBLoad`, `DBLoadCPU`, `DBLoadNonCPU` and
**`DBLoadRelativeToNumVCPUs`** to CloudWatch under `AWS/RDS` with dimension `DBInstanceIdentifier`,
automatically, with no agent, at the 7-day retention that is free. `DBLoad` is average active
sessions; `DBLoadRelativeToNumVCPUs` is that divided by the instance's vCPU count, so **above 1.0
means more sessions are runnable than the database has CPUs to run them** — the database saying "I
am the constraint", in one number, read live from CloudWatch exactly the way the throttle panel and
the throttle alert rules in `ecs-dynamodb-rps/infra/grafana/throttles.tf` already read theirs.

It carries the same trap as the throttle metrics, for the same reason: AWS publishes these
"only if there is load on the DB instance", so a quiet minute produces **no datapoint, not a zero**.
Every reading rule that file already encodes — `no_data_state = "OK"`, a 300 s lookback,
`reduce(last)` rather than a math expression across two queries — transfers unchanged.

So the attribution story for this project is three numbers read side by side, which is one more than
`ecs-dynamodb-rps` has and no more complicated:

| what it answers | where it comes from |
|---|---|
| how long did the request take | `http.server.request.duration` — the existing OTLP histogram |
| **did we wait for a connection** | in-process, but *how* is D7 — Prisma owns the pool (see C2) |
| **was the database itself saturated** | `DBLoadRelativeToNumVCPUs`, CloudWatch `AWS/RDS`, live |

Nothing computes a verdict from them, matching the rule `ecs-dynamodb-rps/README.md` states for the
throttle panel: a person reads request latency, pool wait and DB load next to each other.

---

## The three queues

A request that is slow here waited in one of three places, and they are in series:

```
k6 ──▶ ALB ──▶ [1] Node event loop ──▶ [2] pool checkout queue ──▶ [3] Postgres backend
                    │                        │                          │
             eventloop.delay p99       pool wait (new, D7)      DBLoadNonCPU / DBLoadCPU
             (already collected)       queries waiting          DatabaseConnections
```

`ecs-dynamodb-rps` measures [1] and, by subtracting DynamoDB's own clock from its `db` phase, gets a
queueing estimate. Here [2] is measured directly and [3] is read from the database. The subtraction
trick is not needed and not available — there is no per-operation server-side latency for Postgres.

---

## Main technical challenges

Ranked by how much of the project they can invalidate.

### C1 — Making the pool the binding constraint at a rate you can actually generate

The hardest problem, and it is not an observability problem. By Little's law a pool of 5 with a 2 ms
query serves **2,500 queries/second**; with 1 ms it serves 5,000. The k6 org cap is 100 VUs
(`ecs-dynamodb-rps/infra/k6/main.tf` documents that the 100 comes from a subscription limit, not from
`vu_max_per_test`), and the ALB and a 0.25 vCPU Fargate task will break long before that. So with a
naive point-select workload **the pool is never the bottleneck and the project measures nothing.**

The analogue is `pbkdf2_iterations` in the sibling project — a calibrated cost knob that puts the
service ceiling at a known fraction of the database ceiling. Here the knob has to sit *inside the
connection's hold time*, because that is what pool occupancy is: query cost, page size, row width,
or an explicit server-side cost. Concretely, for a pool of 5 to bind at ~250 rps of database-touching
traffic, mean hold time must be ~20 ms (5 / 0.020 = 250).

**This calibration must happen before the class thresholds in `slo.yaml` are frozen**, because the
thresholds are what the k6 VU sizing is derived from, and it is what decides whether `fast < 50 ms`
is even reachable. Per the 2026-09-11 review it is done **on the deployed instance, against real CPU
consumption** — not locally — which is the same thing the sibling did for `pbkdf2_iterations` (two
one-off Fargate runs, 0.23% apart). The calibration target is not hold time alone but a
relationship: **at the intended knee the pool must bind first while database CPU still has
headroom**, roughly `DBLoadRelativeToNumVCPUs ≈ 0.5` at `pool_size = 5`. That is the whole experiment
in one number — it is what makes releasing the pool in the next phase move the bottleneck to the
database, instead of finding both saturated at once with no way to tell them apart.

### C2 — Prisma owns the pool, so there is no checkout to wrap

> **Superseded 2026-09-19 — the resolution below does not exist any more.** This section's answer is
> that "Prisma publishes the number instead", via `prisma_client_queries_wait_histogram_ms` behind
> `previewFeatures = ["metrics"]`. That feature was deprecated in Prisma ORM 6.14.0 and **removed in
> 7.0.0**; npm today offers `prev: 7.10.0` and `latest: 8.0.0-rc.15`, so no pinnable version has it.
> The premise of the section still holds — Prisma does own the pool — but the way out is the one
> Prisma's own upgrade guide gives: reach the pool through `@prisma/adapter-pg` (confirmed at 7.10.0
> to accept a `pg.Pool` the application constructs) and time checkout yourself. See
> `docs/superpowers/specs/2026-09-19-ecs-rds-postgres-pool-design.md`, "Queue [2]: per-request pool
> wait".

With raw `pg` the measurement was a three-line wrap of `pool.connect()`. Prisma has no equivalent
call: you hand it a query and it decides, internally, when a connection becomes available.
`timer.measure('pool', …)` has nothing to bracket.

**Prisma publishes the number instead.** With `previewFeatures = ["metrics"]` the client exposes
`prisma_client_queries_wait_histogram_ms` — the distribution of time queries spent waiting for a
connection, which is `wait_for_pool_ms` already built — alongside `prisma_client_queries_wait` (how
many are waiting now), `prisma_pool_connections_open`, `_idle` and `_busy`, reachable through
`prisma.$metrics.prometheus()` or `.json()`.

The catch is that those are **process-global, not per route or per class**. This project's SLI is a
per-class ratio and what a run has to answer is *which class* the queue hurt, so a global histogram
says a queue existed but not whose requests were in it. Whether that is acceptable, or whether the
pool is reached through a driver adapter (`@prisma/adapter-pg`) so the wait can be attributed per
request via `AsyncLocalStorage`, is **decision D7**. One thing gets simpler either way: Prisma
manages checkout and release itself, so the connection-leak class of bug — and the unit test that was
going to be needed to catch it — disappears, which is most of why dropping the local test suite costs
less than it would have.

### C3 — The wait measures two things it does not name

Any wait measured around an `await` **includes event-loop queueing by construction** — already
documented on `DB_DURATION` in `ecs-dynamodb-rps/service/src/otel.js`, and honest as long as it is
stated. The contaminant that is not honest is the second one: when the pool has no idle connection
and is still below its limit, acquiring one opens a **new physical connection** — TCP, TLS and
Postgres authentication, tens of milliseconds — and that lands in the same number as "queued behind
four other requests". Opposite diagnoses, one series.

Prisma opens connections lazily too, so the same contamination lands in
`prisma_client_queries_wait_histogram_ms`. Two mitigations survive the move:

- **Pre-warm at boot.** Issue `connection_limit` concurrent trivial queries — or warm the adapter's
  own pool, under D7 — before the server starts listening, so no measured request pays for
  establishment.
- **Watch `prisma_pool_connections_open`.** It rises exactly when a connection is being created, so a
  wait spike that coincides with it is setup and one that does not is a real queue. This pair
  replaces node-postgres's `onConnect` hook and answers the same question.

What is lost is `idleTimeoutMillis: 0`. The idle-TLS effect the sibling README records — ~3% of idle
fast-class requests missing 50 ms on a reaped socket — is *preventable* under raw `pg` and only
mitigable under Prisma's own pool.

### C4 — RDS Proxy moves the wait out of the process (research question 4, answered)

Yes, it does, and yes, there is a witness. RDS Proxy publishes to CloudWatch `AWS/RDS` with
dimensions `DBProxyName` (+ `TargetGroup` for the pool metrics):

| metric | what it says |
|---|---|
| `DatabaseConnectionsBorrowLatency` | time to get a database connection from the proxy's pool — the proxy-side `pool.duration` |
| `DatabaseConnectionsCurrentlyBorrowed` | connections in use, i.e. the proxy's occupancy |
| `MaxDatabaseConnectionsAllowed` | the ceiling the proxy will open against the instance |
| `DatabaseConnectionsCurrentlySessionPinned` | connections pinned — see below |
| `ClientConnections` | connections from the app tasks into the proxy |

So the before/after comparison survives, **but the "after" row reads a different metric than the
"before" row** (in-process `pool.duration` vs. proxy `DatabaseConnectionsBorrowLatency`), and
`results.md` has to say so on the row rather than implying one series continued.

Two things to settle before that phase:

- **The unit of `DatabaseConnectionsBorrowLatency` is not reliably documented.** AWS's own metric
  table lists `QueryDatabaseResponseLatency` in microseconds; community reports discuss borrow
  latency in milliseconds. Confirm against the CloudWatch console on the real proxy before a panel
  or a threshold is built on it — a 1000× error here is silent and looks like a spectacular result.
- **Session pinning silently turns the proxy back into a passthrough.** When a client uses a feature
  the proxy cannot multiplex, the connection is pinned for the session and
  `DatabaseConnectionsCurrentlySessionPinned` rises. A proxy run with everything pinned measures a
  proxy that is not pooling. This needs a panel and an alert, not a hope.

**And the honest expectation should be written down before the run.** RDS Proxy exists for many
short-lived clients — Lambda. Against 1–4 long-lived ECS tasks that already hold warm pools, the
likely result is *+1–2 ms of p95 and +$0.03/hour for no attainment gain*. That is a perfectly good
published result, and stating the expectation first is what makes it one instead of a
disappointment.

### C5 — `max_connections` is a cliff, and the second knob can walk off it

> **Reversed in part, 2026-09-19.** This section treats reaching the ~112-connection ceiling as an
> accident to be designed away. The spec deliberately walks toward it: knob 2 sets a **fixed**
> `desired_count = 4` at `pool_size = 25`, which is 100 connections, because that is the only
> configuration in which RDS Proxy's mechanism — multiplexing many client connections onto fewer
> server ones — is under test at all. The warning below is still correct about what happens past the
> limit, and it is why the 5xx is treated as a result rather than a surprise. The "autoscaling stays
> off" rule also still holds: the spec fixes the task count, it does not enable the autoscaler. See
> `docs/superpowers/specs/2026-09-19-ecs-rds-postgres-pool-design.md`, "Why the research document's
> three options were all rejected".

RDS Postgres defaults `max_connections` to `LEAST({DBInstanceClassMemory/9531392}, 5000)` — about
**9.1 MB of instance memory per connection**. That puts **db.t4g.micro (1 GiB) at 112**, minus
`superuser_reserved_connections` (3). db.t4g.small (2 GiB) is ~225.

Pool 25 × 4 autoscaled tasks = 100 connections, plus whatever else holds one. Past the limit
Postgres answers `FATAL: sorry, too many clients already`, which is a 5xx — it burns the
**availability** budget, not the latency one, and the run stops being a pool experiment.

This is the "one knob at a time" rule with teeth: **autoscaling stays off for the whole pool
comparison**, and the instance class has to be chosen against `pool_size × task_count`, not against
CPU.

### C6 — T-class CPU credits have no DynamoDB analogue and will break comparability

> **Checked 2026-09-19: the suspicion is correct, and the answer is procedural.** Dumping the schema
> of the provider this repo pins (`hashicorp/aws` 6.62.0), `credit_specification` exists on
> `aws_instance`, `aws_launch_template` and `aws_spot_instance_request` only — the string "credit"
> does not appear anywhere in `aws_db_instance`. So the mode is unsettable in Terraform and
> click-ops is forbidden. The design keeps `db.t4g.micro` and records `CPUCreditBalance` and
> `CPUSurplusCreditsCharged` per run, gates a run on a full balance, and **disqualifies** a run that
> depletes it. See the design spec, "Instance class and the credit gate".

`db.t4g.*` is burstable. Under sustained load it either throttles to baseline CPU or — in unlimited
mode, which is the default for T-class RDS — keeps performance and **bills surplus credits**. Either
way, run 3 can differ from run 1 for a reason that has nothing to do with the pool, and the repo's
own rule is that a profile is only comparable to itself.

There is no `credit_specification` argument on `aws_db_instance` the way there is on `aws_instance`,
so the mode may not be settable from Terraform at all — and click-ops is forbidden here. Verify with
`terraform providers schema -json | jq '.provider_schemas[].resource_schemas.aws_db_instance.block.attributes | keys'`
during the spec. If it is not settable, the only Terraform-compatible answers are: record
`CPUCreditBalance` and `CPUSurplusCreditsCharged` per run and treat a depleted balance as
disqualifying, or pay for a non-burstable class.

**This replaces the 6-minute drain.** `ecs-dynamodb-rps` waits 6 minutes before every run for
DynamoDB's burst bucket to refill. The equivalent ritual here is the opposite and longer: warm the
buffer cache, confirm the pool is at `max`, confirm the credit balance, and only then start.

### C7 — The working set must fit in RAM, or the first run measures EBS

db.t4g.micro has 1 GiB, of which `shared_buffers` is roughly a quarter. If the seeded table exceeds
that, a "fast" query becomes random reads off gp3 and the first run of the day differs from the
second by an order of magnitude. Seed volume (row count × row width) is therefore a **measurement
parameter, not a convenience** — it belongs in `slo.yaml`'s capacity block or beside it, and the
seed must be followed by `VACUUM ANALYZE` and a warm-up pass.

### C8 — Reaching the database at all

`ecs-dynamodb-rps` has **no NAT gateway** on purpose (public subnets, tasks with public IPs — ~$32/mo
saved and the most common teardown survivor avoided), and DynamoDB is reached through a free gateway
VPC endpoint. RDS has no such endpoint: it is an ENI in the VPC. So `scripts/deploy-service.sh`
cannot run migrations or a seed the way the DynamoDB one does unless something changes.

Three options, and this is decision **D4** below: publicly accessible instance with a security group
allowing only the operator's IP and the task SG; a one-off `aws ecs run-task` that runs the seed
inside the VPC; or migrate-on-boot inside the service. Only the first also gives `psql` for
debugging, which during a load-test session is worth a lot.

### C9 — TLS and credentials: the two things that only fail in AWS

- RDS PostgreSQL 15+ ships `rds.force_ssl = 1` in the default parameter group. A pool that works
  against a local docker Postgres (no TLS) fails in the VPC unless the client sets `ssl` and the
  image carries the RDS CA bundle. Integration tests cannot catch this.
- The password path: `random_password` → SSM `SecureString` is free, deletes immediately, and reuses
  the pattern `ecs-dynamodb-rps/infra/main/collector.tf` already uses for the Grafana tokens. **RDS
  Proxy, however, requires AWS Secrets Manager** plus an IAM role. Secrets Manager charges per secret
  per month and — the gotcha — **deletes with a recovery window of 7–30 days by default**, so a
  destroy/re-apply cycle collides with "a secret with this name is scheduled for deletion".
  `recovery_window_in_days = 0` is mandatory in a lab that is destroyed daily.

### C10 — New teardown survivors

`terraform destroy` succeeding is not evidence the account is clean — the existing rule, with a
longer list here:

| survivor | prevention |
|---|---|
| final snapshot | `skip_final_snapshot = true` |
| automated backups | `backup_retention_period = 0`, `delete_automated_backups = true` |
| `/aws/rds/instance/<id>/postgresql` log group | declare the `aws_cloudwatch_log_group` explicitly with retention so Terraform owns it |
| DB subnet group, parameter group | own them explicitly; they are cheap but they block a clean re-apply |
| Secrets Manager secret | `recovery_window_in_days = 0` (C9) |
| the proxy | deletes slowly and blocks the instance delete; expect a long destroy |

Also: an RDS instance takes ~5–15 minutes to create and to delete. `/env down` already has to run in
the background for `ecs-dynamodb-rps` (the env skill records an internet gateway alone taking 3m39s
on ENI detachment); here it is worse.

### C11 — Comparability with the sibling project

If the service is forked — same routes, same 55/15/25/5 mix, same class thresholds — the two
projects' `results.md` rows can sit in one table and the difference is the datastore. If the routes
change shape (a SQL feed is not a DynamoDB `Query`), they cannot. That is a deliberate trade, not an
accident, and it is decision **D6**.

### C12 — The generator is copied, so bugs are copied

Already decided on 2026-09-04: `slo.yaml` is per-project and `scripts/generate-slo.js` is copied,
not shared. The known cost is that a bug fixed in one stays broken in the other. Mitigation is one
line: a header in both files naming the sibling and the date of the fork, so the next person
grepping knows there is a second copy.

---

## The six research questions, answered

**1. What the SLI actually is.** Recommendation: **change nothing**. Keep
`sli: class_threshold_ratio` with the same fast/standard/heavy shape and the same availability
objective. Pool wait is a *cause*, not a symptom a user feels — it belongs where throttles belong in
the sibling project: its own dashboard row and its own alert rules, first-class, but not an SLO
objective. `slo.yaml` needs no new SLI type. (CLAUDE.md's "treat database metrics as first-class
SLIs" is satisfied the same way `ecs-dynamodb-rps` satisfies it — throttles have two dedicated alert
rules and are not an objective.) This is decision **D1**; the alternative is a second objective
"connection acquired within N ms", which costs a new SLI type in the generator and a second error
budget to explain.

**2. How to see waiting sessions.** Three sources, no exporter needed:

- `pool.waitingCount` / `totalCount` / `idleCount` — the app's own view of its queue, published as
  OTel observable gauges over the existing OTLP path. Cheapest and most direct.
- `DBLoadRelativeToNumVCPUs`, `DBLoadCPU`, `DBLoadNonCPU` — Performance Insights → CloudWatch, free
  at 7-day retention, no agent. `DBLoadNonCPU` is precisely "sessions waiting on something".
- `DatabaseConnections` — CloudWatch `AWS/RDS`, confirms the pool opened what you think it opened.

**Nothing has to scrape `pg_stat_activity`**, which removes the whole class of "the scraper competes
with the load it is measuring" failure the placeholder worried about. The per-wait-event breakdown
does need the Performance Insights API (or CloudWatch's `DB_PERF_INSIGHTS` metric-math function),
and that is a stretch goal, not a requirement.

A consequence worth taking, stated precisely because it was misread once: **the Alloy collector
stays; only its second pipeline goes.** Alloy runs two independent pipelines in `ecs-dynamodb-rps`.
Pipeline 1 is the OTLP gateway — the service exports its histograms to Alloy, an OTTL transform
stamps the `class` label from `classmap.json`, and Alloy forwards to Grafana Cloud. That is how
request latency reaches Grafana at all, and without its `class` label the SLI query matches nothing.
Pipeline 2 is a `prometheus.exporter.cloudwatch` block that exists for exactly one metric,
`SuccessfulRequestLatency`, forwarded into Prometheus so a query can subtract it from the in-process
`db` histogram. There is no Postgres equivalent to subtract, and everything else is read live from
the CloudWatch datasource by the panel or rule that wants it, so pipeline 2 can go: no
`tag:GetResources` IAM, no per-minute `GetMetricData` charge. (A *scrape* pipeline may come back
under D7 — scraping Prisma's metrics endpoint is a scrape of the app, not of CloudWatch.)

**3. Which pool library → Prisma, decided on review, and it changes the measurement.**
> **Superseded 2026-09-19 on its second and third bullets.** Prisma stays, but the pool is reached
> through `@prisma/adapter-pg`, so `Pool.max` is the size knob rather than `?connection_limit=`,
> `connectionTimeoutMillis` replaces `pool_timeout`, `idleTimeoutMillis: 0` becomes available again,
> and the "ready-made histogram" this paragraph relies on no longer ships (see C2 above). Migrations
> and seeding are unaffected. See the design spec, "The driver adapter accepts a pool the
> application constructs".

The research
assumed `pg` (node-postgres), which exposes `totalCount`, `idleCount` and `waitingCount` as gauges
but no checkout-wait metric, so the wait had to be wrapped by hand. Prisma replaces both halves of
that: there is no checkout call to wrap (C2), and there is a ready-made histogram
(`prisma_client_queries_wait_histogram_ms`, behind `previewFeatures = ["metrics"]`). Four
consequences:

- **The pool-size knob becomes a connection-string parameter.** `?connection_limit=5` on
  `DATABASE_URL` (default `num_cpus × 2 + 1`), with `pool_timeout` as the saturation cut-off —
  Prisma's answer to `connectionTimeoutMillis`, default 10 s. **That default is far too long here**: a
  request that queues ten seconds for a connection has already blown every class threshold by an
  order of magnitude. Set it just above the heavy threshold, so a saturated pool produces 5xx the
  availability objective catches rather than an unbounded queue that shows only as latency.
- **Migrations and seeding stop being a bespoke script.** `prisma migrate deploy` and
  `prisma db seed` are the whole of it — and Prisma Migrate takes a Postgres advisory lock, which
  removes the "a rolling deploy races itself" cost that D4's chosen boot-time option would otherwise
  carry.
- **The wait metric is process-global, not per route.** The per-class attribution this project exists
  for does not survive it unchanged. That is D7.
- **Two deployment details for the spec.** `metrics` is still a Preview feature, so confirm its
  status against the Prisma version actually pinned; and the image must carry a query engine matching
  the container platform — the same class of failure as the `CannotPullContainerError` the sibling
  README records for an arm64 image. Worth checking whether the driver-adapter path in D7 removes the
  engine binary altogether.

**4. RDS Proxy's real effect.** Answered in C4: the wait moves, the witness exists
(`DatabaseConnectionsBorrowLatency` and friends), the comparison survives with a stated caveat on the
row, and the expected result should be pre-registered because it may well be "no improvement".

**5. Cost and teardown.** Teardown is C10. Cost, **estimated and not yet verified** — the repo's rule
is that prices come from a query with the query recorded, as `ecs-dynamodb-rps/service/pricing.json`
does:

| item | estimate |
|---|---|
| existing idle baseline (ALB + 2 Fargate tasks) | $0.055/hr — measured, from the sibling README |
| db.t4g.micro, single-AZ | ~$0.018/hr |
| 20 GiB gp3 storage | ~$0.003/hr |
| Performance Insights, 7-day retention | free |
| **idle, no proxy** | **~$0.076/hr** ≈ $55/month |
| RDS Proxy (per vCPU-hour of the instance, floor of 2 vCPU for T-class) | ~$0.030/hr |
| **idle, with proxy** | **~$0.106/hr** ≈ $77/month |

The proxy is the line to check first: at ~$0.03/hr it is **40% of the entire current idle bill** for
a component whose measured benefit may be zero. That is an argument for running the proxy phase last
and destroying it immediately, not for skipping it.

**6. How much is copied vs. rewritten.** Answered on review: **keep the shape, design the SQL
workload on its own terms** — four routes, three classes, one frozen mix, but the queries, indexes
and row widths chosen for Postgres and for C1's hold-time target rather than inherited from
DynamoDB's cost model. The consequence accepted with it is that the two projects' `results.md` rows
no longer belong in one table; each result stands alone.

| copied nearly verbatim | rewritten |
|---|---|
| `infra/main/network.tf`, `alb.tf`, `ecr.tf`, `ecs.tf`, `heartbeat.tf`, `versions.tf` | `dynamodb.tf` → `rds.tf` (+ subnet group, parameter group, Performance Insights), and a new `proxy.tf` that is `count`-gated from day one |
| `infra/main/collector.tf` minus its CloudWatch pipeline | — |
| `service/src/` — `server.js`, `timing.js`, `otel.js`, `config.js`, the shape of `handlers.js` | `dynamo.js` → `db.js` (PrismaClient + the D7 measurement); handler bodies; `prisma/schema.prisma` and its migrations |
| `service/scripts/generate-slo.js` and its tests | its `renderCapacityTfvars` — RCU/WCU has no analogue; pool size and instance class take its place |
| `infra/k6/` — the three shapes, the threshold wiring, `lib/env.js`'s reasoning | the request mix and the per-route bodies, re-derived for the SQL workload |
| `scripts/upload-k6.sh`; the `infra/grafana/` structure | `deploy-service.sh` (migrate and seed now run at container start); `throttles.tf` → `saturation.tf` |

---

## Phases

One design spec, then execution. Every `terraform apply` and `terraform destroy` is its own task and
stops for approval; a subagent may write and `plan` HCL freely. **Revised 2026-09-11**: ten phases
became eight — no local test runs, calibration on the deployed instance, both knobs pre-wired.

**Phase 0 — brainstorming and the spec.** Resolve D5 and D7, then
`docs/superpowers/specs/2026-09-XX-ecs-rds-postgres-pool-design.md`. No code. The spec must state the
expected proxy result (C4) before any run happens.

**Phase 1 — all of the code, written once.** Prisma schema, migration and seed; the four routes; the
OTel wiring including whichever pool-wait path D7 picks; `slo.yaml` with the class thresholds
deliberately left open, because Phase 3 is what sets them. No local Postgres and no integration
suite.

**Phase 2 — infrastructure with both knobs pre-wired, plan only.** `platform/tfc.tf` gains one line
(`"ecs-rds-postgres-pool" = { working_directory = "infra/main" }`), which creates the TFC workspace
and the k6 project. Then the root module, in which `pool_size` and `proxy_enabled` are variables: the
proxy, its Secrets Manager secret and its IAM role all carry `count = var.proxy_enabled ? 1 : 0`, so
they exist in the code and cost nothing until flipped, and the database host the task receives is a
computed local that switches between the instance endpoint and the proxy endpoint. Ends at a reviewed
`terraform plan`, `fmt -check` and `validate` — no apply.

**Phase 3 — apply, deploy, calibrate on the real instance. ⛔ approval gate.** `terraform apply` in
its own task; migrations and seed run at container start (D4). Then calibrate as C1 describes —
against the real db.t4g.micro, targeting `DBLoadRelativeToNumVCPUs ≈ 0.5` at `pool_size = 5` so the
pool binds first with database CPU still in reserve. Freeze the class thresholds in `slo.yaml`,
regenerate, redeploy.

**Phase 4 — baseline at pool 5.** Upload profiles, discovery run → the knee, constant run → the
baseline row. Watch the k6 threshold fail against the small pool *before* changing anything: with the
local suite gone, this is the only place the red-test discipline appears.

**Phase 5 — knob 1: `pool_size = 25`. ⛔ approval gate on the apply.** A two-character edit in
`dev.tfvars`, then apply. Autoscaling stays off (C5). Re-run B and C unchanged. Expect the bottleneck
to move from the pool to database CPU.

**Phase 6 — knob 2: `proxy_enabled = true`. ⛔ approval gate on the apply.** Same shape: one line, one
apply, no code. Record borrow latency and session pinning against the expectation pre-registered in
Phase 0.

**Phase 7 — write up and tear down. ⛔ approval gate on the destroy.** `README.md` with the measured
results, `results.md` complete, then destroy and the tagged-resource sweep. Optionally a third knob
first, from the D2 note: ECS autoscaling 1→4 tasks, which at pool 25 is a `pool_size × task_count`
question against the 112-connection ceiling.

---

## Target structure

Identical in shape to `ecs-dynamodb-rps`, which is the point — the layout is fixed by CLAUDE.md and
only the leaves differ. Differences from the sibling are marked.

```
ecs-rds-postgres-pool/
  infra/
    main/                    ROOT MODULE (TFC workspace `ecs-rds-postgres-pool`, working dir infra/main)
      network.tf             copied; no DynamoDB gateway endpoint, RDS subnet group instead
      rds.tf                 NEW   db.t4g.micro, subnet group, parameter group, Performance Insights
      proxy.tf               NEW   aws_db_proxy + secret + role, all count = proxy_enabled ? 1 : 0
      ecs.tf alb.tf ecr.tf   copied; DATABASE_URL built from pool_size and the switched host
      collector.tf           copied minus the CloudWatch pipeline; the OTLP gateway pipeline stays
      heartbeat.tf           copied
      grafana.tf k6.tf       copied
      dev.tfvars             pool_size = 5 · proxy_enabled = false · instance_class · seed_rows
    grafana/
      dashboard.json.tftpl   rows: request / pool / database / service / edge / SLI / latency
      saturation.tf          NEW   replaces throttles.tf: DBLoad/vCPU, connections, pinning
      alerts.tf slo.tf folder.tf locals.tf queries.json classmap.json alloy.alloy.tftpl
    k6/
      tests/                 discovery.js constant.js stress.js + lib/ — shapes copied, mix re-derived
  service/
    prisma/schema.prisma     NEW   models + previewFeatures; migrations/ generated
    src/                     server.js timing.js otel.js config.js handlers.js copied;
                             db.js NEW — PrismaClient and the D7 measurement (replaces dynamo.js)
    scripts/                 generate-slo.js (copied), calibrate.js; seed via `prisma db seed`
    test/                    unit only — no integration suite, no local Postgres
  heartbeat/index.mjs        copied
  scripts/
    deploy-service.sh        copied; migrate and seed run at container start instead
    upload-k6.sh             copied
  slo.yaml                   same SLI types (D1); thresholds frozen in Phase 3, not before
  results.md                 the run ledger, with different columns — see below
  README.md
```

## Usage

Identical to the sibling, so nothing new has to be learned:

```bash
# once, from the repo root, after adding the project to platform/tfc.tf
terraform -chdir=platform apply

cd ecs-rds-postgres-pool
(cd service && npm ci)
terraform -chdir=infra/main init
terraform -chdir=infra/main plan  -var-file=dev.tfvars
terraform -chdir=infra/main apply -var-file=dev.tfvars      # approval gate
./scripts/deploy-service.sh                                  # build → push → roll → migrate → seed → health

./scripts/upload-k6.sh --check
./scripts/upload-k6.sh --rate <knee>
k6 cloud run -e BASE_URL="$(terraform -chdir=infra/main output -json | jq -r .base_url.value)" \
             -e RATE=<knee> infra/k6/tests/constant.js
echo "exit=$?"                                               # 0 = gates held, 99 = one breached

# knob 1 and knob 2 are tfvars edits — no code change, no rebuild, no redeploy
#   pool_size     = 25      in infra/main/dev.tfvars, then apply
#   proxy_enabled = true    one at a time, never both in one comparison
terraform -chdir=infra/main apply -var-file=dev.tfvars       # approval gate

terraform -chdir=infra/main destroy -var-file=dev.tfvars     # approval gate
```

And the three skills work unchanged: `/env up|down|status ecs-rds-postgres-pool`,
`/loadtest ecs-rds-postgres-pool constant --compare`, `/slo ecs-rds-postgres-pool --check`.

---

## What changes outside this project

Three small things, all repo-scope, all worth doing in Phase 4 rather than discovering later:

1. **`platform/tfc.tf`** — one line in `local.projects`. It creates the TFC workspace *and* the
   Grafana Cloud k6 project. `platform/` runs in local execution mode, so it needs the shell
   credentials; it is applied by hand, never through `/env`.
2. **`.env` holds a single `K6_CLOUD_PROJECT_ID`**, and there will now be two k6 projects. Either the
   variable becomes per-project, or it stops being used and every reader goes through
   `terraform -chdir=infra/main output -raw k6_project_id`. The second is more in keeping with the
   rule the sibling README already states about `base_url` — a copy elsewhere is just the stale one.
3. **The `/loadtest` skill's results table is DynamoDB-shaped.** Its header ends
   `… | throttles | RCU/WCU | $/hr |`, and its "read the throttle counts from CloudWatch" section
   queries `AWS/DynamoDB`. This project's columns want to be `pool wait p95`, `waiting peak`,
   `DBLoad/vCPU`, `connections`, `pool size / class`, and for proxy runs `borrow latency p95` and
   `pinned`. The cleanest fix is for the skill to keep the shared spine — date, profile, infra
   change, RPS, both attainment columns, budget burn, p95 per class, `$/hr` — and to take the
   project-specific columns from the project, so neither project's table has to carry the other's
   empty cells.

---

## The two open decisions

> **Both were answered on 2026-09-19** on <https://claude.ai/artifact/YUgenn8it3dcgbKaR9pT3Y> and are
> settled in `docs/superpowers/specs/2026-09-19-ecs-rds-postgres-pool-design.md`. D5 was answered
> with an option not listed below; D7 was answered with option (a), because (b) and (c) rest on a
> Prisma feature that has been removed. The reasoning for both is kept below as the record of what
> was considered.

**D5 — what the second knob is, and what it is compared against.** Neither knob as planned is
database scaling, which is what the review asked. Knob 1 raises the pool the *application* holds
(`pool_size` 5 → 25) and touches the database not at all — same instance, same size, same cost. Knob
2 puts a second, *server-side* pool in front of it (RDS Proxy) so connections are shared rather than
multiplied. Growing the instance is a different experiment. The three options are: the proxy in front
of whichever pool won Phase 5, compared to that run, with "no improvement" pre-registered as the
expected result; the proxy against pool 5 instead, asking whether it can replace a bigger pool, which
is a better question compared against a worse baseline; or dropping the proxy and making the second
knob instance class plus `max_connections`, which is cheaper and certain to move the numbers but
changes two things at once and abandons the question the project is named for.

**D7 — where the pool-wait number comes from, now that Prisma owns the pool.** Three options. *(a)*
Reach the pool through `@prisma/adapter-pg` so the underlying `pg` pool is yours again, time its
acquisition, and attribute each wait to the request in flight with `AsyncLocalStorage` — then the
phase histogram carries the same `http.route` and `class` labels as `db` and `cpu`, and every query
already written against them works unchanged; the costs are the most code of the three, an
`AsyncLocalStorage` on the hot path, and verifying that the pinned Prisma version's adapter still
accepts an existing `pg.Pool` rather than only a config object. *(b)* Expose
`prisma.$metrics.prometheus()` and have Alloy scrape it — about fifteen lines of collector config and
no application code, at the cost of no per-class split and a Preview feature on the critical path.
*(c)* Both, with (b)'s gauges as the cross-check that distinguishes a new connection from a real
queue (C3) — at the cost of two sources for one story.

Both are on the review page:
<https://claude.ai/code/artifact/6f818fbd-e1bd-47cd-86cc-bfe7adefa251>

## Constraints that already apply

Unchanged from the placeholder, restated because they bind every phase above:

- Terraform is the only way infrastructure exists; every resource carries
  `Project = ecs-rds-postgres-pool` via `default_tags`; state in its own Terraform Cloud workspace,
  added by `platform/`.
- `terraform apply` and `terraform destroy` each get their own plan task and stop for approval.
- The measurement discipline replaces TDD: write the k6 threshold that encodes the SLO, watch it
  fail against the current infrastructure, then change the infrastructure until it passes.
- An SLO or RPS number may not be reported without the k6 output or Grafana query that produced it,
  from a run in the same session.

## Sources

- Performance Insights → CloudWatch metrics (`DBLoad`, `DBLoadCPU`, `DBLoadNonCPU`,
  `DBLoadRelativeToNumVCPUs`; published only under load):
  <https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PerfInsights.Cloudwatch.html>
- RDS Proxy CloudWatch metrics:
  <https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.monitoring.html>
- `pg.Pool` configuration and properties (still relevant under D7 option A):
  <https://node-postgres.com/apis/pool>
- Prisma Client metrics — `prisma_client_queries_wait_histogram_ms`, `prisma_client_queries_wait`,
  `prisma_pool_connections_open/_idle/_busy`, behind `previewFeatures = ["metrics"]`:
  <https://www.prisma.io/docs/orm/prisma-client/observability-and-logging/metrics>
- RDS `max_connections` default formula, and db.t4g.micro = 112:
  <https://repost.aws/knowledge-center/rds-mysql-max-connections>
