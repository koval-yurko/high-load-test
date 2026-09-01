# ecs-dynamodb-rps-ceiling — service-emitted SLI collection

- **Date:** 2026-08-30
- **Status:** **complete** (2026-08-31). All 18 tasks of
  `docs/superpowers/plans/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection.md` executed and
  verified; decisions S1–S18 all stand. The service emits its own latency distribution, Alloy
  forwards it and the CloudWatch metrics found by the `Project` tag, and the SLO plus four burn-rate
  rule groups are generated from `slo.yaml`. Two deviations: Task 14 was folded into Task 16, and
  Grafana Synthetic Monitoring was abandoned for an EventBridge Scheduler heartbeat after the tenant
  proved disabled at the account level.
  **One claim in this document has since been narrowed** — the continuous error budget it builds is
  informational, not authoritative; see the pointer at §17.1.
- **Project directory:** `ecs-dynamodb-rps-ceiling/`
- **Amended by:** `docs/superpowers/specs/2026-08-31-ecs-dynamodb-rps-ceiling-attribution-via-metrics-design.md`
  (2026-08-31), which extends this pipeline with two phase histograms and amends **§11**. S1–S12 all stand;
  it reverses nothing here.
- **Amended by:** `docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-slo-scope-design.md`
  (2026-09-01), which settles **§17.1** and narrows this document's error-budget claim: the continuous
  window *does* accrue a budget, but over ~4 req/min its noise floor exceeds the objective, so it is
  **informational** and authoritative attainment is run-scoped. See the pointer at §17.1 itself — do
  not rely on this line alone. S1–S18 all stand.
- **Amends:** `docs/superpowers/specs/2026-08-29-ecs-dynamodb-rps-ceiling-design.md` — see §15 for the
  decision-by-decision map. It is not superseded: §4, §6, §9 and §10 of that document remain in force
  and Tasks 1–17 of its plan stand.
- **Unblocks:** Tasks 18–23 of `docs/superpowers/plans/2026-08-29-ecs-dynamodb-rps-ceiling.md`, which
  are on hold precisely because they would write a k6 pass rate into `results.md` under the label
  "SLO attainment".

> **Decisions in this document are numbered `S1…S12`,** deliberately not continuing the 2026-08-29
> spec's `D1…D10`. Two documents describing one project must never share a numbering space — a
> reference to "D7" has to resolve to exactly one row, forever.

---

## 1. Purpose

Compute the SLO from **real service metrics, continuously**, instead of from load-test output.

The 2026-08-29 spec made k6 metrics the SLI source (its D7). That decision is reversed, for a reason
that has nothing to do with tooling: **an SLI that only exists while a load test runs is not a
service level indicator.** No error budget accrues between runs, nothing is alertable, and a healthy
service is indistinguishable from an untested one. k6 measures a generator's experience of synthetic
traffic — a test result, not a service level.

k6 thresholds are **not removed**. They are demoted to a *run gate*: an in-band assertion that a
particular run passed, evaluated by k6 itself with no datasource involved. That mechanism works
today and needs nothing added. What moves is the label "SLO", off k6 and onto the service's own
metrics.

**The objective's shape does not change.** §7 of the 2026-08-29 spec — a class-threshold ratio, not a
percentile — stands, for the reasons it gives: a percentile cannot compose across endpoints with
different natural costs, cannot produce an error budget, and cannot be expressed by `grafana_slo` at
all. Only the *source* of the ratio changes.

### Success criteria

1. The class-threshold ratio is queryable in Grafana over any window, from data the service emits,
   with no load test running.
2. `grafana/alerts.tf` is wired into the Terraform root module, validated against the provider, and
   its queries read series that actually exist.
3. DynamoDB-side attribution signals (throttles, consumed capacity, `SuccessfulRequestLatency`) sit
   in the **same datasource** as the service metrics, so attribution is one query rather than two
   panels compared by eye.
4. The per-request CPU cost of the instrumentation is measured on real Fargate hardware and recorded,
   and `pbkdf2_iterations` is re-derived against the instrumented service.
5. `terraform destroy` still leaves nothing billable — including the new collector service and its
   Cloud Map namespace.

---

## 2. What was ruled out, and why it stays ruled out

Recorded because each is a plausible-looking answer that a later reader will re-propose.

| rejected | why |
|---|---|
| **ALB `TargetResponseTime` as the SLI** | The ALB cannot express per-class thresholds: one target group, no per-path routing (`terraform/alb.tf`). It would silently regress to the aggregate percentile §7 of the 2026-08-29 spec already rejected. The service is the only component that knows which route was hit and therefore which threshold applies. |
| **Logs as the metrics pipeline, including CloudWatch EMF** | Not wanted for a high-load system. |
| **Per-request I/O of any kind** | At 1000 RPS on 0.25 vCPU the entire CPU budget is ~250 µs *per request*. Per-request serialization or emission would perturb the ceiling being measured. |
| **A `good`/`total` counter pair computed in the service** | Considered and rejected during design: a counter that says "this request was good" encodes a threshold comparison — SLO logic wearing a counter's clothes. Superseded by S3. |
| **An external scrape of `/metrics` through the ALB** | The ALB round-robins across a single target group, so consecutive scrapes of one series hit different tasks and return unrelated counter values. That manufactures the "reset that looks like an outage" failure by construction. A load balancer cannot be a scrape target for a multi-instance service. |
| **A per-task collector sidecar** | Fargate's CPU limit is per **task**, not per container, so a sidecar draws from the same 250 ms/s that `pbkdf2_iterations = 2675` was calibrated against. It would also poll CloudWatch once per task — four collectors, four times the series and the API charges, under 1→4 autoscaling. Superseded by S1. |

---

## 3. Decisions and why

