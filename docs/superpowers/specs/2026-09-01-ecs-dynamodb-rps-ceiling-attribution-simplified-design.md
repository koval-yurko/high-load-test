# ecs-dynamodb-rps-ceiling — two metrics instead of an attribution model

- **Date:** 2026-09-01
- **Status:** **approved** (2026-09-01). Design agreed in conversation after the observability
  shakedown; the implementation plan is not yet written.
- **Project directory:** `ecs-dynamodb-rps-ceiling/`
- **Amends:** `docs/superpowers/specs/2026-08-31-ecs-dynamodb-rps-ceiling-attribution-via-metrics-design.md`.
  It **deletes that document's four-row attribution table** — the one keyed on DynamoDB's
  `ThrottledRequests`, its `SuccessfulRequestLatency`, the gap between that and the service's own
  in-process database timing, and CPU against the 0.25 vCPU allocation. Everything else in that spec
  stands: the three OpenTelemetry histograms, the deletion of the `Server-Timing` header and the
  `GET /stats` endpoint, and the generated shared query set are all unaffected.
- **Evidence:** `.superpowers/sdd/2026-09-01-ecs-dynamodb-rps-ceiling-observability-shakedown/report.md`

---

## 1. What failed

The four-row table decided which resource caused a ceiling. On 2026-09-01 it was evaluated for the
first time against a case whose answer was known in advance: the service was driven at 250 requests
per second against a DynamoDB table provisioned at 25 read capacity units, so the database was the
constraint by construction. DynamoDB was rejecting **5,588 reads per minute** at the moment of
reading.

**The table named the service.** Not marginally — it matched the service row on every signal,
including the fallback that spec added specifically to make the row robust.

Measured at 08:34:00Z, mid-throttle:

| signal | reading | what the table concluded |
|---|---|---|
| DynamoDB `ThrottledRequests`, summed across operations | **0** | no capacity problem |
| DynamoDB `SuccessfulRequestLatency` | GetItem 0.887 ms, PutItem 2.229 ms, Query 1.443 ms — *below* their idle values | the database is healthy |
| service's own DB timing minus DynamoDB's clock | 642–938 ms and climbing | the queue is inside Node |
| `nodejs_eventloop_utilization_ratio` | **1.000** | the event loop is saturated |
| CPU against the 0.25 vCPU allocation | 0.033–0.165 | (low, but the spec says treat this as *unaccounted* CPU, not absent CPU, and fall back to event-loop utilization — which read 1.000) |

Verdict: *"service — the DB is keeping up; the queue is in Node."* Wrong, confidently, in the one
place nothing checks it.

## 2. Why it is not repairable by reordering

Three defects compound, and each one alone inverts the verdict.

**The primary discriminator reads zero during throttling.** `ThrottledRequests` is a per-60-second
CloudWatch SUM exposed as a gauge. Sampled across the same window it reads
`… 4156, 0, 4153, 4360, 2380 …` — a zero *between* two throttling minutes. The table tested it at a
single instant. Separately, that metric is published **only** with a `TableName` + `Operation`
dimension pair — `aws cloudwatch list-metrics` returns three dimension sets for this table, all
carrying `Operation`, none with `TableName` alone — so the AWS CLI command the plans inherited for
reading it (`--dimensions Name=TableName,Value=ecs-dynamodb-rps-ceiling`) matches nothing and prints
an empty result forever, indistinguishable from a healthy table.

**`SuccessfulRequestLatency` falls when DynamoDB throttles.** Throttled requests are *rejected*, not
served slowly, so they never enter the latency statistic, and the requests that do survive are the
fast ones. Measured 0.887 ms mid-throttle against 1.473 ms at idle. The table's database row requires
this number to **climb**, so that row cannot match a capacity-throttling event at all — which is the
most likely way this database will ever bind.

**Every service-row signal is downstream of throttling.** When DynamoDB rejects a request the AWS SDK
retries it with exponential backoff. Those retries are held inside the Node process, so they inflate
the service's own database timing (642–938 ms against DynamoDB's 0.9–2.2 ms) and pin event-loop
utilization at 1.000 while actual CPU sits at 3–16%. The event loop was saturated by pending backoff
timers, not by work.

