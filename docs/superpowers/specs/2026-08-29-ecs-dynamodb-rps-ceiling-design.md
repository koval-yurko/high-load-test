# ecs-dynamodb-rps-ceiling — design

- **Date:** 2026-08-29
- **Status:** **partially executed** — revision 4 (2026-09-01).
  **Built and in force:** §4 infrastructure, §5 service, §6 capacity and cost model, §7 SLO,
  §8 load profiles and run protocol.
  **Not executed:** §9, the deliverable — no load test has been run against this environment, and
  `ecs-dynamodb-rps-ceiling/results.md` does not exist. §9's attribution half is additionally
  **withdrawn**: nothing names a bound resource any more (see the banner at §9).
  **Reversed decisions:** D7 (k6 as the SLI source) and D10 (measurement over the HTTP surface),
  each by a later spec carrying a pointer at the decision itself.
  Remaining work lives in `docs/superpowers/plans/2026-09-02-ecs-dynamodb-rps-ceiling-scale-and-measure.md`,
  which is **blocked**.
  > Project renamed to `ecs-dynamodb-rps` on 2026-09-03; paths and names below are pre-rename. See `docs/superpowers/specs/2026-09-02-ecs-dynamodb-rps-restructure-design.md`.
- **Plans:** `docs/superpowers/plans/2026-08-29-ecs-dynamodb-rps-ceiling.md` (complete — built the
  service, infrastructure, SLO and load profiles),
  `…/2026-09-01-ecs-dynamodb-rps-ceiling-observability-shakedown.md` (verifies the signal chain at
  free-tier capacity), then `…/2026-09-02-ecs-dynamodb-rps-ceiling-scale-and-measure.md` (the
  discovery run, the before/after comparison and teardown — §10 and §13 of this document).
- **Project directory:** `ecs-dynamodb-rps-ceiling/`
- **Supersedes:** nothing. This is the repo's first project spec.
- **Amended by:** `docs/superpowers/specs/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection-design.md`
  (2026-08-30), which reverses **D7** and amends §4, §5, §7, §8, §11 and §12. Each of those
  carries a pointer at the decision itself — do not rely on this line alone.
- **Amended by:** `docs/superpowers/specs/2026-08-31-ecs-dynamodb-rps-ceiling-attribution-via-metrics-design.md`
  (2026-08-31), which reverses **D10** and amends §5, §8 and §9. Each carries a pointer at the
  decision itself — do not rely on this line alone.

> ### ⚠️ D7 is no longer in force — read this before acting on §7
>
> This spec makes k6 metrics the SLI source (D7). **That decision is wrong and is being replaced.**
> Two reasons:
>
> 1. **Its stated justification has evaporated.** D7 avoided CloudWatch because it "needs a
>    CloudWatch datasource plus an IAM role for Grafana". Both already exist on the Grafana stack,
>    verified on 2026-08-30 against this AWS account.
> 2. **An SLI that only exists while a load test runs is not a service level indicator.** No error
>    budget accrues between runs, nothing is alertable, and a healthy service is indistinguishable
>    from an untested one. k6 measures a generator's experience of synthetic traffic — that is a
>    test result.
>
> **What does NOT change:** the *shape* of the objective in §7 — a class-threshold ratio, not a
> percentile — is still right, and for the reason §7 gives. Note the obvious substitute does not
> work either: the ALB cannot express per-class thresholds (one target group, no per-path routing),
> so falling back to `TargetResponseTime` would silently regress to the aggregate percentile §7
> already rejected. The SLI has to be emitted by the service, which is the only component that
> knows which route was hit and therefore which threshold applies.
>
> §7's objective stands. Its *source* does not.

**Revision 2 changes:** the service grows from two endpoints to four with different natural costs; the
SLO changes form from a percentile to a **ratio with per-class thresholds**; the capacity model becomes
a weighted sum over the endpoint mix; live `eu-central-1` prices replace the placeholder. Revision 1's
`p95 < 200 ms` single objective is superseded — see §7 for why it could not survive heterogeneous
endpoints.

---

## 1. Purpose

Find the maximum request rate a Node.js service on ECS Fargate can sustain while holding a stated
SLO, then deliberately exceed it, then change one thing and re-measure. The recorded before/after is
the deliverable; the infrastructure is only the apparatus.

This is also the repo's first project, so a second, equally real goal applies: **prove the measurement
loop itself**. `/env`, `/loadtest` and `/slo` have never been run against live infrastructure. Every
design choice below that trades realism for a faster provision/destroy cycle was made for this reason
and should be revisited for project #2, not treated as a general preference.

### Success criteria

1. A capacity number — RPS at the frozen endpoint mix — produced by a k6 run, not an estimate.
2. Evidence of **which resource bound first** at that number: the service or the database. A ceiling
   without an attributed cause is not a result.

   > **Withdrawn 2026-09-01.** Nothing names a bound resource any more. What a run records instead is
   > two raw metrics read side by side by a person — request latency, and DynamoDB
   > `ReadThrottleEvents` / `WriteThrottleEvents` — with nothing computing a verdict from them. Full
   > reasoning in
   > `docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-attribution-simplified-design.md`.