| # | Decision | Rationale |
|---|---|---|
| S1 | **One collector for the cluster (gateway), not a per-task agent** | Nothing competes for the app task's 0.25 vCPU, so `task_cpu` stays 256 and the CPU knob keeps meaning what it meant. It also makes the CloudWatch pull affordable: table-level metrics are polled once, not once per task. |
| S2 | **Grafana Alloy as the collector** | Its `prometheus.exporter.cloudwatch` embeds YACE and supports **discovery jobs keyed on resource tags**, so it finds this project's table, ECS service and ALB via the `Project = ecs-dynamodb-rps-ceiling` tag `CLAUDE.md` already mandates on every resource. No ARNs in configuration, and the config survives a destroy/recreate cycle unchanged. ADOT's CloudWatch receiver wants the resources enumerated. |
| S3 | **No SLO logic in the service** | The service emits a *distribution*; the objective is applied at query time. It holds no thresholds, computes no ratio and renders no verdict. This is what makes the objective changeable without a deploy, and it is why the counter pair was dropped. |
| S4 | **Native histograms, via OTel exponential histograms** | `histogram_fraction(0, 0.05, rate(…))` yields the proportion below a threshold from a single series. Thresholds then exist *only* in Grafana: changing `heavy` from 800 ms to 600 ms is a query edit, not a rebuild. Verified enabled by default on Grafana Cloud (§14). |
| S5 | **OpenTelemetry is the only instrumentation library** | Metrics come from `@opentelemetry/*` instrumentation, not hand-written recording. This also makes the SLI contract portable: `lambda-concurrency-limit` can swap the exporter without changing what an SLI *is*, so the two projects' numbers stay comparable. |
| S6 | **Cumulative temporality, pinned explicitly** | If the collector is down, or the event loop is blocked past the knee so the export timer fires late, the next successful export carries full cumulative state. An outage costs resolution, never requests. Delta temporality would lose them, silently. This must be set, not left to a default. |
| S7 | **Per-task series identity via `service.instance.id`** | Prometheus's OTLP translation maps `service.instance.id` → `instance`. Without it, four tasks emit series with identical labels and collide — the reset-that-looks-like-an-outage failure. Read once at boot, never per request. |
| S8 | **`route → class` mapping lives in the collector, not the service** | An Alloy transform processor attaches `class` from `http.route`, generated from `slo.yaml`. The service supplies the *route template* — a naming fact only it knows, and the same one it already computes in `matchRoute` — but never the class, the threshold or the verdict. The SLO-bearing half of the mapping is external. |
| S9 | **Cloud Map private DNS for collector discovery** | `collector.<namespace>.local:4318`. The VPC already has `enable_dns_support` and `enable_dns_hostnames` (`terraform/network.tf`). Cheaper than an internal NLB (~$16/month, and a teardown survivor), and unlike ECS Service Connect it does not inject a proxy container into every task — which would reintroduce the sidecar S1 removes. |
| S10 | **CloudWatch metrics are pulled into Prometheus, not only queried via the datasource** | Puts DB-side attribution beside service-side latency in one datasource, so "the service bound" versus "the database bound" is one expression instead of two panels compared by eye. That is success criterion #2 of the 2026-08-29 spec. The existing CloudWatch dashboard stays as-is; this adds a path, it does not replace one. |
| S11 | **Grafana Cloud credentials as plain task-definition environment variables, held in Terraform Cloud** | User decision. Consequence: the workspace moves to **remote execution** (S12), and the value is readable by anyone holding `ecs:DescribeTaskDefinition`. Mitigations: the Terraform variable is `sensitive = true` so plan output redacts it, and the token is a metrics-push-only access policy so the blast radius is one write scope on one stack. |
| S12 | **Terraform Cloud workspace moves from local to remote execution** | Forced by S11: **HCP workspace variables are only injected in remote execution mode.** In local mode Terraform runs on the developer's machine and reads the root `.env`; workspace variables are ignored entirely, so "stored in Terraform Cloud" would be a no-op. AWS and Grafana provider credentials move to the workspace with it. The `terraform apply` approval gate is unaffected — the run is still CLI-initiated, so `.claude/hooks/guard-terraform.sh` still fires. |
| S13 | **SLO window is ~~`3d`~~ `7d`, not `30d`** (corrected 2026-08-31) | Grafana Cloud Free retains metrics for **14 days**, so a 30-day window could never be evaluated — it would look right and be wrong. This is a test lab; a 3-day budget is enough to demonstrate accrual and burn. Amends §7 of the 2026-08-29 spec, which asserts a 28–30 day window. |
| S14 | **Burn-rate alert windows scale with the SLO window** | The committed 14.4×/1h and 6×/6h are *derived* from a 30-day window — they encode "2% of budget" and "5% of budget". Left unchanged against 72 hours they silently become 20% and 50%. See §7 for the recomputed table. |
| S15 | **Everything is emitted; the SLO query selects** | No endpoint and no traffic source is filtered at source. `/healthz`, `/stats` and load-generator traffic all reach Grafana, and the SLO's denominator is a *selector*. This is the payoff of S3/S4: what counts as the population changes with no deploy, no rebuild and no loss of history. |
| S16 | **`traffic_source` is labelled now, even though the split is deferred** | Whether load-generator traffic belongs in the SLO population is unsettled and needs run data (§17). But a label not emitted today cannot be applied to yesterday's data: deferring the *decision* is free, deferring the *label* forecloses it. Bounded to `k6` / `synthetic` / `other` in the collector so an arbitrary internet user-agent cannot blow cardinality. |
| S17 | **Two egress paths, not one** | Service metrics leave by the OTLP gateway; CloudWatch metrics leave by `prometheus.remote_write`. Routing YACE's already-Prometheus-shaped output through OTLP and back would add a lossy conversion purely to save a credential — and that credential already exists in the root `.env` as `K6_PROMETHEUS_RW_*`. Only the OTLP gateway credential is new. |
| S18 | **Alloy config travels as a plain environment variable** | `ALLOY_CONFIG_CONTENT`, with the entrypoint override Grafana documents (§9). The config is not itself a secret — the credentials it references are, and S11 already placed those in plain environment variables, so an SSM parameter would add a resource and an IAM policy for no security gain. |

---

## 4. Topology

```
app task (n=1..4)                         collector service (n=1, always on)
  @opentelemetry/*                          Grafana Alloy
  task_cpu 256 / task_memory 512    OTLP      |
  ───────────────────────────────────────────>| otelcol.receiver.otlp
                                              |        │
  Cloud Map: collector.<ns>.local:4318        |        └──> otelcol.exporter.otlphttp ──> Grafana Cloud
                                              |                                            (native histograms)
  AWS CloudWatch ────────────────────────────>| prometheus.exporter.cloudwatch
      (discovery by Project tag)              |        └──> prometheus.remote_write ────> Grafana Cloud
                                                                                           (Prometheus)
```

The app task gains **no container and no CPU reservation**. Its only new outbound work is a
loopback-adjacent OTLP POST every 15 seconds inside the VPC.

Security groups: the collector's SG accepts 4317/4318 from the task SG only. The existing task SG's
egress is already `0.0.0.0/0`, so no change there. The collector runs in the same public subnets with
`assign_public_ip = true`, for the same reason the app does — the image pull and the Grafana Cloud
egress must work without a NAT gateway.

---

## 5. What the service emits

| package | purpose |
|---|---|
| `@opentelemetry/api`, `sdk-node`, `sdk-metrics` | meter provider, `PeriodicExportingMetricReader` at 15 s |
| `@opentelemetry/exporter-metrics-otlp-http` | OTLP to the collector; temporality pinned cumulative (S6) |
| `@opentelemetry/instrumentation-http` | `http.server.request.duration` with `http.route` — the SLI population |
| `@opentelemetry/instrumentation-aws-sdk` | ~~DynamoDB call counts, errors and **SDK retries**~~ **— emits NOTHING, and structurally cannot; REMOVED 2026-08-31.** Not merely unobserved: in the installed package only `BedrockRuntimeServiceExtension` implements `updateMetricInstruments`, while `DynamodbServiceExtension` — the only extension this service exercises — defines no metric instruments at all. It was not misconfigured; no configuration could have made it emit. Removed in `docs/superpowers/specs/2026-08-31-ecs-dynamodb-rps-ceiling-attribution-via-metrics-design.md` A2/risk 3. Still *not* a fix for the `db_ms` inflation — see §11 |
| `@opentelemetry/instrumentation-runtime-node` | `nodejs.eventloop.delay` — supersedes the `/stats` poll, **which was deleted 2026-08-31; this is now the only source** |
| `@opentelemetry/resource-detector-aws` | ECS task identity → `service.instance.id` (S7) |
| `@opentelemetry/resources`, `semantic-conventions` | resource and attribute naming |

