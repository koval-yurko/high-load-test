# ecs-rds-postgres-pool — the connection pool as the binding constraint

- **Date:** 2026-09-19
- **Status:** **approved** (2026-09-20, by the user). Its four open decisions were answered on the
  page cited below; the workload it deliberately left open was designed and approved in
  `docs/superpowers/plans/2026-09-20-ecs-rds-postgres-pool-service.md`, which is plan 1 of 4 and is
  ready to execute. Plans 2–4 are written as the work reaches them.
- **Project directory:** `ecs-rds-postgres-pool/` (new; nothing is deployed and nothing carries the
  `Project = ecs-rds-postgres-pool` tag yet)
- **Amends:** `docs/research/ecs-rds-postgres-pool.md` (researched 2026-09-11). That document's
  decision **D7** proposed reading pool wait from Prisma's built-in metrics; that feature no longer
  exists, and §3 below replaces the mechanism entirely. Its decision **D5** left the second knob
  open between three options, all three of which are superseded by §6. Its **C6** suspicion about
  burstable CPU is confirmed and answered in §7.2. Forward-pointers are written into the research
  document at each of those decisions.
- **Decisions recorded on:** <https://claude.ai/artifact/YUgenn8it3dcgbKaR9pT3Y> (2026-09-19, four
  decisions, no dissenting notes)

---

## 1. What this project measures, and what would make it a failure

A Node.js service on ECS Fargate in front of a single RDS PostgreSQL instance, sized so that **the
application's connection pool — not the database, not the CPU, not the ALB — is what runs out
first.** Then the pool is released, in three deliberate steps, and each step's effect on SLO
attainment and error budget is recorded.

The deliverable is the before/after table, not the infrastructure. A project that provisions
cleanly, runs k6 successfully and records no comparison is unfinished, per the repository's stated
purpose.

The specific failure mode this design spends most of its effort avoiding is stated here so that
every later section can be read against it: **if the pool and the database saturate at the same
offered rate, no run can attribute a slow request to either.** Releasing the pool would then move
the bottleneck nowhere visible, and the whole measure/improve/re-measure loop produces a table of
numbers that do not mean what the column headers say. §5 is the calibration that prevents this, and
it is the one step that must happen before the SLO thresholds are frozen.

## 2. The four decisions this spec settles

All four were asked on the decision page cited above and answered on 2026-09-19.

| # | question | answer |
|---|---|---|
| S1 | Where the pool-wait number comes from | **Per-request attribution** — own the `pg.Pool` through `@prisma/adapter-pg`, time checkout, carry it to the request with `AsyncLocalStorage` (§3) |
| S2 | What the second knob is | **Scale to four fixed tasks first, then add the proxy** — three knobs, each its own apply (§6) |
| S3 | How much of the sibling project to fork | **Observability only** — take ELU/CPU/CloudWatch, leave admission control and autoscaling out (§4.3) |
| S4 | Burstable CPU | **Stay on `db.t4g.micro`, and make the credit balance a run gate** (§7.2) |

Decisions D1–D4 and D6 from the research document stand unchanged: the SLI keeps its
`class_threshold_ratio` shape with a separate availability objective; the instance is the minimum
one; the pool binds through real query cost calibrated on the deployed instance; migrations and seed
run at container start behind a flag; the service keeps the sibling's four-route, three-class shape
while the SQL workload is designed on its own terms.

## 3. Verified findings that forced two of these decisions

Every claim in this section was checked on 2026-09-19 in the session that produced this spec. They
are recorded here rather than left in the research document because two of them invalidate what that
document says, and a reader who lands on the older text needs to find the correction attached to the
claim.

### 3.1 Prisma's metrics feature has been removed

The research document's answer to "Prisma owns the pool, so there is no checkout to wrap" was that
Prisma publishes the number itself, via `prisma_client_queries_wait_histogram_ms` behind
`previewFeatures = ["metrics"]`. **That feature was deprecated in Prisma ORM 6.14.0 and removed in
7.0.0.** The npm dist-tags on 2026-09-19 are `prev: 7.10.0` and `latest: 8.0.0-rc.15`, so no version
this project could reasonably pin still carries it. `$metrics.prometheus()`, `$metrics.json()`,
`prisma_client_queries_wait`, and the `prisma_pool_connections_open` / `_idle` / `_busy` gauges go
with it.

Prisma's own upgrade guide directs users to "the underlying driver adapter for your database, or
Client Extensions" instead. Two of the research document's three options for D7 depended on scraping
that endpoint; both are now impossible rather than merely unattractive.

Source: <https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7>, section "Metrics removed"; and
`npm view prisma dist-tags`.

### 3.2 The driver adapter accepts a pool the application constructs

This was the open question that decided whether per-request attribution was available at all.
`@prisma/adapter-pg` is at **7.10.0**, and the v7 documentation shows `new PrismaPg(pool)` taking a
`Pool` the application built — not only a connection-string config object.

So the pool is the application's again, and with it:

- `waitingCount`, `idleCount` and `totalCount` as gauge sources;
- `connectionTimeoutMillis` in place of Prisma's `pool_timeout`;
- `idleTimeoutMillis: 0`, which the research document had written off as unavailable. This matters
  more than it looks: the sibling project's README records roughly 3% of idle fast-class requests
  missing their 50 ms threshold because the socket was reaped and the next request paid a fresh TLS
  handshake. Under Prisma's own pool that was mitigable only; here it is preventable.