3. That same load profile re-run after one infrastructure change, with both results in `results.md`.
4. A cost figure attached to each SLO level: what the current ceiling costs per hour, and what the
   improved target would cost.
5. `terraform destroy` followed by a clean billable-resource sweep.

---

## 2. Decisions and why

| # | Decision | Rationale |
|---|---|---|
| D1 | DynamoDB, not DocumentDB or RDS Postgres | Fastest provision/destroy (~2–3 min vs 5–15), no NAT gateway required, no hourly instance cost, and — decisively — **no burstable CPU credits**. RDS `t4g.micro` and DocumentDB `t3.medium` bank and spend CPU credits, so a long stress run can leave the next run measuring a throttled machine. Comparability between runs *is* the deliverable, so a datastore that quietly breaks it is disqualifying for project #1. |
| D2 | Capacity discovery, not a pre-chosen bottleneck | The question is "how much can it take", so whatever saturates first *is* the answer. The discovery run reports what broke rather than assuming it. |
| D3 | Load from Grafana Cloud k6, zone `amazon:de:frankfurt` | Same city as `eu-central-1`, so RTT is a negligible slice of the latency budget. A laptop generator would spend 30–60 ms on the internet and would itself cap out at a few thousand RPS — at which point the "service ceiling" would be the laptop's. |
| D4 | Four endpoints with different natural costs, frozen mix | A single cheap `GetItem` measures a DB proxy, not a service. Endpoints spanning DB-bound to CPU-bound make the ceiling composite and let the two constraints be released independently (§9). |
| D5 | **Ratio SLI with per-class thresholds**, not a percentile | A percentile cannot compose across endpoints with different natural costs, and cannot produce an error budget. See §7 — this is forced, not preferred. |
| D6 | `billing_mode = "PROVISIONED"` | Provisioned capacity converts overload into **throttling**, on-demand converts it into **bill**. Note the cost argument does *not* hold: provisioned is 3.46× cheaper only at full utilisation, break-even is ~29%, and a lab environment that idles between runs sits near that line. The reason to provision is the **hard, visible ceiling** — not savings. |
| ~~D7~~ | ~~SLI source is k6 metrics, not CloudWatch~~ **REVERSED 2026-08-30 — do not act on this row.** The SLI is emitted by the service itself; k6 thresholds are a run gate, not the SLO. Replaced by `docs/superpowers/specs/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection-design.md` — see the banner at the top of this document. | ~~Making ALB `TargetResponseTime` authoritative needs a CloudWatch datasource plus an IAM role for Grafana.~~ **This justification was false by the time it was tested — both already exist on the stack.** The `Server-Timing` instrumentation in §5 is still valuable for *attribution*, but attribution is not the same thing as an SLI, and conflating them is the error this row made. CloudWatch metrics still appear on dashboards. |
| D8 | Seed via `npm run seed`, not Terraform resources | Thousands of `aws_dynamodb_table_item` resources would bloat state and slow every plan. This is seed *data*, not infrastructure, and it dies with the table on destroy. A deliberate, recorded deviation from the repo's "Terraform is the only way" rule — scoped to data only. |
| D9 | CPU work is `pbkdf2Sync`, tunable by iteration count | Deterministic, allocation-free, no GC noise, therefore the most reproducible option. Blocks the event loop **by design**: that produces a sharp knee (throughput ≈ 1/cpu_time on one thread) and catastrophic queueing past it, which is exactly what a latency SLO should catch. It is also honest work an API really performs. A spin loop would measure an invented benchmark. |
| ~~D10~~ | ~~`Server-Timing` + event-loop lag instrumentation~~ **REVERSED 2026-08-31 — do not act on this row.** The signals stay; the *transport* changes. `Server-Timing` and `GET /stats` are deleted and attribution moves to OTel instruments (`http.server.db.duration`, `http.server.cpu.duration`) plus CloudWatch. Replaced by **A1–A6** of `docs/superpowers/specs/2026-08-31-ecs-dynamodb-rps-ceiling-attribution-via-metrics-design.md`. | The premise — attributing the ceiling is the hard part — **stands and is why this was reversed.** Two things were wrong: measurement was published on the service's HTTP surface for a test harness's benefit, and event-loop lag was already flowing as `nodejs_eventloop_delay_*` from `RuntimeNodeInstrumentation`, making `/stats` pure duplication (verified live 2026-08-31). |

---

## 3. Naming

`ecs-dynamodb-rps-ceiling` — platform, datastore, scenario, per the `<platform>-<scenario>` convention.

This string is simultaneously the directory name, the AWS `Project` tag value applied via provider
`default_tags`, and the commit scope. `CLAUDE.md` requires it to be stable: renaming later orphans
tagged resources from the teardown sweep that exists to find them. **Fixed as of revision 1.**

`README.md`'s project table gains a row for it. `ecs-document-db` remains listed as not built.

---

## 4. Infrastructure (`terraform/`)