A `View` applies `ExponentialHistogramAggregation({ maxSize: 160 })` to the duration histogram. The
160 is chosen to match Grafana Cloud's `max_native_histogram_buckets: 160` exactly (§14), not by
taste — a histogram exceeding the receiver's cap is rejected or downscaled at ingest.

### `http.route` is not free here

`@opentelemetry/instrumentation-http` cannot infer a route template on its own — it normally gets one
from a *framework* instrumentation (Express, Fastify), and this service deliberately runs raw
`node:http` with a hand-written router, because §5 of the 2026-08-29 spec budgets 250 µs per request
and a framework's overhead is a meaningful fraction of that.

Without `http.route`, every request carries only `http.target`, the class mapping of S8 has nothing to
key on, and the `/healthz` exclusion in §7 cannot be expressed. Worse, raw paths are **unbounded
cardinality**: `/items/feed-07/item-13` is a distinct label value per item.

So `matchRoute` in `src/handlers.js` — which already computes exactly this — must publish the matched
template (`/items/:pk/:sk`, not the concrete path) onto the request's active span. Whether
`instrumentation-http` then copies that onto the duration metric is listed in §14 as unverified; if it
does not, the fallback is one explicit histogram recorded by the server with `http.route` as an
attribute. Still OpenTelemetry, still no thresholds in the service.

~~**`Server-Timing` and `/stats` stay.**~~ **REVERSED 2026-08-31 — both are deleted.** The reasoning
below was sound and its premise simply expired: the k6 scripts were frozen only because a measured
run would have been invalidated by changing them, and **no run had happened yet**. Nothing was ever
frozen in the sense that mattered. See `docs/superpowers/specs/2026-08-31-ecs-dynamodb-rps-ceiling-attribution-via-metrics-design.md` A1 and A7.

~~The three k6 scripts are frozen (`CLAUDE.md`: a profile is only
comparable to itself) and `k6/lib/request.js` parses both. They stop being the *only* source; they do
not go away. The 1 RPS `stats` scenario in each profile becomes redundant but is not removed, for the
same freezing reason.~~

---

## 6. What the collector does

Two independent pipelines in one Alloy process.

**Pipeline 1 — service metrics.** `otelcol.receiver.otlp` → transform processor (attaches `class`
from `http.route`, per S8) → `otelcol.exporter.otlphttp` → the Grafana Cloud OTLP gateway. This path
is chosen because Mimir documents OTLP/HTTP as preserving exponential histograms in their existing
format; the remote-write path's handling of *exponential* (as opposed to classic) histograms is not
documented and is listed in §11 as something to prove rather than assume.

**Pipeline 2 — AWS metrics.** `prometheus.exporter.cloudwatch` → `prometheus.scrape` →
`prometheus.remote_write` (S17). **Discovery** jobs with `search_tags = { Project = "ecs-dynamodb-rps-ceiling" }`,
at `period = 60s`, `length = 300s`, ~~**`delay = 120s`**~~ (**see the correction in §16 — `delay` does not exist on this component; the lag is absorbed by `length` being 5x `period`**). CloudWatch publishes
with lag, so polling up to `now` returns empty recent periods and produces panels that look broken
during exactly the minutes of a load test. Collecting at minimum:

| namespace | metrics |
|---|---|
| `AWS/DynamoDB` | `ThrottledRequests`, `ReadThrottleEvents`, `WriteThrottleEvents`, `ConsumedReadCapacityUnits`, `ConsumedWriteCapacityUnits`, `SuccessfulRequestLatency` |
| `AWS/ECS` | `CPUUtilization`, `MemoryUtilization`, `LiveTaskCount` |
| `AWS/ApplicationELB` | `RequestCount`, `TargetResponseTime`, `HTTPCode_Target_5XX_Count` |

`TargetResponseTime` beside the service-side histogram is what gives the **queueing indicator** of
§11 — not a measurement of any request's queue time, and never part of the SLI.

The collector task role needs `cloudwatch:GetMetricData`, `cloudwatch:ListMetrics` and
`tag:GetResources`. The app task role is unchanged.

### This diverges from Grafana's documented ECS pattern, deliberately

Grafana documents Alloy on ECS as a **sidecar** in each application task definition. S1 rejects that:
Fargate's CPU limit is per task, so a sidecar draws from the 250 ms/s that `pbkdf2_iterations` is
calibrated against, and it would poll CloudWatch once per task rather than once per cluster.

Being off the documented path has consequences worth stating rather than discovering:

- The OTLP receiver arrives over the VPC rather than over loopback, so it needs the Cloud Map record
  of S9 and the security-group rule of §4 — neither of which the sidecar pattern requires.
- Grafana's documented command passes **`--stability.level=experimental`** for the native OTLP
  receiver path. That is a required argument here, not a detail (§9).
- Grafana's pattern sources the config from SSM Parameter Store; S18 uses a plain environment
  variable instead, for the reason S18 gives.

The full configuration is §16.

---

## 7. Where the SLO is computed

Entirely in Grafana.

```promql
# total — valid requests, health checks and the stats poll excluded
sum(histogram_count(rate(http_server_request_duration_seconds{
      job="ecs-dynamodb-rps-ceiling", http_route!~"/healthz|/stats"}[5m])))

# good — per class, the fraction under that class's own threshold, weighted by that class's count
  sum(histogram_fraction(0, 0.05, rate(http_server_request_duration_seconds{class="fast"}[5m]))
      * histogram_count(rate(http_server_request_duration_seconds{class="fast"}[5m])))
+ sum(histogram_fraction(0, 0.2,  rate(http_server_request_duration_seconds{class="standard"}[5m]))
      * histogram_count(rate(http_server_request_duration_seconds{class="standard"}[5m])))
+ sum(histogram_fraction(0, 0.8,  rate(http_server_request_duration_seconds{class="heavy"}[5m]))
      * histogram_count(rate(http_server_request_duration_seconds{class="heavy"}[5m])))
```

The TAIL objective is the same expression at `3×` each bound.

**The denominator is a selector, not a filter (S15).** `/healthz` and `/stats` are *emitted* and
appear on dashboards; they are excluded here because the arithmetic is decisive. The ALB health-checks
every 10 s per target, which over a 3-day window is ~25,900 requests at one task and ~104,000 at four,
against ~17,300 from Synthetic Monitoring. A denominator that is 1.5×–6× health check by volume, and
trivially fast by construction, reports a permanent ~100% that no user experience backs.