The pool-size knob moves from the connection string (`?connection_limit=`) to `Pool.max`. It remains
a Terraform-supplied environment variable, so the property that matters — **releasing a knob is a
`dev.tfvars` edit and an apply, with no code change, no image rebuild and no redeploy** — survives.

**To confirm at implementation time, not assumed here:** whether the pinned version's driver-adapter
path removes the Rust query engine binary from the image. If it does, it also removes the
architecture-mismatch failure the sibling's README records as `CannotPullContainerError`. The design
does not depend on this either way.

### 3.3 Performance Insights is available on `db.t4g.micro` for PostgreSQL

This one could have taken the entire attribution story down with it, because
`DBLoadRelativeToNumVCPUs` is how the database announces that it is the constraint, and the widely
repeated advice is that micro instances do not support Performance Insights.

That advice is about MySQL. AWS's engine and instance-class table lists the exclusion —
`db.t2.micro`, `db.t2.small`, `db.t3.micro`, `db.t3.small`, `db.t4g.micro`, `db.t4g.small` — in the
rows for **MariaDB and MySQL only**. The row for **RDS for PostgreSQL gives its instance-class
restrictions as `N/A`**. The reason is engine-specific: the feature leans on `PERFORMANCE_SCHEMA`
and its memory footprint on MySQL, while the Postgres implementation reads `pg_stat_activity`.

The plan therefore stands on the cheap instance. **Fallback if the first apply argues anyway:**
`db.t4g.medium`, which changes the connection ceiling and so would force §6's task-count arithmetic
to be redone — see §7.2.

Source:
<https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_DatabaseInsights.Engines.html>.

### 3.4 T-class credit mode cannot be set from Terraform

The research document suspected this and asked for it to be checked against the provider schema. It
is true. Dumping the schema of the provider this repository pins —
`registry.terraform.io/hashicorp/aws` version **6.62.0**, from
`ecs-dynamodb-rps/infra/main/.terraform.lock.hcl` — the attribute `credit_specification` exists on
exactly three resources: `aws_instance`, `aws_launch_template` and `aws_spot_instance_request`. The
string "credit" does not occur anywhere in the `aws_db_instance` schema, in either its attributes or
its nested blocks.

RDS T-class instances default to **unlimited** mode. Click-ops is forbidden by this repository's
first hard constraint. There is therefore no way to turn it off, and §7.2 handles the consequence
procedurally instead.

### 3.5 A correction to a pointer, while we are here

The research document cites `platform/k6.tf` as the place documenting the 100-VU cap. That file no
longer exists: the k6 project moved into each project's own stack on 2026-09-14, and the cap is now
documented in `ecs-dynamodb-rps/infra/k6/main.tf`, which records that uploading a 400-VU profile
fails with `(400/E2004) The Virtual User (VU) count for this test (400 VUs) exceeds the maximum
allowed for your project (100 VUs)` **while the project's own `vu_max_per_test` reads 25000** — so
the 100 is a subscription-level limit enforced elsewhere and cannot be raised from Terraform. This
project inherits that cap and §5 sizes against it.

## 4. The measurement model

### 4.1 Three queues in series

A request that is slow waited in one of three places:

```
k6 ──▶ ALB ──▶ [1] Node event loop ──▶ [2] pool checkout queue ──▶ [3] Postgres backend
                    │                        │                          │
             eventloop.delay p99      pool.duration, per class   DBLoadRelativeToNumVCPUs
             (forked, §4.3)           (new, §4.2)                (CloudWatch, live)
```

> **Renamed since.** The diagram's `pool.duration` is now emitted as **`db.pool.wait.duration`**
> (plan `docs/superpowers/plans/2026-09-20-ecs-rds-postgres-pool-service.md`, task 11 —
> `src/otel.js` exports it). It sits beside the three gauges `db.pool.waiting`, `db.pool.idle` and
> `db.pool.total`, and a bare `pool.duration` in that company names no namespace at all. See §4.2.

The sibling project measures [1] and estimates queueing at [3] by subtracting DynamoDB's own
server-side clock from its in-process `db` phase. That subtraction is neither needed nor available
here — Postgres publishes no per-operation server-side latency — and it is replaced by measuring [2]
directly and reading [3] from the database.

Nothing computes a verdict from the three. A person reads request latency, pool wait and database
load beside one another, which is exactly how the sibling's throttle panel is specified to be read
in `ecs-dynamodb-rps/README.md`.

### 4.2 Queue [2]: per-request pool wait — the S1 decision

The service constructs its own `pg.Pool`, hands it to `PrismaPg`, and wraps checkout:

- an `AsyncLocalStorage` store is entered per request in `server.js`, carrying the route template
  and its latency class;
- the pool-acquisition wrapper records elapsed time into a `pool.duration` histogram labelled with
  `http.route` and `class`, the same labels `db` and `cpu` already carry;
  **Renamed:** the metric ships as **`db.pool.wait.duration`**, not `pool.duration` — renamed in
  `docs/superpowers/plans/2026-09-20-ecs-rds-postgres-pool-service.md` (task 11), because the three
  companion gauges below are `db.pool.waiting` / `db.pool.idle` / `db.pool.total` and a bare
  `pool.duration` beside them is incoherent. `src/otel.js` exports it as `POOL_WAIT_DURATION`, and
  `slo.yaml`'s `attribution.pool_wait_metric` names it.