> **⚠ Amended by `docs/superpowers/specs/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection-design.md`.** Two changes: the workspace
> moves to **remote execution** (S12 — HCP workspace variables are only injected in remote mode, so
> credentials held in Terraform Cloud would otherwise be silently ignored), and the resource list
> below gains a **Grafana Alloy collector service**, a Cloud Map private DNS namespace, a collector
> security group and a CloudWatch-read IAM role. The collector is always-on and billable: it roughly
> doubles this environment's idle cost.

All resources carry `Project = "ecs-dynamodb-rps-ceiling"` via `default_tags` on the AWS provider.
State lives in a dedicated Terraform Cloud workspace, ~~local~~ **remote** execution mode.

| resource | configuration | notes |
|---|---|---|
| VPC | two **public** subnets, two AZs | |
| Internet gateway | | required; Grafana Cloud generators arrive from the public internet |
| ALB | internet-facing, HTTP | target group health check on `/healthz` |
| ECS cluster | Fargate | |
| ECS service | **0.25 vCPU / 512 MB** (see §5 budget), `assign_public_ip = true` | public IP is what makes the ECR pull work without a NAT gateway |
| DynamoDB table | `PROVISIONED`, hash key `pk` (S), range key `sk` (S), TTL on `expires_at` (N) | composite key is required for the `Query`-based feed endpoint; capacity from §6 |
| VPC endpoint | **gateway** endpoint for DynamoDB | gateway endpoints are not billed hourly, unlike interface endpoints |
| ECR repository | `force_destroy = true` | so `destroy` does not strand images |
| CloudWatch log group | explicit resource, `retention_in_days = 1` | an implicitly-created log group survives `destroy` and bills forever |

**There is no NAT gateway in this design.** The repo's own README puts one at roughly $32/month, and it
is the single most common survivor of a careless teardown. Public subnets plus a free gateway endpoint
remove the need for one entirely. This is a lab, not production; the security trade-off is accepted
and deliberate.

**Key schema note:** revision 1 used a bare hash key. The feed endpoint needs `Query`, which requires a
partition holding multiple items, so the table takes a composite key: `pk` (the feed/partition id) and
`sk` (the item id within it).

---

## 5. Service (`src/`)

Node.js 22, AWS SDK v3.

### The CPU budget, which constrains everything else

A Fargate task at 0.25 vCPU gets **250 ms of CPU per second**. At 1000 RPS that is **250 µs per
request on average** — covering HTTP parsing, SDK v3 signing, marshalling, application logic and GC.
Added CPU work is therefore measured in *tens to hundreds* of microseconds, not milliseconds.

| task size | CPU/sec | @500 RPS | @1000 RPS | @2000 RPS |
|---|---|---|---|---|
| 0.25 vCPU | 250 ms | 500 µs | **250 µs** | 125 µs |
| 0.5 vCPU | 500 ms | 1 ms | 500 µs | 250 µs |
| 1 vCPU | 1000 ms | 2 ms | 1 ms | 500 µs |

Because the heavy endpoint is only 5% of traffic, it can afford far more than the average. A worked
starting allocation at 0.25 vCPU and 1000 RPS: cheap read+write ≈150 µs each (105 ms/s combined), feed
≈300 µs (75 ms/s), leaving roughly **70 ms/s for 50 reports/s ≈ 1.4 ms each** — on the order of
700–1400 `pbkdf2` iterations. Workable at 0.25 vCPU, but with little slack; if calibration shows the
knob has no usable range, the task sizes up to 0.5 vCPU (§11).

### Endpoints

| endpoint | DB work | RCU/req | WCU/req | CPU work | class |
|---|---|---|---|---|---|
| `GET /healthz` | none | — | — | none | — |
| `GET /items/:pk/:sk` | `GetItem`, ≤1 KB | 0.5 | 0 | negligible | **fast** |
| `POST /items` | `PutItem`, ≤1 KB | 0 | 1 | negligible | **fast** |
| `GET /items/:pk/feed` | `Query`, 20×1 KB | 2.5 | 0 | sort + aggregate + serialize | **standard** |
| `POST /reports` | `Query` 20 + `PutItem` | 2.5 | 1 | `pbkdf2Sync`, tunable | **heavy** |

**Frozen traffic mix: 55% / 15% / 25% / 5%** (cheap read / cheap write / feed / report). A realistic
long-tail shape. This mix is now as load-bearing as revision 1's 80/20 was: every capacity number and
every SLO figure is stated *at this mix*, and changing it invalidates all of them.

`/healthz` must not touch DynamoDB — otherwise a DB stall fails the health check and masks the real
failure as a deployment problem.

Items are kept **under 1 KB**. Item size is a direct multiplier on required capacity (§6) and, for
`Query`, the dominant one — so it is a fixed parameter of the experiment, not an incidental detail.

### Attribution instrumentation (D10)

> **⚠ SUPERSEDED IN FULL 2026-08-31 by `docs/superpowers/specs/2026-08-31-ecs-dynamodb-rps-ceiling-attribution-via-metrics-design.md` §3–§5.**
> `Server-Timing` and `/stats` are **deleted**, not merely demoted — the sentence below saying they "remain in
> place" was true only while the k6 scripts were frozen, and nothing has been measured, so they are not.
> Read that document instead of this section. The rest of this banner is retained for history.
>
> **⚠ Amended by `docs/superpowers/specs/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection-design.md`.** This section is no longer the
> only source, and one sentence in it is now false. `Server-Timing` and `/stats` **remain in place** —
> the k6 scripts are frozen and parse both — but OpenTelemetry instrumentation is primary, exporting
> to a cluster-wide collector. The false sentence is flagged inline below.