**Availability** and the exact treatment of 4xx are deliberately unsettled — see §17.

**This is what `grafana_slo` wants.** The resource takes a Success query and a Total query and derives
the ratio, the error budget and the burn-rate alerting itself — it has no input for a pre-computed
ratio, which is the mechanical reason S3 is not merely a preference.

### What this fixes in `grafana/alerts.tf`

That file exists, is **not** in the root module, and has never been validated against the provider.
Its top comment documents an unresolved precondition: its queries read `slo_met` from Prometheus,
which only exists after a *local* `k6 run -o experimental-prometheus-rw`, while all real runs are
`k6 cloud run` — which has no `-o` flag at all. This spec removes that precondition entirely: the
series exist continuously, emitted by the service.

### The window is `7d`, and that changes the burn arithmetic

> **CORRECTED 2026-08-31.** This section was written for `3d`. **Grafana's SLO API refuses any
> window outside 7–32 days** — `400 "Use time window of at least 7 days and at most 32 days
> instead of 3d"` — which the provider's own duration regex does not hint at. With free-tier
> retention capping the other end at 14 days, `7d` is the only usable value, and the burn windows
> that follow are **14m** and **84m**, not 6m and 36m. The arithmetic below is otherwise unchanged;
> substitute 7/30 for 3/30 as the scale factor. Note 300 s × 7/30 = **70s**, not a whole minute.

`slo.yaml` moves from `window: 30d` to **`window: 3d`** (S13). Grafana Cloud Free retains metrics for
14 days, so 30 days was never evaluable; the provider validates `window` against
`^\d+(ms|s|m|h|d|w|y)$`, so `3d` is accepted with no fixed enum to fight.

The committed burn multipliers must move with it. 14.4×/1h and 6×/6h are not conventions — they are
derived from a 30-day window and encode a *fraction of budget consumed*:

```
fast burn:  14.4 x (1h / 720h) = 2% of budget
slow burn:   6.0 x (6h / 720h) = 5% of budget
```

Left unchanged against 72 hours the same rules consume **20%** and **50%** instead — a "slow burn"
ticket that fires only once half the budget is gone, on an evaluation window that is 8.3% of the
entire SLO window. Scaling the alert windows by the same factor the SLO window shrank (720h → 72h,
÷10) preserves the intent exactly:

| | multiplier | window | budget consumed | `for` |
|---|---|---|---|---|
| fast burn (page) | 14.4× | **6m** | 2% | 1m |
| slow burn (ticket) | 6× | **36m** | 5% | 5m |

`alerts.tf` already carries a `computation` annotation on every rule showing its derivation. That
pattern stays, with this arithmetic, so the next reader can see the numbers were computed rather than
copied.

The file is rewritten against the §7 queries, wired into the root module, and validated. Its
selector also changes: the hand-passed `project="…"` k6 tag is replaced by `job="ecs-dynamodb-rps-ceiling"`,
which Prometheus's OTLP translation derives from the service's own `service.name` resource attribute.
That closes the documented fail-open gap where forgetting `--tag project=…` on a run made every rule
match zero series silently.

### The idle population

`/healthz` (every 10 s from the ALB health check) and `/stats` are excluded from the denominator.
Including them would report a permanent, meaningless 100% attainment between runs, backed by no user
experience whatsoever.

The population between runs is instead **Grafana Cloud Synthetic Monitoring**, checking all four
endpoints on a fixed interval from Frankfurt — the same zone the load tests originate in. This is
what makes the error budget accrue against real traffic when no test is running, which is the
premise of this entire document. Defined in Terraform alongside the rest of the Grafana resources.

---

## 8. `slo.yaml` and the generator

`slo.yaml` remains the single source. Its consumer set changes:

| output | before | after |
|---|---|---|
| `k6/lib/slo.js` | the SLO | the **run gate** — same file, demoted meaning |
| `terraform/capacity.auto.tfvars` | unchanged | unchanged |
| `grafana/alerts.tf` | k6-series queries, never applied | native-histogram queries, applied |
| Alloy class-map config | — | **new** — the `route → class` table of S8 |
| service thresholds | — | **none.** S3 means the service consumes nothing from `slo.yaml` |

`/slo` is documentation-only today; the four existing outputs were hand-written to its documented
spec, so "one file, four outputs, cannot drift" is currently enforced by discipline. This spec
**adds the generation script**, making `/slo --check` real drift detection. That is repo-scoped work
inside a project spec, matching the precedent of Task 13 in the 2026-08-29 plan.

Note the pleasing consequence of S3: the service is the one consumer that needs *nothing* generated
into it.

---

## 9. Terraform

**New**

| resource | note |
|---|---|
| `aws_service_discovery_private_dns_namespace` | `<project>.local` |
| `aws_service_discovery_service` | registers collector task IPs |
| `aws_ecs_task_definition` / `aws_ecs_service` (collector) | Alloy, `desired_count = 1`. Starting size 0.25 vCPU / 512 MB — a starting point, not a measured one; YACE's CloudWatch polling is the memory risk and the collector's own resource use must be checked before it is called sized. |
| `aws_security_group` (collector) | ingress 4317/4318 from the task SG only |
| `aws_iam_role` + policy (collector task) | `cloudwatch:GetMetricData`, `ListMetrics`, `tag:GetResources` |
| `aws_cloudwatch_log_group` (collector) | explicit, `retention_in_days = 1` — an implicit one survives destroy |
| `grafana_synthetic_monitoring_check` ×n | the idle population of §7 |
| `grafana_slo` | Success/Total from §7 |
| `grafana/alerts.tf` | wired into the root module at last |

**Changed**

- Workspace execution mode → **remote** (S12). AWS, Grafana provider and Grafana Cloud push
  credentials become workspace variables.
- Alloy configuration delivered as the plain `ALLOY_CONFIG_CONTENT` environment variable (S18),
  generated by Terraform from `slo.yaml`'s class map. Alloy does not read that variable itself, so the
  container overrides its entrypoint exactly as Grafana documents:

  ```hcl
  entryPoint = ["/bin/sh", "-c"]
  command    = ["printenv ALLOY_CONFIG_CONTENT > /tmp/config.alloy && exec /bin/alloy run --stability.level=experimental --server.http.listen-addr=0.0.0.0:12345 /tmp/config.alloy"]
  ```

  `--stability.level=experimental` is required for the native OTLP receiver path, not optional. The
  generated config must be checked against the ECS task-definition size limit at plan time — it is
  inlined into the definition, and the limit applies to the whole document.

**Teardown.** The collector service, its log group and the Cloud Map namespace are all new candidates
for surviving a careless destroy. Cloud Map namespaces in particular refuse deletion while any
service is still registered, which surfaces as a `destroy` failure rather than a silent survivor —
noisy, which is the good failure mode. The `/env down` sweep must cover all of them.

---

## 10. Consequences being accepted