There is no ordering of these four signals that separates "the queue is in Node because Node is slow"
from "the queue is in Node because the database is rejecting us." The evidence and the conclusion are
the same phenomenon.

## 3. What replaces it

Two metrics, read side by side by a person. Nothing computes a verdict.

**Metric 1 — how long did the endpoint take.** `http_server_request_duration_seconds`, the per-route
latency histogram the service already emits and the SLO is already computed from. Unchanged; this
spec adds nothing to it.

**Metric 2 — was DynamoDB rejecting us.** `ReadThrottleEvents` and `WriteThrottleEvents`: DynamoDB's
own per-minute count of rejected requests, published at `TableName` level and already collected by
the Alloy collector's tag-based CloudWatch discovery. Through the entire incident they read 5265,
3964, 5358, 5588 and 2380 per minute — continuous, no zero-gaps, and they separate read throttling
from write throttling, which `ThrottledRequests` cannot do at table level.

If latency is up and throttle events are non-zero, the database was rejecting the service. If latency
is up and they are zero, it was not. That is the whole model.

**Both series are present and both are safe to test with `> 0`.** Verified 2026-09-01: Grafana holds
`aws_dynamodb_read_throttle_events_sum` and `aws_dynamodb_write_throttle_events_sum`, each labelled
only with the table name. The write series exists **and reads zero** even though writes never
throttled in the shakedown — the collector emits the zero rather than omitting the series. This
distinction matters more here than anywhere else in the project: an absent metric and a zero metric
look identical to a careless reader and mean opposite things. On this stack they are zero, so a
`> 0` test is sound. Do not carry that assumption to a metric this stack has never exercised.

## 4. Decisions

| # | Decision | Rationale |
|---|---|---|
| **M1** | **Delete the four-row attribution table. Nothing computes a bound resource.** | It gave a confident wrong answer on its first real test, for structural reasons (§2) rather than a fixable error. A model that misattributes is worse than no model, because it launders a guess into a recorded fact. |
| **M2** | **Two metrics, read by a human: request latency, and DynamoDB throttle events.** | These are the two questions actually being asked — *how long did it take* and *was the database refusing us*. Both already exist as raw observations; neither requires inference to interpret. |
| **M3** | **`ReadThrottleEvents` and `WriteThrottleEvents` replace `ThrottledRequests` everywhere** — in the generated query set, on the dashboard, and in the runbook. | They were the only signal that stayed clean and continuous through the incident, they are published at table level so no per-operation fan-out is needed, and they separate reads from writes. `ThrottledRequests` is not merely inconvenient: it reads zero mid-throttle and its table-level CLI form matches nothing. |
| **M4** | **The results file drops three columns: `bound resource`, `evidence`, `queueing ms`.** | The first two are outputs of the deleted inference. The third — the service's DB timing minus DynamoDB's own clock — is the number that read 642–938 ms while DynamoDB reported 0.9–2.2 ms. Leaving it in the deliverable invites the next reader to repeat the table's mistake by hand. |
| **M5** | **The row-completeness check is rewritten and its column indices re-verified, not counted.** | See §6. The existing check validates the wrong columns while documenting itself as validating the right ones — including a claim that this was "verified rather than assumed". |
| **M6** | **Raw observations stay recorded: `db ms`, `cpu ms`, `EL lag p99`, `throttles`, `RCU/WCU`, `$/hr`.** | These are measurements, not verdicts. Recording a fact costs nothing and cannot mislead the way a derived signal can; the deletions in M4 target inference, not data. |

## 5. What this deliberately does not do

- **It does not fix the cause of the misattribution in the service.** No retry instrumentation is
  added, no metric subtracts backoff time from the database timing. That was considered and rejected
  as going deeper than the problem needs: it would change `src/`, require an image rebuild and
  redeploy, and introduce a new signal whose own correctness would then have to be established.
