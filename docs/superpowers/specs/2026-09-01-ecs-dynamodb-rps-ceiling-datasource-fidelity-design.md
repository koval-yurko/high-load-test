# ecs-dynamodb-rps-ceiling — the dashboard keeps CloudWatch, and three defects get fixed

- **Date:** 2026-09-01
- **Status:** **complete** (2026-09-01). Executed by
  `docs/superpowers/plans/2026-09-01-ecs-dynamodb-rps-ceiling-datasource-fidelity.md` on branch
  `worktree-datasource-fidelity`; see that plan's status block for the commit list, the empty-result
  bug caught in D3's own first draft, and the record of the apply destroying an out-of-branch
  resource because it ran without a saved plan file.
- **Project directory:** `ecs-dynamodb-rps-ceiling/`
- **Amends:** nothing. This spec **upholds** the decision in
  `docs/superpowers/specs/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection-design.md` section 12
  (*Out of scope*) — *"Moving CloudWatch off the existing dashboard … S10 adds a second path, it
  does not migrate the first"* — and supplies the measured evidence that bullet never had. An
  earlier draft of this document proposed reversing it; section 2 is the measurement that killed
  that proposal, recorded here so the question is not reopened from first principles a third time.
- **Evidence:** every number below was read from the live stack and the live AWS account on
  2026-09-01. Queries are reproduced inline so they can be re-run.

---

## 1. What prompted this

The runbook's *Phase 3 — Check state* tells the operator to run `aws cloudwatch
get-metric-statistics` three times, for `ReadThrottleEvents`, `WriteThrottleEvents` and
`SuccessfulRequestLatency` looped over `GetItem`, `PutItem` and `Query`. The reader-facing half of
the same README answers those two questions with Grafana links and says so in that section's first
line. The same questions are documented twice, in two tools, through two credentials.

The natural-looking fix was to make Grafana the single **store** as well as the single **pane**:
Alloy already forwards 15 `aws_*` series to Grafana Cloud Prometheus, yet 22 of the dashboard's 28
targets ignore that copy and query the CloudWatch datasource live. Repoint the 22, add the handful of
metrics Alloy does not yet scrape, drop the CloudWatch datasource from the dashboard.

**That fix is wrong, and the reason is measurable.**

## 2. The measurement that settled it

The 250 rps run recorded in the README on 2026-09-01 drove `ReadThrottleEvents` to a peak the README
cites as its headline evidence that DynamoDB was the ceiling. Both paths were queried over the same
window.

```
aws cloudwatch get-metric-statistics --namespace AWS/DynamoDB --metric-name ReadThrottleEvents \
  --dimensions Name=TableName,Value=ecs-dynamodb-rps-ceiling \
  --start-time 2026-09-01T08:20:00Z --end-time 2026-09-01T08:50:00Z --period 60 --statistics Sum