- `waitingCount`, `idleCount` and `totalCount` are published as OpenTelemetry observable gauges over
  the OTLP path that already exists.

The gauges are not redundant with the histogram. §4.4 explains why both are needed.

The cost accepted with this decision: an `AsyncLocalStorage` on the hot path, and a wrap around
checkout that must release on every path including the throwing one. The alternative — process-wide
gauges only — was rejected because this project's SLI is a per-class ratio and a global histogram
can say that a queue existed but not whose requests were in it, which is the question the project
exists to answer.

**Two contaminants must be stated on the metric, not discovered later.**

First, any wait measured around an `await` includes event-loop queueing by construction. This is
already documented on `DB_DURATION` in `ecs-dynamodb-rps/service/src/otel.js` and is honest as long
as it is written down.

Second, and less honest if left unsaid: when the pool has no idle connection but is below its limit,
acquiring one **opens a new physical connection** — TCP, TLS and Postgres authentication, tens of
milliseconds — which lands in the same number as "queued behind four other requests". Opposite
diagnoses, one series. Two mitigations, both of which survive the driver-adapter path:

- **Pre-warm at boot.** Issue `Pool.max` concurrent trivial queries before the server starts
  listening, so no measured request pays for connection establishment.
- **Watch `totalCount`.** It rises exactly when a connection is being created, so a wait spike that
  coincides with a rise is setup, and one that does not is a real queue.

`idleTimeoutMillis: 0` keeps established connections from being reaped between runs, which is what
makes the pre-warm hold.

### 4.3 Queue [1]: what gets forked — the S3 decision

The sibling project moved after the research document was written. On 2026-09-15 it gained admission
control and event-loop instrumentation; on 2026-09-18 it changed how provisioned capacity is set.
The research document's copy-versus-rewrite table predates all of it.

**Forked:**

| from | why |
|---|---|
| `service/src/elu.js` | the EventLoopUtilization sampler — this is what instruments queue [1], and it changes no behaviour |
| `service/src/cloudwatch.js` | publishes the ELU series so it is readable beside the database's own metrics |

**Not `service/src/cpu.js`**, which an earlier draft of this table paired with `elu.js` as though
they were one unit. They are independent: `elu.js` imports only `node:perf_hooks`, while `cpu.js`
holds nothing but `burn()`, the pbkdf2 cost knob. In the sibling that knob is how the *service* is
made to bind before DynamoDB does; here the equivalent knob lives in the database instead (§5), so
`burn()` would have no caller and forking it would ship dead code.

**Deliberately not forked:**

| from | why not |
|---|---|
| `service/src/admission.js` | it sheds 429 above ELU 0.92 — see the collision below |
| `infra/main/autoscaling.tf` | a feedback loop that changes task count mid-run; §6 uses a fixed `desired_count` instead |
| `infra/grafana/canary.tf` | a synthetic check, orthogonal to this project's question. **Reversed 2026-09-21** in `docs/superpowers/plans/2026-09-21-ecs-rds-postgres-pool-infrastructure.md` (decision D1): the file is not a synthetic check. Its live resource alerts when the SLI series goes absent, which guards against a silent pipeline — the failure this project can least afford. It is forked. |

**The collision, stated because it is the reason S3 was asked at all.** This design wants a
saturated pool to produce **5xx**: `connectionTimeoutMillis` is set just above the heavy-class
threshold, so an over-deep queue fails fast and burns the *availability* budget rather than growing
without bound and showing up only as latency. Admission control does the opposite — it sheds **429**
before the queue forms, and in this repository's Grafana SLI a 4xx is explicitly **not** a miss
(`ecs-dynamodb-rps/slo.yaml` states the selector and the reason). Those are two opposite treatments
of the same overload, and one ledger cannot measure both.

Forking the observability without the control loops takes the free visibility and leaves the
behaviour alone. Autoscaling remains available as an optional knob after the comparison is complete,
where it would be a deliberate variable rather than ambient behaviour.

**Capacity authority transfers as a principle, not as code.** The sibling's 2026-09-18 change moved
provisioned capacity out of a generated file and into `dev.tfvars`, on the argument that a
purchasing decision belongs where every other sizing knob is set, and that a generated file made
overrides silent rather than preventing them. This project has no RCU/WCU, but it has `pool_size`,
`instance_class`, `desired_count` and `seed_rows`, and all four are set by hand in
`infra/main/dev.tfvars` for the same reason. `slo.yaml` keeps a capacity block that **computes and
advises only**.

### 4.4 Queue [3]: the database's own account of itself

Read live from the CloudWatch datasource by whichever panel or rule wants it:

| metric | what it answers |
|---|---|
| `DBLoadRelativeToNumVCPUs` | above 1.0, more sessions are runnable than the instance has CPUs — the database saying it is the constraint |
| `DBLoadCPU` / `DBLoadNonCPU` | how much of that load is running versus waiting on something |
| `DatabaseConnections` | confirms the pool opened what the configuration says it opened |
| `CPUCreditBalance`, `CPUSurplusCreditsCharged` | §7.2's run gate. **Amended 2026-09-21** in `docs/superpowers/plans/2026-09-21-ecs-rds-postgres-pool-infrastructure.md` (Task 11): `CPUSurplusCreditBalance > 0` replaces `CPUSurplusCreditsCharged`. Charged becomes non-zero only once surplus credits outlive 24 hours of earning, or when the instance is terminated, so on an instance destroyed daily it stays 0 through the very event it is meant to catch; the surplus balance rises the moment the instance spends past its burst budget. |

These carry the same trap as the sibling's throttle metrics and for the same reason: AWS publishes
them only when there is load, so **a quiet minute produces no datapoint, not a zero**. Every reading
rule already encoded in `ecs-dynamodb-rps/infra/grafana/throttles.tf` transfers unchanged —
`no_data_state = "OK"`, a 300 s lookback, and `reduce(last)` rather than a math expression across
two queries. **Amended 2026-09-21** in `docs/superpowers/plans/2026-09-21-ecs-rds-postgres-pool-infrastructure.md` (Task 11), for the
credit metric only: T-class credit metrics publish every 5 minutes, so a 300 s window over them is
usually empty and `no_data_state = "OK"` turns that into silence. The credit rule uses a 300 s period
and a 600 s lookback; the other saturation rules keep 60 s and 300 s.

**The Alloy collector stays; only its CloudWatch pipeline goes.** Alloy runs two independent
pipelines in the sibling. Pipeline 1 is the OTLP gateway: the service exports its histograms to
Alloy, an OTTL transform stamps the `class` label from `classmap.json`, and Alloy forwards to
Grafana Cloud. That is how request latency reaches Grafana at all, and without the `class` label the
SLI query matches nothing — it is not optional. Pipeline 2 is a `prometheus.exporter.cloudwatch`
block existing for exactly one metric, so that DynamoDB's server-side latency could be subtracted
from the in-process `db` histogram. There is no Postgres equivalent to subtract and everything else
is read live by the panel that wants it, so pipeline 2 is dropped: no `tag:GetResources` IAM, no
per-minute `GetMetricData` charge.

## 5. Calibration: making the pool bind first

This is the step that decides whether the project measures anything, and it happens **before** the
class thresholds in `slo.yaml` are frozen, because those thresholds are what the k6 VU sizing is
derived from.

**The problem.** By Little's law a pool of 5 serving a 2 ms query sustains 2,500 queries per second.
The k6 subscription cap is 100 VUs (§3.5), and a 0.25 vCPU Fargate task and the ALB break long
before that rate. With a naive point-select workload the pool is never the bottleneck and the
project measures nothing.

**The knob.** The sibling solved the analogous problem with `pbkdf2_iterations`, a calibrated CPU
cost that puts the service ceiling at a known fraction of the datastore ceiling. Here the cost must
sit *inside the connection's hold time*, because that is what pool occupancy is: query cost, page
size, row width, or an explicit server-side cost. For a pool of 5 to bind at roughly 250 rps of
database-touching traffic, mean hold time must be about 20 ms (5 ÷ 0.020 = 250).

**The target is a relationship, not a number.** At the intended knee the pool must bind first *while
the database still has CPU headroom* — approximately `DBLoadRelativeToNumVCPUs ≈ 0.5` at
`pool_size = 5`. That is the whole experiment in one condition: it is what makes releasing the pool
in the next phase move the bottleneck to the database, rather than finding both saturated at once
with no way to tell them apart.

**Where it is done.** On the deployed instance, against real CPU consumption — not locally. There is
no local Postgres and no integration suite; the sibling calibrated `pbkdf2_iterations` the same way,
with two one-off Fargate runs that agreed to 0.23%.