**`pbkdf2_iterations = 2675` must be re-derived.** Not because of a sidecar — S1 removes it — but
because instrumentation costs CPU per request, and that knob was calibrated against an *uninstrumented*
service to place the service ceiling at roughly 70% of the DB ceiling. It is re-measured on a real
Fargate slice using the one-off task-override method that worked for Task 17 (`aws ecs execute-command`
is unavailable; a local `docker run --cpus 0.25` measures either an M-series core or QEMU emulation,
never an x86_64 Fargate slice).

The overhead is itself a result worth recording. *What OpenTelemetry costs per request at 0.25 vCPU*
is precisely the kind of number this repository exists to produce, and it belongs in `results.md`
rather than being absorbed silently into a re-calibration.

**The collector is a new always-on billable resource** — roughly $0.04/hour for 0.25 vCPU / 0.5 GB,
which approximately doubles the ~$0.041/hour idle cost of the environment. As always, the forgotten
environment is the cost risk, not the load test.

**CloudWatch `GetMetricData`** is charged at roughly $0.01 per 1000 metrics requested; the `period = 60s`
poll of §6 over ~15 metrics is on the order of $0.20/day. A 300 s period would be five times cheaper
and too coarse to resolve a 5-minute stress run, which is the thing it exists to resolve — so the
resolution is bought deliberately. Small, but not zero, and it accrues while idle. Both this and the
collector's own hourly cost stop at `/env down`.

**Two SLIs will disagree, by design.** k6's client-side `slo_met` includes RTT from Frankfurt and any
ALB queueing; the service's includes neither. `results.md` must label which is which. The divergence
is not a defect — it *is* the queueing measurement (§11) — but an unlabelled pair of numbers called
"attainment" is how a deliverable becomes untrustworthy.

---

## 11. Hazards

**The service cannot see the queue, and the queue is the whole point.** In-process timing starts once
the event loop reaches the request. Past the knee, `pbkdf2Sync` blocks the loop and requests wait in
the kernel — the project's headline failure mode, and invisible to the service. The service-side SLI
will therefore read healthy while clients see catastrophic latency.

The gap is made visible as a **directional indicator, not a measurement**: ALB `TargetResponseTime`
minus service-side duration, both now in the same datasource (S10). Be precise about what it is not —
`TargetResponseTime` is CloudWatch at 1-minute periods with percentile extended statistics, and the
service side is a native histogram at 15 seconds, so subtracting one p95 from another over different
windows yields no individual request's queue time. It answers "is the gap opening", which is all the
attribution table needs.

**A real per-request measurement is not available, and nobody should re-attempt it.** The ALB adds no
arrival timestamp, and the epoch field of `X-Amzn-Trace-Id` has 1-second resolution — useless against
a 50 ms threshold. The indicator is the best obtainable signal, and it never enters the SLI.

**`instrumentation-aws-sdk` inherits the `db_ms` inflation; it does not cure it.** The 2026-08-29 plan
records that `db_ms` inflated **12.1× (10.9 ms → 131.9 ms) with the database unchanged**, because
wall-clock around an `await` absorbs event-loop queueing. OTel's AWS SDK instrumentation measures
wall-clock around the SDK call too — the identical failure in a new package. It is kept for what it
genuinely adds (call counts, errors, and **SDK retry behaviour**, which is how throttling presents
before it becomes errors), not for attribution. DynamoDB's `SuccessfulRequestLatency` from CloudWatch
was designated the DB-bound discriminator here, with the gap between it and the client-side figure as
the queueing signal.

> **Withdrawn 2026-09-01.** Neither survives. `SuccessfulRequestLatency` *falls* when the table
> throttles — 0.887 ms mid-throttle against 1.473 ms idle — because rejected requests are never served
> and never enter the statistic; and the gap absorbs SDK retry backoff, so it read 642–938 ms while
> the database itself reported 0.9–2.2 ms. `ReadThrottleEvents` / `WriteThrottleEvents` are read
> instead, beside request latency, with nothing computing a verdict. See
> `docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-attribution-simplified-design.md`.

**`histogram_fraction` interpolates.** It estimates linearly within the bucket straddling the
threshold. Over this latency range at 160 buckets the straddling bucket is a few percent wide, so the
induced error on a 99% objective is small but real. If measurement shows it matters, the mitigation is
an explicit-bucket view with boundaries placed exactly on the class thresholds, converted by Alloy's
`convert_classic_histograms_to_nhcb` — still a native histogram, exact at the boundary, at the cost of
putting thresholds back into the service. **Not doing that now**, and the reason is recorded so the
option is not rediscovered from scratch.

**The collector is a single point of failure.** Cumulative temporality (S6) makes an outage lossless
in counts and lossy only in resolution. It is not lossless in alerting: burn-rate rules see a gap.

**Active-series budget.** Grafana Cloud Free allows 10,000 active series. The labelled cross-product
here is small — 3 classes × 3 `traffic_source` values × N task instances, plus the CloudWatch pull —
but `instance` grows with task churn, and a month of deploys and 1→4 scaling events accumulates
instances that never recur. Worth watching rather than assuming; if it becomes a problem the answer is
a shorter `instance` retention, not dropping the label, which S7 shows would collide the series.

**The OTLP gateway credential does not exist yet.** The root `.env` holds `K6_PROMETHEUS_RW_*` for
Prometheus remote-write, `GRAFANA_URL`/`GRAFANA_AUTH` for the provider, and `K6_CLOUD_*` — but nothing
for the OTLP gateway, which takes a different endpoint and its own instance ID plus an access-policy
token. It has to be created on the stack and added to `.env` and the workspace before pipeline 1 can
work.

**Instrumentation is a supply chain in the hot path.** Nine `@opentelemetry/*` packages now execute
per request inside a 250 µs budget. `@opentelemetry/auto-instrumentations-node` is deliberately **not**
among them — it pulls in instrumentation for libraries this service does not use and adds context
propagation the metrics path does not need. Anyone "fixing" the package list by adding it should read
§10 first.

---

## 12. Out of scope

- Traces. Metrics only. Tracing would answer different questions and cost per-request CPU this budget
  cannot spare.
- ~~Replacing `Server-Timing`, `/stats`, or any k6 script. All frozen.~~ **No longer out of scope: all
  three were replaced on 2026-08-31 (`docs/superpowers/specs/2026-08-31-ecs-dynamodb-rps-ceiling-attribution-via-metrics-design.md`),
  because nothing had yet been measured against them.**
- Moving CloudWatch off the existing dashboard. `grafana/dashboard.json` stays as written and applied
  against the CloudWatch datasource; S10 adds a second path, it does not migrate the first.
- Renumbering Tasks 18–23 of the 2026-08-29 plan.
- Multi-collector or highly-available collection. One task, one point of failure, accepted (§11).

---

## 13. Sequencing and approval gates

`terraform apply` and `terraform destroy` create and delete billable AWS resources; per `CLAUDE.md`
each gets its own plan task that stops for approval. A subagent may write and `plan` Terraform
freely; it may not apply it.