max without (instance) (aws_dynamodb_read_throttle_events_sum{dimension_TableName="ecs-dynamodb-rps-ceiling"})
```

| time | CloudWatch native | Alloy → Prometheus |
|---|---|---|
| 08:31 | 5265 | *(absent)* |
| 08:32 | 3964 | *(absent)* |
| 08:33 | 5358 | 4156 |
| 08:34 | **5588 — the peak** | *(absent)* |
| 08:35 | 2380 | 4153 |
| 08:36 | — | 4360 |
| 08:37 – 08:41 | — | 2380 repeated five times |
| 08:42 onward | — | 0 |

**The forwarded copy never contains 5588.** Its maximum over the event is 4360 — a 21% understatement
of the peak, and 5588 is the exact figure the README reports. Verified on raw unaggregated samples at
`step=30s`, so this is not an artefact of `max without (instance)` or of the query step.

A dashboard built on the forwarded copy would quietly contradict the project's own recorded result,
in the one panel that answers *"was DynamoDB rejecting us?"*. For a project whose entire deliverable
is *at what RPS did it break, and how hard*, a path that loses the peak is disqualifying.

## 3. Diagnosis — three distinct behaviours, not one

The forwarded path is not uniformly lossy. Separating the three matters, because only one of them is
fatal and the other two are tolerable.

**(a) A consistent ~2-minute lag, values preserved exactly.** For `SuccessfulRequestLatency` the
forwarded series is the native series shifted forward two minutes, with the values intact — 9 of 10
consecutive `GetItem` points identical, the tenth differing by 0.001 ms. The `Query` excursions of
9.678 ms and 8.825 ms both survive the trip, shifted +2 min.

| CloudWatch | → | Prometheus |
|---|---|---|
| 08:35 = 0.880 | | 08:37 = 0.880 |
| 08:36 = 0.747 | | 08:38 = 0.747 |
| 08:42 = 1.383 | | 08:44 = 1.383 |

**(b) Bucket misalignment, which destroys peaks in `Sum` metrics.** Alloy requests a 300 s window;
CloudWatch aligns its 60 s buckets to the request, not to the wall-clock minute. For a smooth
`Average` this changes almost nothing — hence (a). For a spiky `Sum` during a ramp it splits the peak
minute across two offset buckets, which is why 5588 becomes 4360 and why 4156 / 4153 / 4360 appear
nowhere in the native 60 s series. **This is the fatal one, and it affects exactly the metrics whose
peak is the result:** throttle events and consumed capacity.

**(c) A stale value held for up to 5 minutes once a metric stops publishing.** When throttling
stopped, the 300 s window kept returning the last non-empty datapoint — 2380, five times — before
dropping to 0. It reads as though throttling continued for five minutes after the run ended.

All three follow from one line in `grafana/alloy.alloy.tftpl`, and its own comment already explains
why: Alloy v1.10.0 does not expose YACE's `delay`, so `length` is set to 5× `period` and each poll
takes the newest datapoint in a 300 s window. **This is structural, not a tuning error.** Setting
`length = 60s` would fix (b) and (c) and reinstate the empty-recent-window problem the 5× was written
to solve. The workaround is correct for its purpose; its purpose is not peak fidelity.

## 4. The queueing panel: checked, and materially sound

`queueing_ms_by_route` subtracts DynamoDB's `SuccessfulRequestLatency` — the **forwarded** copy, per
`grafana/queries.json` — from the service's own `http_server_db_duration_seconds` histogram, which
arrives via OTLP in near-real-time. The two inputs therefore disagree about what time it is by
behaviour (a): the panel subtracts DynamoDB's latency from two minutes ago from the service's latency
now.

**The error is bounded by how much DynamoDB's latency moved in those two minutes**, and it is small:

- At steady state the subtrahend is flat (`GetItem` ≈ 0.88 ms, `Query` ≈ 1.4 ms, `PutItem` ≈ 2.25 ms
  across the whole window), so the error is hundredths of a millisecond.
- At the largest observed excursion — `Query` at 08:42, native 8.825 ms against the forwarded 1.437 ms
  then on display — the error is **7.4 ms**.
- The README reports queueing delay of **642–938 ms** during that incident. Worst case is therefore
  about **1%**.

**Verdict: no change required.** The panel's magnitude is sound and the conclusion it drives — whether
the queue sits inside Node or inside DynamoDB — is robust to single-digit milliseconds against a
signal three orders of magnitude larger. The two-minute skew is recorded in D4 as a caveat for anyone
reading the panel live during a run, not as a defect to repair. Repairing it would mean lagging the
service histogram to match, which trades a 1% error for a two-minute blind spot.

This is worth stating plainly because the risk was flagged before it was measured, and measurement
shrank it.

## 5. Decisions

| # | Decision | Rationale |
|---|---|---|
| **D1** | **The dashboard keeps the CloudWatch datasource for all 22 AWS targets.** No panel migrates. | Section 2. The forwarded copy understates the peak by 21% on the headline metric. Grafana is already the single pane — both datasources sit behind one dashboard and the operator never opens the AWS console — so the migration buys tidiness and pays for it in fidelity. |
| **D2** | **The forwarded copy stays, and stays unread by panels.** No metrics are added to Alloy, and `ThrottledRequests` is **not** dropped. | It earns its place on two grounds panels cannot: `queueing_ms_by_route` joins DynamoDB's clock to the service's histogram, which is only expressible with both series in one store; and the four burn-rate rules in `alerts.tf` need PromQL. Dropping `ThrottledRequests` was proposed when this document still planned a migration; with no migration it is a two-line scrape whose removal saves nothing and would need reverting if a future alert wants it. **Amended 2026-09-02: the DynamoDB half of this decision stands; the ALB and ECS halves did not.** D2 was written about *metrics*, and the poller is billed per *discovery block*: the three blocks issued three `GetMetricData` calls a minute, 198 calls/hour flat and around the clock (measured off `AWS/Usage` `CallCount`), ~25,100 metrics/day, $0.25/day. Of the 16 metric-statistics polled, exactly one had a Prometheus consumer — `AWS/DynamoDB SuccessfulRequestLatency`/`Average`, the subtrahend in `queueing_ms_by_route` and the second series in `cloudwatch_srl_by_operation`. All 22 ALB/ECS/DynamoDB panel targets query the CloudWatch datasource per D1, and `alerts.tf` reads only `http_server_request_duration_seconds` — so the ALB block (5 metric-statistics) and the ECS block (4) were forwarded to Mimir and read by nothing. Both were removed from `grafana/alloy.alloy.tftpl`; the DynamoDB block, `ThrottledRequests` included, is kept exactly as D2 argued. |
| **D3** | Replace `sum(...)` with `max without (instance)` over **every** `aws_*` series in `scripts/generate-slo.js`, then regenerate `grafana/queries.json`. Three sites, not two: `read_throttle_events` and `write_throttle_events` (both around line 512), **and the `SuccessfulRequestLatency` subtrahend inside `queueingExpr` at line 464**. Also aggregate `cloudwatch_srl_by_operation`, which is currently unaggregated. | A real latent bug, independent of everything above. Every `aws_*` series carries an `instance` label identifying the Alloy task that scraped it. `desired_count = 1`, so `sum()` is correct today — but during any collector redeploy the replaced task's series overlap the new one's and **every `sum()` reads double**. `max` is correct with one instance and with two. Consequences differ per site: the throttle entries double outright; the queueing subtrahend doubles, which *understates* queueing delay by one whole DynamoDB latency (~1–4 ms — small against 642–938 ms, but wrong in the same way and fixed by the same edit); `cloudwatch_srl_by_operation` merely renders duplicate lines, which is visible rather than silent. |
| **D4** | Annotate the affected panels with what the forwarded path does and does not preserve: the ~2-minute skew on *Queueing delay by route*, and on *DB wall-clock vs DynamoDB's own clock*. | The panels already carry long descriptions explaining their traps; this is the same discipline. A reader comparing the queueing panel against the throttle panel during a live run needs to know the two are not aligned in time. |
| **D5** | `dashboard.json.tftpl` stops hardcoding `a4139e7c-dc84-47c8-b90b-d710ec0fe3fb` 33 times and takes `cloudwatch_datasource_uid` and `prometheus_datasource_uid` through the `templatefile` call that already passes `queries.json`. | Both variables are declared in `grafana/variables.tf`, passed into the module by `terraform/grafana.tf`, and used by `alerts.tf` and `slo.tf` — but ignored by the one file that embeds a uid. A hardcoded uid means the dashboard breaks silently if the stack is ever rebuilt. |
| **D6** | README *Phase 3* drops the three `aws cloudwatch get-metric-statistics` commands and links panel 2 (*DynamoDB throttle events*) and panel 5 (*SuccessfulRequestLatency by operation*), matching how the rest of the README already reads. | The originating complaint, and the only change the complaint actually required. The surrounding prose — the `db_wall_avg_by_route` warning, the per-route operation mapping, and the "throttling shows up as latency before it shows up as errors" note — is analysis rather than CloudWatch mechanics, and is kept verbatim. |

## 6. What was proposed and rejected, so it is not reopened

The rejected proposal was: repoint all 22 targets at Prometheus, add 7 metrics to Alloy
(`ProvisionedRead/WriteCapacityUnits`, `LiveTaskCount`, ALB `HTTPCode_Target_2XX/4XX_Count`,
`HTTPCode_ELB_4XX_Count`, `HealthyHostCount`), drop `ThrottledRequests`, and remove the CloudWatch
datasource from the dashboard. Three supporting arguments were made for it. On inspection:

- *"One store is tidier."* True, and outweighed by section 2.
- *"We are paying `GetMetricData` twice over for series nothing reads."* **Backwards.** Alloy polls
  every 60 s around the clock whether or not anyone is looking; the CloudWatch datasource bills only
  while a dashboard is open. Consolidating onto Alloy would not have removed a cost, and running it
  continuously is the more expensive of the two.
  **Amended 2026-09-02: the reasoning holds and the arithmetic is now measured — it just also
  condemned two blocks this document left standing.** Alloy's round-the-clock poll cost $0.25/day
  against a $2.05/day environment, and 9 of its 16 metric-statistics (the ALB and ECS blocks) had no
  reader at all. Deleting those is the version of this argument that survives: it does not consolidate
  anything onto Alloy, it stops forwarding what nothing queries. See the amendment at D2.
- *"CloudWatch's 15-month retention beats Mimir's 14 days."* **Nearly irrelevant here.**
  `terraform destroy` and recreate gives the ALB a new id — `dimension_LoadBalancer` today is
  `app/ecs-dynamodb-rps-ceiling/ac6391a947d04ee8` — so the dimension changes and cross-rebuild
  comparison breaks in *both* stores. The durable record of a run is the results table in the
  project README, which is what `CLAUDE.md` already requires.

Two facts checked during that analysis are worth keeping, since both contradicted an assumption:
`LiveTaskCount` **is** a real `AWS/ECS` metric and publishes for this service (`ECS/ContainerInsights`
is empty; Container Insights is off, and nothing needs it). And the ECS series carry
`dimension_ServiceName` for both the app **and** `ecs-dynamodb-rps-ceiling-collector`, so any future
PromQL over ECS metrics must filter the collector out or it will average the app with its own
monitoring — worst exactly when the app is saturated and the idle collector drags the number down.

## 7. What this does not change

- **`alerts.tf`, `slo.tf`, and the SLO itself.** Untouched. The SLI ratio is service-emitted and
  never had a CloudWatch path.
- **`alloy.alloy.tftpl`, and therefore all AWS infrastructure.** D2 leaves the collector config
  alone, so there is **no ECS task-definition revision, no collector redeploy, and no gap in the
  metrics stream**. This is the main practical gain over the rejected proposal, which would have
  restarted the collector.
- **`src/`, the k6 scripts, `slo.yaml`'s SLO definitions, the capacity model.** No container rebuild,
  no app redeploy, no change to any load profile. No measured result is invalidated.
- **Panel IDs.** The README links panels by `viewPanel=<id>` in a dozen places.

## 8. Sequencing and approval gates

Per `CLAUDE.md`, `terraform apply` gets its own task that stops for approval; a subagent may write
and `plan` freely but may not apply.

1. Fix `sum()` → `max without (instance)` per D3, in **both** `grafana/queries.json` and the
   generator in `scripts/` that emits it, then re-run the generator and confirm the file it produces
   matches the file committed. A generated file edited by hand is a bug that returns on the next
   regeneration.
2. Apply D4 and D5 to `dashboard.json.tftpl`. `terraform fmt -check`, `validate`, then `plan` —
   expect a single `grafana_dashboard.attribution` update and nothing else. A diff touching
   `aws_ecs_task_definition` or any AWS resource means D2 has been violated.
3. **Approval gate — apply.** Grafana provider only. No AWS resource is created, changed or
   destroyed and nothing becomes billable, but it is still an apply.
4. Confirm in the browser that panels 2, 5, 21 and 22 still render, and that the D4 annotations read
   correctly.
5. Edit the README per D6.

Step 4 is the deliverable. The failure mode this project has already been bitten by — in the
`traffic_source="k6"` selector recorded in the README — is a query that returns empty and reads
exactly like a healthy silence.

## 9. Corroboration to add to the 2026-08-30 spec

`CLAUDE.md` requires a forward-pointer when a later document **changes** an earlier decision. This one
upholds it, so no reversal notice is needed — but the *Out of scope* bullet in
`2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection-design.md` section 12 states the decision without
a reason, which is what made it look re-litigable. Add a pointer there recording that the decision was
re-examined on 2026-09-01, tested against the 250 rps run, and upheld because the forwarded path
understates `ReadThrottleEvents` peaks by ~21%, with this document as the evidence.