**What the knob actually is**, decided 2026-09-20 in
`docs/superpowers/plans/2026-09-20-ecs-rds-postgres-pool-service.md` (its "Design decision made in
this plan" section), because this spec deliberately left the workload open: `REPORT_SCAN_ROWS`, the
number of rows the heavy route aggregates over, including a `count(DISTINCT feed_id)` so the cost
scales with rows rather than being a cheap running total. Two constraints came out of that design
and bind back onto this section. **The workload is two tables with a foreign key, not a key-value
table** — a single-table port of the sibling's schema would never exercise a join or a planner, which
is most of what makes Postgres behave unlike DynamoDB under load. And **every route issues exactly
one SQL statement**, the heavy one as a single data-modifying CTE, because one statement is one pool
checkout and the arithmetic above (5 ÷ 0.020 = 250) is only true at one checkout per request.

**The working set must fit in RAM, or the first run measures EBS.** `db.t4g.micro` has 1 GiB, of
which `shared_buffers` is roughly a quarter. If the seeded table exceeds that, a "fast" query
becomes random reads from gp3 and the first run of a session differs from the second by an order of
magnitude. `seed_rows` (row count × row width) is therefore a **measurement parameter**, set in
`dev.tfvars` beside the other sizing knobs, and the seed is followed by `VACUUM ANALYZE` and a
warm-up pass. **Amended 2026-09-22** in
`docs/superpowers/plans/2026-09-21-ecs-rds-postgres-pool-infrastructure.md` (ruling R20): 20% of the
mix and the heartbeat insert into `posts` and nothing deletes, so the table grows past `seed_rows`
across runs. The drift is accepted, not reset: every `results.md` row records the `posts` row count
taken before the run.

## 6. The knob sequence — the S2 decision

### 6.1 Why the research document's three options were all rejected

The research document offered: the proxy in front of whichever pool won, the proxy against pool 5,
or dropping the proxy for instance class plus `max_connections`. The first two share a mechanical
problem that was not noticed when they were written.

**RDS Proxy pools connections *behind* the application.** It does not remove the application's own
pool. With `Pool.max = 5` pointed at a proxy, the application still holds at most five connections
and the checkout queue in front of them is unchanged — so a proxy run against pool 5 measures the
same queue twice and its null result is easy to misread as "the proxy does not help". The proxy
earns its keep only when the number of client connections would otherwise exceed what the instance
can hold.

`db.t4g.micro` holds approximately **112** connections, from the Postgres default
`LEAST({DBInstanceClassMemory/9531392}, 5000)` — about 9.1 MB of instance memory per connection —
less `superuser_reserved_connections` (3). *(This is arithmetic on a documented formula, not a
measurement: `DBInstanceClassMemory` is not exactly the instance's RAM. Confirm with `SHOW
max_connections` on the real instance before §6.2's knob 2 is sized against it.)*

One task at `pool_size = 25` is 25 connections against 112. The proxy has nothing to protect, so
options one and two are pre-registered null results. Option three abandons pooling — the thing the
project directory is named for — and moves two variables at once, since instance CPU and connection
ceiling both derive from instance memory.

### 6.2 The sequence

Three knobs, each its own apply, each its own approval gate, each its own ledger row. The autoscaler
stays off throughout: `desired_count` is a fixed number, so every run is one deterministic
configuration.

| knob | change | connections | what it tests |
|---|---|---|---|
| baseline | `pool_size = 5`, `desired_count = 1` | 5 | the pool binds; database at roughly half its CPU (§5) |
| **1** | `pool_size` 5 → 25 | 25 | releasing the client pool; expect the bottleneck to move toward database CPU |
| **2** | `desired_count` 1 → 4, pool 25 | **100 against ~112** | the `max_connections` cliff becomes a measured number rather than a footnote |
| **3** | `proxy_enabled = true` | multiplexed | the proxy measured against the only configuration where its mechanism applies |

Knob 2 is the one that makes knob 3 meaningful. At 100 of about 112 connections, `FATAL: sorry, too
many clients already` is a reachable failure mode — and it is a **5xx**, so it burns the
availability budget rather than the latency one, and the run stops being a pool experiment and
becomes an availability incident. That is the point: it is the failure the proxy exists to prevent,
and knob 3 is the test of whether it does.

**Pre-registered expectation for knob 3, written before any run, so that a null is a published
result rather than a disappointment.** RDS Proxy exists for many short-lived clients — Lambda.
Against four long-lived ECS tasks holding warm pools, the expected outcome is: connection count at
the instance falls well below 100 and `DatabaseConnectionsCurrentlySessionPinned` stays near zero;
p95 rises by 1–2 ms from the extra hop; SLO attainment is unchanged or marginally worse *unless*
knob 2 actually breached the ceiling, in which case availability recovers and that is the whole
finding. Cost is approximately +$0.03/hour, roughly 40% of the idle bill.

### 6.3 Two things to settle before knob 3 runs

- **The unit of `DatabaseConnectionsBorrowLatency` is not reliably documented.** AWS's metric table
  gives `QueryDatabaseResponseLatency` in microseconds while community reports discuss borrow
  latency in milliseconds. Confirm against the CloudWatch console on the real proxy before any panel
  or threshold is built on it: a 1000× error here is silent and looks like a spectacular result.
- **Session pinning turns the proxy back into a passthrough.** When a client uses a feature the
  proxy cannot multiplex, the connection is pinned and
  `DatabaseConnectionsCurrentlySessionPinned` rises. A proxy run with everything pinned measures a
  proxy that is not pooling. This gets a panel and an alert rule, not a hope.

**The "after" row reads a different metric than the "before" row.** In-process `pool.duration`
(shipped as `db.pool.wait.duration` — see the rename note at §4.2)
versus the proxy's `DatabaseConnectionsBorrowLatency` measure different things at different points.
`results.md` says so on the row rather than implying one series continued.

## 7. Infrastructure

### 7.1 Shape

Root module at `infra/main`, calling `../grafana` and `../k6` as modules, exactly as the repository
layout requires and as the working directory set by `platform/` makes resolvable in a remote run.
Both knobs are wired in from the first apply: `pool_size`, `desired_count` and `proxy_enabled` are
variables, and the proxy with its Secrets Manager secret and IAM role all carry
`count = var.proxy_enabled ? 1 : 0`, so they exist in code and cost nothing until flipped. The
database host the task receives is a computed local that switches between the instance endpoint and
the proxy endpoint.

### 7.2 Instance class and the credit gate — the S4 decision

`db.t4g.micro`, single-AZ, with credits handled procedurally because §3.4 proved they cannot be
handled in HCL.

- `CPUCreditBalance` and `CPUSurplusCreditsCharged` are recorded as columns on **every** ledger row.
  **Amended 2026-09-21** in `docs/superpowers/plans/2026-09-21-ecs-rds-postgres-pool-infrastructure.md` (Task 11, and its section "Amended
  during execution and plan-3 handoff"): the second column, the alert rule and the dashboard panel
  use `CPUSurplusCreditBalance > 0` instead. Charged becomes non-zero only once surplus credits outlive 24 hours of earning, or when the instance is terminated, so on an instance destroyed daily it stays 0 through the very event it is meant to catch; the surplus balance rises the moment the instance spends past its burst budget. Credit metrics publish every 5 minutes, so
  the rule reads them with a 300 s period and a 600 s lookback.
- A run does not start until the balance is full. This replaces the sibling's six-minute wait for
  DynamoDB's burst bucket — the equivalent ritual here runs the other way and is longer: warm the
  buffer cache, confirm the pool is at `max`, confirm the credit balance, then start.
- **A run that depletes its balance is disqualified**, not merely noisy. It is thrown away and
  re-run.

The alternative — a non-burstable class — was rejected on two grounds: several times the instance
bill on a lab meant to be cheap to keep alive, and it raises `max_connections` along with memory,
which moves the cliff §6.2's knob 2 is aiming at and takes the proxy phase's point away again.

Making the credit balance a recorded, gating number rather than a hidden variable is the same move
the sibling made with throttle counts, and it is the direct lesson of that project's 25/25 capacity
incident, where a value nobody checked quietly invalidated a measurement.

### 7.3 Reaching the database

The sibling has **no NAT gateway** on purpose — public subnets, tasks with public IPs, roughly
$32/month saved and the most common teardown survivor avoided — and reaches DynamoDB through a free
gateway VPC endpoint. RDS has no such endpoint; it is an ENI in the VPC.

Per decision D4, **migrations and seed run at container start behind a flag**. Prisma Migrate takes
a Postgres advisory lock, which removes the "a rolling deploy races itself" cost this option would
otherwise carry. The instance is additionally made publicly accessible with a security group
admitting only the operator's IP and the task security group, because `psql` during a load-testing
session is worth a great deal for debugging and the alternative costs a NAT gateway. **Amended 2026-09-22** in
`docs/superpowers/plans/2026-09-21-ecs-rds-postgres-pool-infrastructure.md` (ruling R19): the group
admits 5432 from any address, guarded by a random password kept as `DB_PASSWORD` in the root `.env`.

### 7.4 TLS and credentials

- RDS PostgreSQL 15+ ships `rds.force_ssl = 1` in the default parameter group. The client must set
  `ssl` and the image must carry the RDS CA bundle. With no local Postgres, this fails first in AWS
  — expected, and called out in the plan's first deploy task.
- Password path: `random_password` → SSM `SecureString`, free and immediate to delete, reusing the
  pattern `ecs-dynamodb-rps/infra/main/collector.tf` already uses for Grafana tokens. **Amended
  2026-09-22** in `docs/superpowers/plans/2026-09-21-ecs-rds-postgres-pool-infrastructure.md` (ruling
  R19): neither exists any more. The password is `DB_PASSWORD` in the root `.env`, forwarded by
  `platform/` through the shared HCP variable set as the sensitive `db_password` variable.
- **RDS Proxy requires AWS Secrets Manager** plus an IAM role. Secrets Manager deletes with a
  recovery window of 7–30 days by default, so a destroy/re-apply cycle collides with "a secret with
  this name is scheduled for deletion". **`recovery_window_in_days = 0` is mandatory** in a lab
  destroyed daily.

### 7.5 Teardown survivors

`terraform destroy` succeeding is not evidence the account is clean. The list is longer here than
for the sibling:

| survivor | prevention |
|---|---|
| final snapshot | `skip_final_snapshot = true` |
| automated backups | `backup_retention_period = 0`, `delete_automated_backups = true` |
| `/aws/rds/instance/<id>/postgresql` log group | declare `aws_cloudwatch_log_group` explicitly with retention so Terraform owns it |
| DB subnet group, parameter group | own them explicitly; cheap, but they block a clean re-apply |
| Secrets Manager secret | `recovery_window_in_days = 0` (§7.4) |
| the proxy | deletes slowly and blocks the instance delete; expect a long destroy |

An RDS instance takes roughly 5–15 minutes to create and to delete. `/env down` already runs in the
background for the sibling — the env skill records an internet gateway alone taking 3m39s on ENI
detachment — and here it is worse.

### 7.6 Cost

**Estimates, not measured.** The repository's rule is that prices come from a query with the query
recorded, as `ecs-dynamodb-rps/service/pricing.json` does; this project owns its own
`pricing.json` and these figures are replaced by queried ones before any are published.

| item | estimate |
|---|---|
| idle baseline (ALB + 2 Fargate tasks), measured by the sibling | $0.055/hr |
| `db.t4g.micro`, single-AZ | ~$0.018/hr |
| 20 GiB gp3 | ~$0.003/hr |
| Performance Insights, 7-day retention | free |
| **idle, no proxy** | **~$0.076/hr** ≈ $55/month |
| RDS Proxy (per vCPU-hour, floor of 2 vCPU for T-class) | ~$0.030/hr |
| **idle, with proxy** | **~$0.106/hr** ≈ $77/month |
| knob 2 and 3 runs, at four tasks rather than one | higher for the duration of those runs only |

The proxy is the line to check first: ~40% of the idle bill for a component whose measured benefit
may be zero. That is an argument for running it last and destroying it immediately, which §6.2 does,
not for skipping it.

## 8. SLO and alerting

`slo.yaml` keeps the sibling's shape — `class_threshold_ratio` with fast/standard/heavy classes and
a separate `success_rate` availability objective — because pool wait is a *cause*, not something a
user feels. It belongs where throttles belong in the sibling: its own dashboard row and its own
alert rules, first-class, but not an SLO objective. No new SLI type is needed in the generator.

This satisfies the repository's "treat database metrics as first-class SLIs" constraint the same way
the sibling satisfies it: the saturation metrics get dedicated alert rules and are not objectives.

**The class thresholds are deliberately left unset until §5's calibration run.** Writing them before
the hold time is known would be inventing the assertion the project is supposed to test.

`infra/grafana/throttles.tf` becomes `saturation.tf`: `DBLoadRelativeToNumVCPUs`,
`DatabaseConnections` against the ceiling, `CPUCreditBalance`, and — for knob 3 only — borrow latency
and session pinning. **Amended 2026-09-21** in `docs/superpowers/plans/2026-09-21-ecs-rds-postgres-pool-infrastructure.md` (Task 11): the credit
rule watches `CPUSurplusCreditBalance > 0` (spent past the burst budget), not the balance, because an
unlimited-mode instance does not throttle on an empty balance, so no threshold on `CPUCreditBalance`
means anything.

`scripts/generate-slo.js` is copied, not shared, per the 2026-09-04 decision. Its `renderCapacityTfvars`
has no analogue and is replaced by the advisory print described in §4.3. **Both copies get a header
naming the sibling and the fork date**, so the next person grepping knows a second copy exists — the
known cost of copying is that a bug fixed in one stays broken in the other, and a header is the
cheapest mitigation.

## 9. Load profiles

Three shapes, copied in structure from the sibling and re-derived in content: `discovery.js` to find
the knee, `constant.js` at the discovered capacity, `stress.js` to breach deliberately. The request
mix and per-route bodies are designed for the SQL workload and for §5's hold-time target rather than
inherited from DynamoDB's cost model — decision D6, whose accepted consequence is that the two
projects' ledger rows no longer belong in one table. Each result stands alone.

A load profile is only comparable to itself: when measuring a knob, the infrastructure changes and
the k6 script does not — same VUs, same stages, same thresholds.

The k6 threshold encoding the SLO is written first and watched to **fail** against the small pool
before anything is changed. With no local test suite, this is the only place the red-first
discipline appears, and it is not optional.

## 10. What changes outside this project

1. **`platform/tfc.tf`** gains one line in `local.projects`:
   `"ecs-rds-postgres-pool" = { working_directory = "infra/main" }`. That creates the Terraform Cloud
   workspace and, through the project's own stack, its Grafana Cloud k6 project. `platform/` runs in
   local execution mode, needs the shell credentials, and is applied by hand — never through `/env`.
2. **`K6_CLOUD_PROJECT_ID` in the root `.env` stops being used.** There will now be two k6 projects,
   each created and destroyed with its own environment. Every reader goes through
   `terraform -chdir=infra/main output -raw k6_project_id` instead, which is the same rule the
   sibling's README already states about `base_url`: a copy elsewhere is just the stale one.
3. **The `/loadtest` skill's results table is DynamoDB-shaped.** Its header ends
   `… | throttles | RCU/WCU | $/hr |` and its throttle section queries `AWS/DynamoDB`. This project's
   columns want `pool wait p95`, `waiting peak`, `DBLoad/vCPU`, `connections`, `pool size`,
   `credit balance`, and for knob 3 `borrow latency p95` and `pinned`. The fix is for the skill to
   keep the shared spine — date, profile, infra change, RPS, both attainment columns, budget burn,
   p95 per class, `$/hr` — and take the project-specific columns from the project, so neither
   project's table carries the other's empty cells.

## 11. Target structure

```
ecs-rds-postgres-pool/
  infra/
    main/                    ROOT MODULE (TFC workspace ecs-rds-postgres-pool, working dir infra/main)
      network.tf             copied; no DynamoDB gateway endpoint, RDS subnet group instead
      rds.tf                 NEW   db.t4g.micro, subnet group, parameter group, Performance Insights
      proxy.tf               NEW   aws_db_proxy + secret + role, all count = proxy_enabled ? 1 : 0
      ecs.tf alb.tf ecr.tf   copied; DATABASE_URL and Pool.max from pool_size and the switched host
      collector.tf           copied minus the CloudWatch pipeline; the OTLP gateway pipeline stays
      heartbeat.tf           copied
      grafana.tf k6.tf       copied
      dev.tfvars             pool_size · desired_count · proxy_enabled · instance_class · seed_rows
    grafana/
      dashboard.json.tftpl   rows: request / pool / database / service / edge / SLI / latency
      saturation.tf          NEW   replaces throttles.tf (§8)
      alerts.tf slo.tf folder.tf locals.tf queries.json classmap.json alloy.alloy.tftpl
                             AMENDED 2026-09-21 by docs/superpowers/plans/
                             2026-09-21-ecs-rds-postgres-pool-infrastructure.md (decision D2):
                             locals.tf, alerts.tf and slo.tf are created in plan 3, not plan 2.
                             They are generated from slo.yaml's class thresholds (the SLI PromQL
                             and every burn-rate rule bake them in), and those thresholds stay
                             null until plan 3 calibrates them on the real instance.
    k6/
      tests/                 discovery.js constant.js stress.js + lib/ — shapes copied, mix re-derived
  service/
    prisma/schema.prisma     NEW   models; migrations/ generated
    src/                     server.js timing.js otel.js config.js handlers.js copied;
                             elu.js cloudwatch.js forked, cpu.js deliberately not (§4.3);
                             context.js NEW — AsyncLocalStorage carrying route and class;
                             pool.js NEW — the owned pg.Pool and its instrumented checkout;
                             db.js NEW — PrismaPg over that pool, and the four queries
    scripts/                 generate-slo.js (copied, with fork header), calibrate.js
    test/                    unit only — no integration suite, no local Postgres
  heartbeat/index.mjs        copied
  scripts/
    deploy-service.sh        copied; migrate and seed run at container start
    upload-k6.sh             copied
  slo.yaml                   thresholds frozen after §5, not before
  results.md                 the run ledger
  README.md                  what it provisions, how to run it, measured results
```

## 12. Execution shape

Eight phases across **four plans**, decided 2026-09-19 on
<https://claude.ai/artifact/Hx4CbhSWwQw17Yj7CZdYP6>. **Every `terraform apply` and `terraform
destroy` is its own task and stops for approval.** A subagent may write and `plan` HCL freely; it may
not apply it unprompted. Per-task verification for anything touching HCL is `fmt -check`,
`validate`, then a reviewed `plan`.

| plan | phase | what | gate |
|---|---|---|---|
| — | 0 | this spec | user review |
| **1** | 1 | all service code, written once; `slo.yaml` with thresholds left open | — |
| **2** | 2 | `platform/tfc.tf` line; root module with all knobs pre-wired; ends at a reviewed plan | — |
| **3** | 3 | apply, deploy, calibrate on the real instance (§5); freeze thresholds; regenerate; redeploy | ⛔ apply |
| **3** | 4 | baseline at pool 5 — watch the k6 threshold fail first (§9) | — |
| **4** | 5 | knob 1: `pool_size = 25` | ⛔ apply |
| **4** | 6 | knob 2: `desired_count = 4` | ⛔ apply |
| **4** | 7 | knob 3: `proxy_enabled = true`, against §6.2's pre-registered expectation | ⛔ apply |
| **4** | 8 | README with measured results, `results.md` complete, destroy, tagged-resource sweep | ⛔ destroy |

**Plan 4 contains no implementation, and that is a requirement on plans 1–2 rather than a property
of plan 4.** Every knob ships as inert code in the earlier plans: `pool_size`, `desired_count` and
`proxy_enabled` are Terraform variables, and the proxy with its secret and IAM role are
`count`-gated (§7.1), so releasing a knob is an edit to `dev.tfvars` and an apply — no code change,
no image rebuild, no redeploy. A plan 4 task is therefore: edit one line, apply, re-run the two
profiles unchanged, append a row.

**This extends to Grafana.** The proxy's dashboard row and its two alert rules — borrow latency, and
session pinning (§6.3) — are written in **plan 2**, not in plan 4. A panel querying a CloudWatch
metric that has no datapoints yet is harmless, and the `no_data_state = "OK"` handling the
saturation rules already require (§4.4) covers exactly that case. Deferring them to plan 4 would
make plan 4 implementation work and break the property above.

Plans are written as the work reaches them: plan 4's task detail depends on the discovered knee, the
VU sizing and the frozen class thresholds, none of which exist until plan 3 completes. No SLO or RPS
number is reported without the k6 output or Grafana query that produced it, from a run in the same
session.

## 13. Risks

| risk | mitigation |
|---|---|
| Calibration cannot find a hold time where the pool binds before database CPU | §5's target is a relationship; if it proves unreachable at `db.t4g.micro`, the honest answer is to report that and re-examine the instance class before running any comparison |
| Performance Insights refused on `db.t4g.micro` despite §3.3 | fall back to `db.t4g.medium`, redo §6.2's connection arithmetic against the new ceiling |
| `max_connections` is not ~112 | measure it with `SHOW max_connections` before knob 2 is sized (§6.2) |
| Knob 2 breaches the ceiling harder than intended and every run 5xxs | that is a result, recorded as one; knob 3 is then the test of whether the proxy recovers it |
| Borrow latency unit error of 1000× | confirm in the CloudWatch console before any panel or threshold (§6.3) |
| Credit depletion invalidates a run silently | §7.2's gate and the two recorded columns exist for exactly this (the surplus column is `CPUSurplusCreditBalance`, not `CPUSurplusCreditsCharged`, since 2026-09-21: Charged stays 0 on an instance destroyed daily — see `docs/superpowers/plans/2026-09-21-ecs-rds-postgres-pool-infrastructure.md`, Task 11) |
| `AsyncLocalStorage` overhead distorts the thing being measured | benchmark it the way the sibling benchmarked its instrumentation (`scripts/bench-otel.js`, 200k iterations, 0.51 µs/request) and record the number before trusting any result |