1. Add the `/slo` generation script. Regenerate the existing outputs **against the committed
   `window: 30d`** first and confirm they come back byte-identical — a generator whose first act is to
   alter committed files has a bug or an undocumented decision, and this is the only moment that can
   be proven. *Then* change `slo.yaml` to `window: 3d` (S13) and regenerate, so the resulting diff is
   attributable entirely to the window and the recomputed burn thresholds of S14 and to nothing else.
2. Create the Grafana Cloud OTLP access policy and token; add to `.env` and the workspace.
3. Instrument the service with `@opentelemetry/*`. Unit tests; integration test against
   DynamoDB Local confirming metrics are produced and no per-request I/O is introduced.
4. Write the Alloy configuration (§16) and its Terraform. Validate the config itself — OTTL syntax is
   version-sensitive and the component reference is not a substitute for the parser — then
   `terraform fmt -check`, `validate`, reviewed `plan`. Check the rendered `ALLOY_CONFIG_CONTENT`
   against the task-definition size limit at this point, not at apply.
5. Migrate the workspace to remote execution; move credentials into workspace variables.
6. **[GATE] `terraform apply`** — collector service, Cloud Map, SG, IAM.
7. Prove the pipeline end-to-end: send one histogram, query it back as a native histogram, confirm
   `histogram_fraction` returns a sane value and that `instance` distinguishes tasks (§11 list).
8. Re-measure instrumentation CPU cost; re-derive `pbkdf2_iterations` on a one-off Fargate task.
9. **[GATE] `terraform apply`** — the re-derived CPU knob.
10. Rewrite `grafana/alerts.tf` against the §7 queries; add `grafana_slo` and the Synthetic Monitoring
    checks; wire into the root module; `validate`.
11. **[GATE] `terraform apply`** — Grafana resources.
12. Confirm the SLI is queryable with no load test running, and that a burn-rate rule evaluates.
13. Hand back to the 2026-08-29 plan's Task 18, which now has a real SLO to report.

---

## 14. Provenance

Verified on 2026-08-30 while writing this spec, rather than recalled.