**`Server-Timing` response header** carrying per-request phase timings — `db;dur=3.1, cpu;dur=0.24`.
k6 reads response headers and records them as custom `Trend` metrics, so `db_ms` and `cpu_ms` land
directly in the k6 output — ~~which §7 makes the authoritative SLI source~~ **(no longer true: §7's
source is now the service's own metrics)**. This delivers server-side phase attribution *without* the
CloudWatch datasource D7 scoped out.

**Event-loop lag** via `perf_hooks.monitorEventLoopDelay()`, exposed on `/stats` and scraped by a
separate 1 RPS k6 scenario. Event-loop lag is the single best signal that the Node process rather than
the database is the constraint: when it climbs while `db_ms` stays flat, the CPU is the ceiling
regardless of what total latency says.

> **⚠ The last clause cannot happen.** The plan's execution found `db_ms` inflating **12.1×
> (10.9 ms → 131.9 ms) with the database unchanged**, because it is wall-clock around an `await` and
> therefore absorbs event-loop queueing. "`db_ms` flat while lag climbs" is unreachable. Use
> `ThrottledRequests == 0` plus DynamoDB's `SuccessfulRequestLatency` as the DB-bound discriminator;
> the gap between that and `db_ms` *is* the queueing signal. `@opentelemetry/instrumentation-aws-sdk`
> inherits the same flaw and does not fix it — see §11 of `docs/superpowers/specs/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection-design.md`.
>
> **Amended 2026-09-01 — do not act on the replacement this banner prescribes.** All three parts
> of it fail. `ThrottledRequests` cannot be the trigger: it reads zero at instants during
> sustained throttling and is published only per operation, so a table-level query matches
> nothing. `SuccessfulRequestLatency` cannot be the discriminator: it *falls* when the table
> throttles — 0.887 ms mid-throttle against 1.473 ms idle — because rejected requests are never
> served and never enter the statistic. And the gap against `db_ms` is not a clean queueing
> signal: it absorbs AWS SDK retry backoff, reading 642–938 ms while DynamoDB's own clock read
> 0.9–2.2 ms. See
> `docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-attribution-simplified-design.md`.

Together these make success criterion #2 achievable — DynamoDB `ThrottledRequests` climbing means DB
bound; event-loop lag climbing with flat `db_ms` means service bound.

> **Withdrawn 2026-09-01.** Both halves fail. `ThrottledRequests` reads zero at instants during
> sustained throttling and is published only per operation, so it cannot be the trigger; and every
> service-side signal — `db_ms`, event-loop lag, event-loop utilisation — is inflated by AWS SDK
> retry backoff held inside the Node process, so none of them separates "the queue is in Node because
> Node is slow" from "the queue is in Node because DynamoDB is rejecting us". Measured 2026-09-01:
> service-side DB timing 642–938 ms against DynamoDB's own 0.9–2.2 ms, event-loop delay 610 ms,
> utilisation 1.000, CPU 3–16%, while the table rejected 5,588 reads/minute. `ReadThrottleEvents` /
> `WriteThrottleEvents` are read beside request latency instead, with nothing computing a verdict.
> See `docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-attribution-simplified-design.md`.

### Seed data

Deterministic: 50 partitions (`feed-00` … `feed-49`) × 20 items each = 1000 items, written by
`npm run seed` using `BatchWriteItem`. Idempotent. 20 items per partition is what makes the feed
endpoint's `Query` cost exactly 2.5 RCU. 50 partitions rather than a handful because a narrow key
range concentrates traffic and can hit per-partition throughput limits — which would present as a
service ceiling while being nothing of the kind.

**Why the read path stays deterministic as the table grows:** reads only ever touch seeded keys;
writes only ever create new ones, under a separate `pk` prefix so they never enter a seeded partition
and never change a feed `Query`'s cost. DynamoDB `GetItem`/`PutItem` latency is independent of table
size. This property is specific to this datastore — the identical design on Postgres would drift.

---

## 6. Capacity and cost model

From DynamoDB's capacity definitions: an eventually-consistent read of an item ≤4 KB costs **0.5 RCU**;
a write of an item ≤1 KB costs **1 WCU**; a `Query` is charged on the **total bytes returned**, rounded
up to 4 KB — so 20×1 KB = 20 KB → 5 RCU strongly consistent → **2.5 RCU eventually consistent**, five
times a single `GetItem`.

Capacity is a weighted sum over the endpoint mix. At the frozen 55/15/25/5:

| endpoint | share | RCU at 1000 RPS | WCU at 1000 RPS |
|---|---|---|---|
| cheap read | 55% | 275 | — |
| cheap write | 15% | — | 150 |
| feed | 25% | 625 | — |
| report | 5% | 125 | 50 |
| **total** | **100%** | **1025** | **200** |

```
RCU = 1.025 · R
WCU = 0.200 · R
$/hr = 1.025R · p_RCU + 0.200R · p_WCU
R_max = budget_per_hour / (1.025 · p_RCU + 0.200 · p_WCU)
```

At the fetched `eu-central-1` rates this is **$0.000321165 per RPS per hour** — 1000 RPS costs
**$0.3212/hour**, about $0.96 for a three-hour session, and **$234/month if the environment is left
running**. The forgotten environment, not the load test, is the cost risk.

### Prices are fetched, never remembered

Retrieved from the AWS Pricing API on 2026-08-29 into `pricing.json`, which carries the region, the
date and the exact query. Provisioned: **$0.0001586**/RCU-hr, **$0.0007930**/WCU-hr. On-demand:
**$0.1525**/M read units, **$0.7625**/M write units. A documented refresh command regenerates it. No
price is ever typed from memory into this repo.

### Two findings, one of which inverted

**The on-demand multiple is mix-invariant.** On-demand costs **3.4615×** provisioned at full
utilisation, with break-even at **28.89%** — and these hold for *any* endpoint mix, because the
per-unit price ratio is uniform across reads and writes. Robust enough to state without qualification.

**The read/write cost split is not mix-invariant, and revision 1's headline finding was an artifact.**
Under the flat 80/20 `GetItem`/`PutItem` model, writes were 71% of the bill (a WCU costs exactly 5× an
RCU, and an eventually-consistent read is half a unit). Adding one `Query`-based endpoint flips it to
**reads 50.6% / writes 49.4%**. The durable lesson is not "writes are expensive" but **"bytes returned
per request is the cost driver"** — the feed endpoint alone is 61% of all RCU while being 25% of
traffic. Recorded because revision 1 stated the superseded version as a headline.

### Chart deliverable

`capacity-model.html` — RPS against required capacity and $/hour, per-endpoint contribution, and the
budget → `R_max` inversion. Built from `pricing.json` so it carries the same provenance as every other
number in the project.

---

## 7. SLO (`slo.yaml`)

> **⚠ Amended by `docs/superpowers/specs/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection-design.md`.** The **objective is
> unchanged** — a class-threshold ratio, for exactly the reasons this section gives, and that argument
> is why it survived. What changed is its **source** (k6 → the service's own OpenTelemetry native
> histograms, queried with `histogram_fraction`) and its **window** (see the subsection below).

### Why revision 1's `p95 < 200 ms` could not survive §5

A percentile across heterogeneous endpoints measures the traffic mix, not the system. With 55% of
traffic a ~5 ms `GetItem` and 5% a ~300 ms report, the aggregate p95 is dominated by the cheap
endpoint — **the report endpoint could fail completely without moving the number**. And a percentile
cannot produce an error budget, which `CLAUDE.md` requires for every run.

The constraint is also mechanical, not merely doctrinal: **`grafana_slo` is built on Success / Total.**
The provider's own example computes `$Success / $Total` through a math expression, takes
`objectives { value = 0.995, window = ... }`, and derives `alerting { fastburn / slowburn }` from that
ratio. It cannot express a percentile SLO at all. Since this repo applies SLOs through that resource,
a ratio SLI is the only form that fits the tooling.

This matches the standard definition — Google's SRE Workbook defines a latency SLI as *"the proportion
of valid requests served faster than a threshold"*, sets objectives per critical user journey rather
than per endpoint, and recommends multiple thresholds over the same population.

### The objective

> **⚠ The objectives below are now `95%` / `99%`, not `99%` / `99.9%`** (R1 and R2 of
> `docs/superpowers/specs/2026-09-09-ecs-dynamodb-rps-slo-relaxation-design.md`, relaxed
> 2026-09-09). At 99% the error budget was too small to observe a burn in any regime: the idle
> heartbeat alone spent 166% of the 7-day budget before a run started. **The class thresholds
> below did not change** — 50 / 200 / 800 ms stand, and everything this section says about *why*
> a class-ratio SLI was chosen over a percentile is untouched. The tail moved with the primary on
> purpose: at 95% the primary's fast-burn rule pages only above a 72% miss rate, and a 99% tail
> puts its own fast burn back at 14.4%, where the primary's used to be.

```
good  = latency < the request's class threshold  AND  not a 5xx
total = all valid requests

PRIMARY   ≥ 99%   of requests meet their class threshold
TAIL      ≥ 99.9% of requests meet 3× their class threshold

class thresholds
  fast      GET /items/:pk/:sk, POST /items      < 50 ms
  standard  GET /items/:pk/feed                  < 200 ms
  heavy     POST /reports                        < 800 ms
```

One headline number, one error budget, one burn rate — and every request judged against a target
appropriate to its work. This is the "average system" figure, computed so that the average is
legitimate.

**Per-class SLOs are recorded as secondary objectives**, ranked below the global one. This covers the
known weakness of a single ratio: a rare endpoint can fail completely without breaching it. At 5% of
traffic, `/reports` failing entirely drags the global to 95% and is caught; at 0.5% it would not be.
Secondary objectives are alerted on but do not gate decisions.

### The window mismatch, stated explicitly

> **⚠ The window is now `7d`, not 28–30 days** (S13 of `docs/superpowers/specs/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection-design.md`, corrected from `3d` on 2026-08-31 — Grafana's SLO API refuses any window outside 7–32 days).
> Grafana Cloud Free retains metrics for **14 days**, so a 30-day objective could never have been
> evaluated over the window it claimed. The argument below survives intact — run-scoped attainment
> plus a burn-rate multiple is still what makes a 5-minute run comparable to a budget — but every
> derived burn threshold changes with it. The committed 14.4×/1h and 6×/6h encode "2% and 5% of
> budget"; against 72 hours they would silently mean 20% and 50%, so the alert windows become **6m**
> and **36m**.

A Grafana SLO window is ~~28–30 days~~ ~~3 days~~ **7 days**; a k6 run is minutes. Same SLI, different windows. `results.md`
therefore records **run-scoped attainment** *and* the **burn-rate multiple** — observed error rate ÷
budgeted error rate — which is what `fastburn`/`slowburn` alert on and what makes a short observation
comparable to a long-window budget. "Burned budget 14× faster than sustainable" travels between runs;
"burned 0.03% of a 30-day budget" does not.

### One file, four outputs

`slo.yaml` generates the k6 thresholds, the Grafana alert rules, the `grafana_slo` objective, and the
DynamoDB capacity tfvars. The SLO literally sizes the database, so capacity and target cannot drift
apart. Capacity inputs (target RPS, endpoint mix, item sizes, read consistency, `Query` page size)
live alongside the objectives in the same file.

---

## 8. Load profiles (`k6/`) and run protocol

All runs: `k6 cloud run`, load zone `amazon:de:frankfurt`.

| shape | executor | purpose |
|---|---|---|
| **A — discovery** | `ramping-arrival-rate` | climb RPS until the SLO breaks; the knee is the capacity number |
| **B — constant** | `constant-arrival-rate` at the discovered RPS | the repeatable baseline every later run is compared against |
| **C — stress** | `ramping-arrival-rate` to ~3× the knee | deliberately burn the SLO and spend error budget |

~~Plus a **`stats` scenario** at 1 RPS in every run, polling `/stats` for event-loop lag (§5).~~
> **⚠ DELETED 2026-08-31** by `docs/superpowers/specs/2026-08-31-ecs-dynamodb-rps-ceiling-attribution-via-metrics-design.md` §4. `/stats` no longer exists; event-loop lag comes from
> `nodejs_eventloop_delay_*`, which the service has been emitting all along. k6 records only what a client
> can observe (**A7**).

**Arrival-rate, never `ramping-vus`.** VUs measure concurrency, not throughput: under load a VU simply
waits longer, so a VU ramp stops adding RPS exactly when the measurement needs it most.

**VUs are pre-allocated.** k6's documentation warns that allocating VUs mid-test has CPU and memory
cost on the generator and can skew results. `maxVUs` is used only during the first exploratory
calibration of shape A, then pinned.

**The endpoint mix is enforced in k6, deterministically** — `exec.scenario.iterationInTest % 20`
mapped to the 55/15/25/5 split (11/3/5/1 of every 20 iterations) — giving the exact ratio off a single
stage array with no sampling variance between runs. Not `Math.random()`.

**Metrics recorded per run:** the `slo_met` `Rate` (~~the primary SLI~~ **the run gate** — see below),
`http_req_duration` tagged by endpoint class as sub-metrics, the `db_ms` and `cpu_ms` `Trend`s from
`Server-Timing`, event-loop lag, and DynamoDB `ThrottledRequests`.

> **⚠ Amended by `docs/superpowers/specs/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection-design.md`.** k6's `slo_met` is a **run
> gate**, not the SLO: an in-band assertion that this particular run passed, evaluated by k6 itself
> with no datasource involved. It keeps working exactly as written and nothing here needs changing.
> The scripts stay frozen, so the 1 RPS `stats` scenario also stays even though the service now
> exports event-loop lag continuously — a profile is only comparable to itself.
>
> Expect the two attainment figures to **disagree**: k6's is client-side and includes Frankfurt RTT
> and ALB queueing; the service's includes neither. `results.md` must label which is which.

**Mandatory warm-up/drain before every run** — see §10. Not optional.

Once shape A has produced a number, **all scripts are frozen**. Per `CLAUDE.md`, a profile is only
comparable to itself: improvements change infrastructure, never the script.

### Reporting rule

A capacity result is never written as "N RPS". It is always **"N RPS at the 55/15/25/5 mix"**, with the
bound resource named. The mix travels with the number into `results.md`, the README, and any chart.

> **Amended 2026-09-01.** The mix half of this rule stands; "with the bound resource named" does
> not — nothing names a bound resource any more. A result carries the RPS at the mix plus the two
> raw metrics, request latency and DynamoDB `ReadThrottleEvents` / `WriteThrottleEvents`, read side
> by side by a person. See
> `docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-attribution-simplified-design.md`.

---

## 9. The improvement and the deliverable

Baseline: 1 task, fixed count, DynamoDB capacity sized **from the budget** via the §6 `R_max`
inversion — not from the discovered ceiling, which does not exist yet at the time capacity is
provisioned (§13 sets capacity at step 5; shape A does not run until step 7).

The CPU knob is calibrated so the **service ceiling sits at roughly 70% of the budgeted DB ceiling**.
That makes the sequence deterministic rather than lucky:

1. **Run A** → the service binds first: event-loop lag climbs, ~~`db_ms` stays flat~~, `ThrottledRequests`
   is zero. **Change: autoscale 1→4 tasks.**
2. **Re-run** → service ceiling is now ~2.8× the DB ceiling, so **DynamoDB throttles**: `db_ms` climbs,
   `ThrottledRequests` rises, ~~event-loop lag stays flat~~. **Change: raise capacity per §6.**

> **⚠ The evidence clauses above are wrong; the sequence is right.** `db_ms` cannot "stay flat" while
> the service binds — it wraps an `await` and absorbs the queueing (12.1× inflation measured, DB
> unchanged).
>
> **Amended twice. Read the second amendment; the first is void.**
>
> - *2026-08-31* replaced the evidence with a four-row table keyed on `ThrottledRequests`,
>   `SuccessfulRequestLatency`, the gap between that and in-process `db`, and CPU. **That table was
>   deleted on 2026-09-01** after it misattributed a DynamoDB throttling event to the service.
> - *2026-09-01* — `docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-attribution-simplified-design.md`
>   — replaces it with **two metrics read side by side, with nothing computing a verdict**: request
>   latency (`http_server_request_duration_seconds`, per route) and DynamoDB throttle events
>   (`ReadThrottleEvents` / `WriteThrottleEvents`, per-minute counts of rejected requests at table
>   level). Latency up with throttle events non-zero means the database was rejecting the service;
>   latency up with them at zero means it was not.
>
> **The phrase "each with the evidence that identified it" below no longer describes a deliverable.**
> Nothing names a bound resource, and the results file drops its `bound resource`, `evidence` and
> `queueing ms` columns. The service-binds-then-DB-binds *ordering* is still what the experiment
> expects.
3. **Re-run** → both constraints released; record the new ceiling and the new $/hour.

Two before/after pairs from one environment, each releasing a different constraint, **each with the
evidence that identified it**. That is a stronger deliverable than a single autoscaling comparison,
and it demonstrates the measurement loop can tell the two constraints apart — which is the thing this
project exists to prove.

If run A contradicts the calibration and the DB binds first, that is a result, not a failure: report
it, and swap the order of steps 1 and 2.

`results.md` records per run: RPS achieved, **the bound resource and the evidence**, SLO attainment
(primary and per-class), error budget burned, burn-rate multiple, p95/p99 by class, `db_ms`/`cpu_ms`
split, event-loop lag, `ThrottledRequests`, provisioned RCU/WCU, **$/hour**, and the one change
distinguishing it from the previous run.

> **⚠ Amended 2026-08-31** by `docs/superpowers/specs/2026-08-31-ecs-dynamodb-rps-ceiling-attribution-via-metrics-design.md` §9.
> The `db_ms`/`cpu_ms` split and event-loop lag come from **Grafana, not the k6 summary** — k6 no
> longer records them. Two columns are added: `bound resource` and `queueing ms`. `SLO attainment`
> remains two distinct columns (`k6 attainment`, `service attainment`) per the 2026-08-30 plan.

---

## 10. Hazards

**DynamoDB burst capacity — mandatory mitigation.** Unused capacity is banked for up to ~300 seconds.
A run starting from an idle table will not throttle immediately, so its result depends on how idle the
table was beforehand. This is the same class of reproducibility trap that disqualified RDS and
DocumentDB under D1; choosing provisioned mode reintroduces it in a different form. Mitigation: a
**fixed drain/warm-up period before every run**, identical across runs, so each starts from the same
burst state. A run performed without it is not comparable and must not be recorded.

**Throttling presents as latency before it presents as errors.** The SDK retries
`ProvisionedThroughputExceededException` with backoff, so under-provisioning inflates latency first and
raises the error rate only once retries are exhausted. A latency breach must be checked against
`ThrottledRequests` before being attributed to the service — which is precisely what D10's
instrumentation exists to make possible.

**`pbkdf2Sync` blocks the event loop by design (D9).** Past the knee, latency does not degrade
gracefully — it queues, and every endpoint degrades together including the cheap ones. Expected and
wanted, but it means the *fast* class will breach at nearly the same moment as the *heavy* class, and
that is not evidence the fast path is slow.

**The endpoint mix is now load-bearing.** Revision 1 froze one ratio; this revision freezes four
shares, a `Query` page size and an item size. Every capacity coefficient in §6 and every SLO figure in
§7 is stated at those values. Changing any of them invalidates all recorded numbers.

**TTL is not prompt cleanup.** DynamoDB TTL deletion is asynchronous and can lag well behind the
timestamp. It will not keep the table small during a session. The actual cleanup is
`terraform destroy`. `expires_at` exists as insurance against a long-lived environment, nothing more.

**Grafana Cloud VU-hours are the binding budget.** AWS costs here are small; the number of times these
runs can be repeated is limited by the k6 plan allowance. Check it before a long shape-A ramp.

**Public-subnet tasks.** Tasks hold public IPs so the ECR pull works without a NAT gateway. Security
groups are the only barrier. Accepted for a disposable lab; not a pattern to carry into production.

---

## 11. Open parameters

Each has a defined resolution method. None blocks writing the implementation plan.

| parameter | resolved by |
|---|---|
| DynamoDB hourly budget | user decision, informed by `capacity-model.html` |
| Baseline RCU/WCU | derived from the §6 weighted model once the budget is set |
| Fargate task size (0.25 vs 0.5 vCPU) | §5 calibration — size up if the CPU knob has no usable range at 0.25 |
| `pbkdf2` iteration count ⚠ | calibrated so the service ceiling lands at ~70% of the budgeted DB ceiling. **Re-opened:** the measured `2675` was calibrated against an *uninstrumented* service; OpenTelemetry costs CPU per request, so it must be re-derived. See `docs/superpowers/specs/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection-design.md`. |
| Shape A ramp stages and ceiling | first exploratory calibration run, then pinned |
| Shape C multiplier (~3× nominal) | set after the shape A knee is known |
| Warm-up/drain duration | chosen to exceed DynamoDB's ~300 s burst window, then fixed |
| `amazon:de:frankfurt` availability on this plan | `k6 cloud load-zone list` before any cloud run |
| Global `.env` and `AWS_ACCOUNT_ID` | **must exist before step 3.** No `.env` is present as of this revision, so credentials currently resolve from the machine's default profile and `/env`'s account assertion has nothing to check against. |

---

## 12. Out of scope

- CloudWatch as the authoritative SLI source (D7) — dashboards only. **Still true**, but note that
  `docs/superpowers/specs/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection-design.md` routes CloudWatch metrics into the
  *same* Prometheus datasource as the service metrics, so DB-side attribution now sits beside
  service-side latency in one query. It is attribution, never the SLI.
- DynamoDB table autoscaling — deliberately excluded from the baseline, since autoscaling within a max
  weakens the strict-ceiling property of D6. Available as a later improvement lever.
- Moving CPU work off the event loop (worker threads, async crypto) — a legitimate future "change one
  thing", deliberately not part of the first comparison.
- Multi-AZ or any production hardening beyond two subnets for ALB requirements.
- HTTPS/ACM. Plain HTTP; RTT and TLS handshake cost are not what is being measured.
- `ecs-document-db` — remains a separate project with its own spec.

---

## 13. Sequencing and approval gates

`terraform apply` and `terraform destroy` create and delete billable AWS resources. Per `CLAUDE.md`
each gets **its own plan task that stops for approval**. A subagent may write and `plan` Terraform
freely; it may not apply it.

1. Global `.env` created and `AWS_ACCOUNT_ID` pinned (§11). Scaffold project directory; service code
   with the four endpoints, `Server-Timing` and `/stats`; `npm run seed`; Dockerfile.
2. Terraform written, `fmt -check`, `validate`, reviewed `plan`.
3. **[GATE] `terraform apply`.**
4. Push image, seed, smoke test; confirm baseline per-class latency and that the class thresholds are
   achievable at all.
5. Budget set from `capacity-model.html`; RCU/WCU derived; `pbkdf2` iterations calibrated per §9.
6. `slo.yaml` and its four generated outputs.
7. Calibrate and run shape A → the capacity number **and the bound resource**. Freeze all scripts.
8. Runs B and C at baseline.
9. First change (autoscaling) written and `plan`ed.
10. **[GATE] `terraform apply`.**
11. Re-run B and C identically; second change (capacity) if the DB now binds.
12. `results.md`, chart, project README.
13. **[GATE] `terraform destroy`** + billable-resource sweep.

> **Amended 2026-09-01.** Step 7 no longer yields a bound resource — it yields the capacity number
> plus request latency and DynamoDB `ReadThrottleEvents` / `WriteThrottleEvents`, read side by
> side. Step 11's condition is an observation rather than a judgment: raise capacity if the re-run
> left throttle events non-zero. See
> `docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-attribution-simplified-design.md`.

---

## 14. Provenance

Facts verified while writing this spec, rather than recalled:

- `amazon:de:frankfurt` is a real Grafana Cloud k6 load zone; per-stack availability is confirmed with
  `k6 cloud load-zone list`.
- k6 documents that mid-test `maxVUs` allocation can overload the generator and skew results.
- `aws_dynamodb_table` supports `billing_mode = "PROVISIONED"` with `read_capacity`/`write_capacity`,
  a `ttl` block, and DynamoDB autoscaling via `aws_appautoscaling_target` on
  `dynamodb:table:ReadCapacityUnits`.
- `grafana_slo` takes a Success/Total ratio query, an `objectives { value, window }` block, and
  `fastburn`/`slowburn` alerting — it has no percentile form. This is what forces D5.
- `eu-central-1` DynamoDB prices fetched live from the AWS Pricing API on 2026-08-29 and stored in
  `pricing.json` with the query that produced them.