- **It does not delete the existing derived panels** — the queueing-gap panel, the CPU-saturation
  panel and the event-loop panels stay on the dashboard. They are informative, they are already
  built, and deleting them would touch the query generator, its tests and the byte-check that keeps
  the generated files honest. What is deleted is the *table that turned them into a verdict*.
- **It does not change what a run measures.** The load profiles, the SLO, the burn-rate alerts and
  the class thresholds are untouched.

## 6. Concrete changes

**The collector needs no change, and neither does the service.** The Alloy configuration already
requests all three metrics from CloudWatch — `ThrottledRequests`, `ReadThrottleEvents` and
`WriteThrottleEvents` are all listed in `ecs-dynamodb-rps-ceiling/grafana/alloy.alloy.tftpl`. Nothing
here touches `src/`, so there is no container image rebuild and no ECS redeployment.

**The generated query set** (`ecs-dynamodb-rps-ceiling/grafana/queries.json`, produced by
`scripts/generate-slo.js`) gains `read_throttle_events` and `write_throttle_events`, reading
`aws_dynamodb_read_throttle_events_sum` and `aws_dynamodb_write_throttle_events_sum` filtered to this
table. The existing `throttled_requests` entry is removed. As with every other CloudWatch gauge in
that file, these are per-60-second sums exposed as gauges — read them directly; never wrap them in
`rate()`, which treats each decrease as a counter reset.

**One `terraform apply` is required, against the Grafana provider only.** The dashboard is generated
from `ecs-dynamodb-rps-ceiling/grafana/dashboard.json.tftpl`, and its headline throttling panel reads
`ThrottledRequests` from the CloudWatch datasource directly rather than from the Prometheus copy. No
AWS resource is created, changed or destroyed and nothing new becomes billable — but it is still an
apply, so per this repo's rules it belongs in its own plan task and that task stops for approval.

**The results schema** (defined in `.claude/skills/loadtest/SKILL.md`) becomes fourteen columns:

```
| date | profile | infra change | RPS | k6 attainment | service attainment | budget burn x |
  p95 fast/std/heavy | db ms | cpu ms | EL lag p99 | throttles | RCU/WCU | $/hr |
```

That skill also loses its instruction to "read `bound resource` off the four-row attribution table"
and its instruction to read `queueing ms`.

**The row-completeness check** becomes:

```bash
awk -F'|' 'NR>2 && NF>3 && ($4 ~ /^ *$/ || $6 ~ /^ *$/ || $7 ~ /^ *$/ || $13 ~ /^ *$/) \
  { print "INCOMPLETE ROW:", $0 }' ecs-dynamodb-rps-ceiling/results.md
```

Fields, confirmed by piping the new header through `awk` rather than counting pipes:
`$4` = infra change, `$6` = k6 attainment, `$7` = service attainment, `$13` = throttles.

> **The check being replaced was wrong, and documented itself as verified.** Against the current
> seventeen-column header, `$4` is indeed `infra change` and `$6` is `bound resource`, but `$8` is
> `queueing ms` and `$9` is `k6 attainment` — not `k6 attainment` and `service attainment` as both
> the 2026-08-29 plan and the 2026-09-02 plan state. **`service attainment` sits at `$10` and was
> never validated at all**, so a row missing the number the 2026-09-01 SLO-scope decision makes
> authoritative would have passed silently. Verified 2026-09-01 by running the real header through
> `awk -F'|'` and printing every field.

**Two documents get a pointer at the decision itself**, not only in a header: the 2026-08-31
attribution spec, at its table; and the load-test skill, where it names the table.

## 7. What would reopen this

- **A run where latency is up, throttle events are zero, and the cause is still unclear.** Two
  metrics answer "was it the database". They do not distinguish *why* the service is slow when the
  database is fine. If that case arrives and matters, the next signal to add is whole-process CPU
  from the ECS `CPUUtilization` metric — it measures the container rather than the two explicitly
  bracketed code blocks the current CPU histogram covers, and throttling consumes almost no CPU, so
  it is not contaminated the way the deleted table's signals were.
- **A second project reusing this SLI contract.** The portability claim in the SLI-collection design
  assumes an attribution story that no longer exists; a Lambda-based project would need its own.