| fact | source |
|---|---|
| Native histograms are **enabled by default in Grafana Cloud**; limit `max_native_histogram_buckets: 160` | [Grafana Cloud — Native histograms](https://grafana.com/docs/grafana-cloud/observe-and-act/send-data/metrics/metrics-prometheus/native-histograms/) |
| `histogram_fraction(a, b, v)` estimates the fraction of observations in an interval; `histogram_count(v)` returns the observation count; native histograms are a single series with no `_bucket`/`_sum`/`_count` suffixes | [Mimir — Visualize native histograms](https://grafana.com/docs/mimir/latest/visualize/native-histograms/) |
| OTLP/HTTP sends exponential histograms to Mimir **in their existing format**; Prometheus remote-write sends them as native histograms | [Mimir — OpenTelemetry exponential histograms](https://grafana.com/docs/mimir/latest/send/otel-exponential-histograms/) |
| `ExponentialHistogramAggregation` is selectable through a `View` in `@opentelemetry/sdk-metrics` | [@opentelemetry/sdk-metrics](https://www.npmjs.com/package/@opentelemetry/sdk-metrics) |
| Alloy's `prometheus.exporter.cloudwatch` embeds YACE; **discovery** jobs find resources through the AWS Tagging API using `search_tags` | [prometheus.exporter.cloudwatch](https://grafana.com/docs/alloy/latest/reference/components/prometheus/prometheus.exporter.cloudwatch/) |
| `prometheus.remote_write` has `send_native_histograms`, default `false` | [prometheus.remote_write](https://grafana.com/docs/alloy/latest/reference/components/prometheus/prometheus.remote_write/) |
| `otelcol.exporter.prometheus` documents `convert_classic_histograms_to_nhcb` (experimental) and **says nothing about exponential histograms** | [otelcol.exporter.prometheus](https://grafana.com/docs/alloy/latest/reference/components/otelcol/otelcol.exporter.prometheus/) |
| Grafana Cloud **Free retains metrics for 14 days** and allows 10,000 active series; 13-month retention starts at Pro | [Grafana Cloud free tier](https://grafana.com/products/cloud/free-tier/), [pricing](https://grafana.com/pricing/) |
| `grafana_slo`'s `objectives { window }` validates against `^\d+(ms\|s\|m\|h\|d\|w\|y)$` — any Prometheus duration, no fixed enum | [terraform-provider-grafana `resource_slo.go`](https://github.com/grafana/terraform-provider-grafana/blob/main/internal/resources/slo/resource_slo.go) |
| Grafana's documented ECS pattern runs Alloy as a **sidecar**, with entrypoint `/bin/sh,-c` and command `printenv ALLOY_CONFIG_CONTENT > /tmp/config_file && exec /bin/alloy run --stability.level=experimental … /tmp/config_file` | [Alloy on ECS/Fargate](https://grafana.com/docs/alloy/latest/collect/ecs-opentelemetry-data/) |
| ~~`prometheus.exporter.cloudwatch` `discovery` blocks take `type`, `regions`, `search_tags`, `period`, `length`, `delay`; nested `metric` takes `name`, `statistics`~~ **WRONG — corrected 2026-08-31: `discovery` takes `type`/`regions`/`search_tags`; `period` and `length` are per-`metric`; `delay` does not exist.** | [prometheus.exporter.cloudwatch](https://grafana.com/docs/alloy/latest/reference/components/prometheus/prometheus.exporter.cloudwatch/) |
| `otelcol.processor.transform` `metric_statements` takes `context` of `resource`/`scope`/`metric`/`datapoint` and a list of OTTL `statements` | [otelcol.processor.transform](https://grafana.com/docs/alloy/latest/reference/components/otelcol/otelcol.processor.transform/) |

**Explicitly not verified, and to be proven in the plan rather than assumed.**

> **CLOSED OUT 2026-08-31.** All nine resolved or explicitly retired; evidence in the SDD ledger at
> `.superpowers/sdd/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection/progress.md`.
>
> | # | verdict | evidence |
> |---|---|---|
> | 1 | **RETIRED, still unknown.** The OTLP gateway path was used, so `otelcol.exporter.prometheus` was never exercised. Worth knowing, but nothing depends on it. | — |
> | 2 | **NO.** The AWS detector supplies no `service.instance.id`, on Fargate as well as locally. Read from `ECS_CONTAINER_METADATA_URI_V4` instead. Before the fix all tasks reported `instance="local-1"` (PID 1 in every container) and shared one series. | two tasks -> two distinct ids, verified under `desired-count 2` |
> | 3 | **MOOT.** The plan records the histogram directly rather than through `instrumentation-http` (Deviation 1), so no route template has to survive anything. | — |
> | 4 | **PARTLY.** `service.instance.id` does become `instance`. But ingest **joins** `service.namespace/service.name` into `job`, which produced `job="ecs-dynamodb-rps-ceiling/ecs-dynamodb-rps-ceiling"` and made every committed query match nothing. `service.namespace` is now unset. | observed label set |
> | 5 | **YES, with two undocumented constraints.** `grafana_slo` accepts native-histogram PromQL, but rejects a window outside **7-32 days** and rejects a hardcoded range, demanding `$__rate_interval`. Neither appears in the provider schema. | two `400` responses, quoted in §7 |
> | 6 | **YES.** `AWS/ECS` discovery by tag works on this account; no `static` fallback needed. | 2 series |
> | 7 | **YES.** `p95` is accepted in a YACE `statistics` list. Validated against the pinned image rather than in production, since the risk was a crash-loop. | `alloy validate` exit 0 |
> | 8 | **YES.** Rendered config 5,313 B, ~8% of the 64 KiB task-definition limit. | measured |
> | 9 | **VINDICATED, and §16 was wrong.** The config as written did not parse at all; `delay` is not an attribute of this component. See the §16 correction. | `alloy validate` from `grafana/alloy:v1.10.0` |
>
> **One hazard this list did not anticipate**, and it was the one that mattered most: on an
> internet-facing ALB, scanner 404s land on `unmatched`, carry no `class`, and therefore sit in the
> SLO denominator contributing nothing to the numerator — **counting as violations**. Measured at
> 68% of the population, driving three burn rules into firing on background noise. The SLO
> population is now selected on `class`, so unclassified traffic is excluded rather than counted as
> failing. Nothing but running the SLO against real traffic on a public endpoint would have found it.


1. Whether an OTLP exponential histogram survives `otelcol.exporter.prometheus` → `prometheus.remote_write`
   as a native histogram. Avoided by using the OTLP gateway; still worth knowing, because it would
   collapse two egress paths into one.
2. Whether `@opentelemetry/resource-detector-aws` populates `service.instance.id` uniquely per ECS
   task. If not, it is read at boot from `ECS_CONTAINER_METADATA_URI_V4`.
3. Whether a route template set on the active span by `matchRoute` reaches
   `http.server.request.duration` as an `http.route` attribute, or whether the server must record its
   own histogram (§5).
4. Whether Grafana Cloud's OTLP ingest promotes `service.instance.id` → `instance` and
   `service.name` → `job`. S7 and the §7 queries depend on it.
5. Whether `grafana_slo` accepts native-histogram PromQL in its Success/Total queries.
6. Whether YACE's `AWS/ECS` discovery finds an ECS **service** by tag. ECS service tagging depends on
   the long-ARN format being enabled on the account; if discovery comes back empty, the fallback is a
   `static` job naming `ClusterName`/`ServiceName` explicitly.
7. Whether `p95` is accepted in a YACE `statistics` list for `TargetResponseTime`. `Average` and
   `Maximum` are the documented fallback and are already in the config.
8. Whether the generated `ALLOY_CONFIG_CONTENT` fits inside the ECS task-definition size limit. It is
   inlined into the definition and the limit applies to the whole document; checked at plan time.
9. OTTL statement syntax is version-sensitive across Alloy releases. §16 is written to the current
   component reference and must be validated by `alloy fmt`/`alloy run --dry-run` before apply, not
   trusted from the page.

---

## 15. What this amends in the 2026-08-29 spec

Each row below gets a forward-pointer **at the decision itself** in that document, not only in its
header — per `CLAUDE.md`, that is the single rule that makes multiple specs safe.

| 2026-08-29 spec | amendment |
|---|---|
| **D7** (already struck) | This document is the replacement it promised. Pointer updated from "in design" to this filename. |
| **§4 Infrastructure** | Adds the collector service, Cloud Map namespace, collector SG and IAM role. Workspace moves from local to remote execution (S12). |
| **§5 Service** | OTel instrumentation becomes the primary source. `Server-Timing` and `/stats` remain, demoted from sole source. |
| **§7 SLO** | Objective unchanged. Source is now service-emitted native histograms, queried by `histogram_fraction`. |
| **§7 window paragraph** | "A Grafana SLO window is 28–30 days" no longer holds: the window is **`3d`** (S13), because Grafana Cloud Free retains 14 days. The paragraph's *argument* survives — run-scoped attainment plus a burn-rate multiple is still what makes a 5-minute run comparable to a budget — but every derived burn threshold changes (S14). |
| **§8 Load profiles** | The 1 RPS `stats` scenario is redundant but retained — the scripts are frozen. k6 thresholds are a run gate, not the SLO. |
| **§11 Open parameters** | `pbkdf2_iterations = 2675` is superseded pending re-derivation against the instrumented service. |
| **§12 Out of scope** | "CloudWatch as authoritative SLI source — dashboards only" still holds: CloudWatch now reaches the same Prometheus datasource, but as *attribution*, never as the SLI. |

---

## 16. The Alloy configuration

Generated by Terraform into `ALLOY_CONFIG_CONTENT` (S18). The `class` map is generated from
`slo.yaml`; everything else is static. **Validate before applying** — OTTL syntax is version-sensitive
(§14, item 9).

```alloy
// ===========================================================================
// Pipeline 1 — service metrics: OTLP in, OTLP out to Grafana Cloud.
// Exponential histograms pass through unconverted and land as native histograms.
// ===========================================================================

otelcol.receiver.otlp "app" {
  http { endpoint = "0.0.0.0:4318" }
  grpc { endpoint = "0.0.0.0:4317" }
  output { metrics = [otelcol.processor.transform.classify.input] }
}

otelcol.processor.transform "classify" {
  error_mode = "ignore"

  metric_statements {
    context = "datapoint"
    statements = [
      // route -> class. GENERATED from slo.yaml. This is the SLO-bearing half of
      // the mapping (S8); the service supplies only the route template.
      `set(attributes["class"], "fast")     where attributes["http.route"] == "/items/:pk/:sk"`,
      `set(attributes["class"], "fast")     where attributes["http.route"] == "/items"`,
      `set(attributes["class"], "standard") where attributes["http.route"] == "/feeds/:pk"`,
      `set(attributes["class"], "heavy")    where attributes["http.route"] == "/reports"`,

      // traffic_source (S16). Default first, then override: OTTL statements run in
      // order. Bounded to three values, so an arbitrary internet user-agent cannot
      // become a label value. The raw user-agent is dropped for the same reason.
      `set(attributes["traffic_source"], "other")`,
      `set(attributes["traffic_source"], "k6")        where IsMatch(attributes["user_agent.original"], "^k6/")`,
      `set(attributes["traffic_source"], "synthetic") where IsMatch(attributes["user_agent.original"], "Synthetic")`,
      `delete_key(attributes, "user_agent.original")`,
    ]
  }

  output { metrics = [otelcol.processor.batch.default.input] }
}

otelcol.processor.batch "default" {
  output { metrics = [otelcol.exporter.otlphttp.grafana_cloud.input] }
}

otelcol.auth.basic "grafana_cloud_otlp" {
  username = sys.env("OTLP_USERNAME")
  password = sys.env("OTLP_PASSWORD")
}

otelcol.exporter.otlphttp "grafana_cloud" {
  client {
    endpoint = sys.env("OTLP_ENDPOINT")
    auth     = otelcol.auth.basic.grafana_cloud_otlp.handler
  }
}

// ===========================================================================
// Pipeline 2 — AWS metrics: CloudWatch discovered by the Project tag (S17).
// CORRECTED 2026-08-31: `delay` DOES NOT EXIST on prometheus.exporter.cloudwatch
// in Alloy v1.10.0 -- not on discovery, not on metric, not at the exporter root
// (verified with `alloy validate` from the pinned image). The claim that it is
// mandatory is WRONG, and a config using it fails to load and crash-loops the
// collector. Two further errors below: `period`/`length` are per-METRIC, not
// per-discovery, and block arguments are newline-separated, NEVER
// comma-separated -- so every `metric { name = "X", statistics = [...] }`
// one-liner below is a syntax error. See the plan's Task 8 CORRECTION for the
// working config; grafana/alloy.alloy.tftpl is the source of truth.
//
// The lag is real: CloudWatch publishes late, so polling only the newest 60s
// period returns empty windows that read as an outage. It is absorbed instead
// by `length` being 5x `period` -- each poll asks for a 300s window and takes
// the newest datapoint actually published.
// ===========================================================================

prometheus.exporter.cloudwatch "aws" {
  sts_region = "eu-central-1"

  discovery {
    type        = "AWS/DynamoDB"
    regions     = ["eu-central-1"]
    search_tags = { "Project" = "ecs-dynamodb-rps-ceiling" }
    period      = "60s"
    length      = "300s"
    delay       = "120s"

    metric { name = "ThrottledRequests",          statistics = ["Sum"] }
    metric { name = "ReadThrottleEvents",         statistics = ["Sum"] }
    metric { name = "WriteThrottleEvents",        statistics = ["Sum"] }
    metric { name = "ConsumedReadCapacityUnits",  statistics = ["Sum"] }
    metric { name = "ConsumedWriteCapacityUnits", statistics = ["Sum"] }
    metric { name = "SuccessfulRequestLatency",   statistics = ["Average", "Maximum"] }
  }

  discovery {
    type        = "AWS/ApplicationELB"
    regions     = ["eu-central-1"]
    search_tags = { "Project" = "ecs-dynamodb-rps-ceiling" }
    period      = "60s"
    length      = "300s"
    delay       = "120s"

    // p95 is an extended statistic; Average and Maximum are the documented
    // fallback if YACE rejects it (§14, item 7).
    metric { name = "RequestCount",              statistics = ["Sum"] }
    metric { name = "TargetResponseTime",        statistics = ["Average", "Maximum", "p95"] }
    metric { name = "HTTPCode_Target_5XX_Count", statistics = ["Sum"] }
  }

  discovery {
    type        = "AWS/ECS"
    regions     = ["eu-central-1"]
    search_tags = { "Project" = "ecs-dynamodb-rps-ceiling" }
    period      = "60s"
    length      = "300s"
    delay       = "120s"

    metric { name = "CPUUtilization",    statistics = ["Average", "Maximum"] }
    metric { name = "MemoryUtilization", statistics = ["Average", "Maximum"] }
  }
}

prometheus.scrape "cloudwatch" {
  targets         = prometheus.exporter.cloudwatch.aws.targets
  forward_to      = [prometheus.remote_write.grafana_cloud.receiver]
  scrape_interval = "60s"
}

prometheus.remote_write "grafana_cloud" {
  endpoint {
    url = sys.env("PROM_URL")
    basic_auth {
      username = sys.env("PROM_USERNAME")
      password = sys.env("PROM_PASSWORD")
    }
  }
}
```

Five environment variables reach the container alongside `ALLOY_CONFIG_CONTENT`: `OTLP_ENDPOINT`,
`OTLP_USERNAME`, `OTLP_PASSWORD` (new — §11), and `PROM_URL`, `PROM_USERNAME`, `PROM_PASSWORD` (the
existing `K6_PROMETHEUS_RW_*` values). All are plain task-definition environment variables per S11.

---

## 17. Deferred decisions

Recorded here rather than left implicit, because each is a real fork someone will otherwise re-derive
from scratch — and because §14's rule is that an open question is stated, not silently assumed.

### 17.1 Whether load-generator traffic belongs in the SLO population

> **SETTLED 2026-09-01 by `docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-slo-scope-design.md`
> — in the direction this section predicted, with one correction.** The SLO is defined over
> **load-bearing traffic**; the continuous 7-day window is **informational**, and authoritative
> attainment is **run-scoped**. Nothing is filtered at source and no query changed — S15 already made
> the population a selector.
>
> The correction: this section assumes `traffic_source="k6"` can isolate a run. **It cannot.**
> Measured 2026-09-01 — `trafficSource()` is right (a forged `k6/` User-Agent produces the label) but
> **k6 v1.4.0 sends no such User-Agent**, so both shakedown runs landed in `other`. The selector
> returns an empty population, indistinguishable from silence. `k6/lib/request.js` or the k6 `options`
> must set a User-Agent **before the scripts are frozen**.
>
> The arithmetic below still stands and is why the split was needed at all.

**Deferred pending run data.** ~~The SLO is defined over all traffic for now.~~

The arithmetic that will decide it: Synthetic Monitoring at 1/min across four endpoints contributes
~17,300 requests to a 3-day window. Shape C is a *deliberate* SLO breach at ~3× the knee — one
5-minute run at 1000 RPS is ~300,000 requests. A single stress run is therefore ~95% of the window's
population and is designed to fail, which zeroes the budget and fires every burn alert.

That sits awkwardly with §1 of this document, which argues k6 traffic is a test result rather than a
service level. The likely resolution is one metric with two selectors — a continuous SLO over
`traffic_source != "k6"`, and run-scoped attainment for `results.md` over `traffic_source = "k6"`.
S16 exists so that this remains a query change rather than a redeploy.

### 17.2 The precise definition of "valid" and "good"

**Deferred.** All endpoints are monitored; the SLO's denominator is the §7 selector.

Open specifics: whether 4xx belongs in the denominator, and whether it counts as good. Standard SRE
practice treats a client error as not the service's failure. Note the frozen k6 gate counts only
`2xx` as good (`k6/lib/request.js`), so whatever is chosen here will differ slightly from the run
gate — expected, and worth writing down so it is not later filed as a bug.

### 17.3 `results.md` schema

Two attainment numbers now exist — k6 client-side (includes Frankfurt RTT and ALB queueing) and
service-side (includes neither). The 2026-08-29 plan's Task 22 validates result rows with an `awk`
check on fixed column positions, which new columns would shift. That task is not renumbered; the new
plan owns extending the schema and updating the check, and must state which attainment each column
holds. An unlabelled pair of numbers both called "attainment" is how a deliverable stops being
trusted.
