# ecs-dynamodb-rps — spike response from a floor of one task

- **Date:** 2026-09-15
- **Status:** **approved** (2026-09-15, by the user). Plan:
  `docs/superpowers/plans/2026-09-15-ecs-dynamodb-rps-spike-response.md`.
- **Correction, 2026-09-15, after approval and before execution:** §5 and §6 originally required the
  shed threshold to sit *below* the scale-out threshold. That is backwards and would have broken the
  design — see the invariant in §6.1. The thresholds in §5 changed with it (0.80/0.95 → 0.70/0.85).
  Nothing else moved; no decision in §10 is affected.
- **Corrections, 2026-09-16, from the final branch review (wording only, no decision moved):** §4's
  opening said "replace" the CPU policy — it is kept, and request count is a second policy; §5's step
  labels contradicted its own 1 → 5 → 15 model; §11 gains risk 6 (an all-or-nothing shed gate can
  average ELU below the alarm while shedding). Each is annotated in place.
- **Project directory:** `ecs-dynamodb-rps/`
- **Amends:** nothing is reversed here. §7 *clarifies* a claim made by the 4xx decision of
  2026-09-02 (`docs/superpowers/specs/2026-09-02-ecs-dynamodb-rps-restructure-design.md` §392 and
  the `slos[0]` comment in `ecs-dynamodb-rps/slo.yaml`): the Grafana-side treatment of 4xx stands
  exactly as decided, but the assertion that k6's `slo_met` behaves the same way is **false**, and
  this spec records that we are knowingly leaving the two divergent. Both of those places get a
  forward-pointer to this section — Task 1.
- **Origin:** the browser review published for run 8554820 on 2026-09-14 and revised 2026-09-15.
  The five decisions in §10 were taken there.

---

## 1. What the measurement showed

Discovery run **8554820** (2026-09-14, 18:16:12–18:18:27 UTC) did not measure this service. It
measured one 0.25 vCPU Fargate task, for two independent reasons.

**A configuration bug emptied the fleet before the run.** `dev.tfvars` carried
`desired_count = 5`; `autoscaling_min` was never set there and stayed on `default = 1` in
`variables.tf`. Application Auto Scaling took the floor as authoritative and walked the service
down — four scale-in activities between 17:52:20 and 18:01:20 UTC, ending at `desired = 1`,
fifteen minutes before the run started. No plan diff, no alert; it would have recurred after every
apply.

**Nothing could have scaled anyway.** The CloudWatch alarm Application Auto Scaling created for
the CPU policy — read back from the live account — is `CPUUtilization`, Average, **period 60,
3 evaluation periods, > 60.0**. The spike arrived at 18:16:12, mid-minute, so the 18:16 bucket
averaged 39.1% and did not breach. Only 18:17 (89.0%) and 18:18 (99.1%) ever did: two datapoints
where three are required. **Zero scale-out activities were recorded.**

Measured, step-aligned, from the k6 Cloud API:

| step | requested | delivered | p95 | `slo_met` | verdict |
|---|---:|---:|---:|---:|---|
| `rps_100` | 100 | 99.9 | 11.2 ms | 0.9984 | pass |
| `rps_200` | 200 | 189.4 | 142.0 ms | 0.5005 | the knee |
| `rps_300` (15 s) | 300 | ~210 | 274.8 ms | 0.2554 | fail |

Two properties of that data drive the whole design:

1. **It cliffed, it did not degrade.** All three latency classes sat flat near 6 ms p95 through the
   entire 100-rps step, then jumped ~22× together in the first 12-second bucket of the 200-rps step
   — `fast` 136.0 ms, `standard` 137.1 ms, `heavy` 184.2 ms. A `heavy` request does a Query, 1.4 ms
   of pbkdf2 and a Put; a `fast` request does one GetItem. Equal absolute degradation across
   unequal work means the added latency is **queueing ahead of the handler**, not work inside it.
2. **A uniform shift is fatal only to the tightest budget.** At 200 rps, `fast` met its 50 ms
   threshold 29.1% of the time while `heavy` met its 800 ms threshold 100% of the time. The
   aggregate `slo_met` of 0.5005 is "the 55% of traffic with the strictest budget all missed at
   once", not "the service half-failed".

`http_req_failed` was **0.0** for the whole run — only 200s and 201s. The service refused nothing.
DynamoDB was never involved: 171.5 RCU/s consumed against 1,000 provisioned, 33.5 WCU/s against
500, and no throttle-event datapoint published at all.

## 2. The brief

Taken from the review page (§10, D1–D3):

- **The floor stays at one task.** Not a cost constraint the design may negotiate away — it is the
  scenario. "floor 1 instance, but I want it scale up to 15 fast enough."
- **The spike to survive is short.** "holding its peak 6–8 minutes — not required, it can be short
  spike but we should handle it." A sustained-load test is explicitly not the target.
- **The load tests are frozen.** Improvements come from infrastructure and service code only.

This rules out the two cheapest answers in the general case — raise the floor, and make each task
bigger — and leaves only: react faster, and survive the window in which reacting is impossible.

## 3. Why the current configuration cannot meet the brief

Target tracking computes `desired = ceil(current × metric ÷ target)`. **CPU utilization is bounded
at 100%.** With `target_value = 60`, the largest multiplier the formula can ever produce is
100 ÷ 60 = 1.67 — so from one task, no CPU-driven decision can ask for more than two tasks, no
matter how overloaded the service is. Ten times the traffic and a hundred times the traffic yield
the same answer.

Reaching 15 from 1 therefore takes five consecutive decisions — 1 → 2 → 4 → 7 → 12 → 15 — each a
full control loop apart. Modelled against the measured alarm shape, that is roughly **480 seconds**
before the last task is even requested, plus launch and registration.

This is the reason the floor constraint in §2 bites so hard, and it is why change 1 below is about
decision *size* rather than decision *speed*. The two are separate problems and need separate
fixes.

## 4. Change 1 — scale on requests per target

Replace the predefined metric on the existing target-tracking policy:

> **Correction, 2026-09-16:** "replace" is wrong. The CPU target-tracking policy is **kept**, and
> request count is a **second** target-tracking policy alongside it — as this section's own
> paragraph "The CPU policy is kept, not replaced" below says, and as built in
> `ecs-dynamodb-rps/infra/main/autoscaling.tf` (`aws_appautoscaling_policy.requests`). The HCL block
> is that second policy's metric specification.

```hcl
predefined_metric_specification {
  predefined_metric_type = "ALBRequestCountPerTarget"
  resource_label         = "${aws_lb.main.arn_suffix}/${aws_lb_target_group.app.arn_suffix}"
}
target_value = 6000   # requests per target per MINUTE — 100 rps/task
```

`ALBRequestCountPerTarget` is unbounded and proportional to capacity, so one decision can go
straight to the fleet the traffic needs: at ten times the target it asks for ten times the tasks.
Modelled: 1 → 10 → 15, reaching the right size around **300 s** instead of 480 s.

**The CPU policy is kept, not replaced.** Application Auto Scaling takes the largest desired count
any policy asks for, so a second policy costs nothing and covers what this one misses: requests
that are individually expensive. A burst of `/reports` is cheap in request count and dear in CPU.

Three things to get right:

- **`target_value` is per minute, not per second.** 6,000 = 100 rps per task. This is the single
  number in this spec most likely to be wrong, because the per-task capacity it encodes is not yet
  measured — run 8554820 brackets it between 100 and 200 rps and cannot localise it further. 6,000
  is the conservative end of that bracket. It must be re-derived once a pinned-fleet discovery run
  exists.
- **The metric is not reported when no requests flow**, which drives its alarm to
  `INSUFFICIENT_DATA`. Harmless here: the Grafana synthetic canary sustains ~23 rps continuously
  (measured: ~1,392 requests/minute at the ALB between runs), which at one task is ~1,380/min —
  well under target, so it keeps the metric alive without provoking a scale-out.
- **Not supported with blue/green deployments.** This service uses the rolling controller with a
  deployment circuit breaker, so it does not apply — but it constrains any future move to
  `CODE_DEPLOY`.

## 5. Change 2 — event-loop utilization as a high-resolution metric

The 180-second wait in §1 is three 60-second CPU datapoints. Event-loop utilization saturates in
seconds and the service already computes it; the project runbook already treats event-loop delay as
the per-task saturation signal, having measured it pinned at 1.000 during a 2026-09-01 overload
while CPU read 3–16%.

**Publish it to CloudWatch with `PutMetricData` at `StorageResolution = 1`, every 10 seconds**,
dimensioned by service (not task) so datapoints from multiple tasks aggregate. Then alarm on a
**20-second period, 1 datapoint**, and drive a **step scaling** policy:

```
ELU >= 0.70  ->  +200%    # of current capacity: 1 -> 3, or 5 -> 15 (capped at autoscaling_max)
ELU >= 0.85  ->  +400%    # of current capacity: 1 -> 5, or 3 -> 15 (capped at autoscaling_max)
```

*(Step labels corrected 2026-09-16: they originally read `1 -> 3` and `3 -> 15`, which contradicted
the model line below. A spike that cliffs — as run 8554820 did — crosses 0.85 inside the first
20-second period, so the first decision is the +400% step, 1 → 5, and the next is 5 → 15. The
+200% step is the shallow case, where ELU crosses 0.70 without reaching 0.85.)*

Expressed as Application Auto Scaling wants it: **one** alarm at threshold 0.70, and one step-scaling
policy whose `step_adjustment` bounds are *relative to that threshold* — `metric_interval_lower_bound
= 0` for +200%, and `= 0.15` (i.e. 0.85 absolute) for +400%. Both thresholds sit below the shed
threshold of §6.1, and must stay there.

**Step scaling, not target tracking — for the same reason as §3.** Event-loop utilization is
bounded 0–1 exactly like CPU, so target tracking on it would inherit the identical 1.67× ceiling
and buy only speed, not size. Step scaling states the jump directly. Percentages are used so the
steps compound correctly from any fleet size.

Modelled: detection ~30 s instead of ~180 s; 1 → 5 → 15 reaching full fleet around **100 s**.

Decisions embedded here, each with its reason:

- **`PutMetricData`, not EMF through CloudWatch Logs.** The EMF route is tempting because the
  `awslogs` driver already exists and needs no new IAM, but it adds log ingestion delay to the
  precise number this change exists to shrink. Cost of the direct call: one IAM statement
  (`cloudwatch:PutMetricData` on the task role) and roughly $1/month — the custom metric at
  $0.30/metric-month plus a high-resolution alarm at $0.30/alarm-month, with 10-second publishing
  comfortably inside the 1M-request free tier at this task count. (One-second publishing would be
  ~$16/month in request charges; it is not needed.)
- **A known ceiling on the benefit:** a CloudWatch alarm with an Auto Scaling action re-invokes at
  most once per minute. Twenty-second detection therefore buys a fast *first* decision, not a fast
  repeating one — which is why the steps in the table are large. Each decision has to count.
- **Not superseded by AWS's own feature.** ECS gained native 20-second CPU/memory metrics on
  2026-06-18 (AWS-published benchmark: scale-out trigger 363 s → 86 s), which would be the better
  answer for CPU. It is unreachable: the setting lives in a `monitoring` block on the ECS service
  and the Terraform AWS provider has no such argument as of v6.64.0 (tracking issue #48669, PR
  #48792, both open). Under the repo's "Terraform is the only way infrastructure exists" rule this
  stays out of scope. Event-loop utilization is in any case a signal ECS will never publish.

## 6. Change 3 — admission control instead of queueing

Even change 2 reaches 15 tasks at ~100 s, and those tasks need roughly another 90 s to launch and
register. **Nothing protects the first two to three minutes of a spike except the one task already
running** — which is exactly the case §2 names.

Today that task queues everything, and §1 quantifies the result: response time 0.84 ms → 138.9 ms,
zero errors, zero rejections, and 71% of fast-class requests pushed over their threshold by a
uniform ~130 ms of queueing. The service was asked for roughly 10% more than it could serve and
failed the SLO for most of its traffic.

**Reuse the signal from §5.** The same event-loop utilization that drives the scaler decides
admission locally: above the threshold, **reject immediately with 429 and `Retry-After`** rather
than accepting into a queue (D4, the user's own wording). One measurement, two consumers — the
scaler asks for more tasks, the shedder protects the tasks that exist.

### 6.1 The invariant: shed **above** scale-out

This is the subtlest thing in the design and the easiest to get backwards — the first draft of this
spec did.

Shedding **lowers** event-loop utilization: that is what it is for. So the shed threshold clamps ELU
at roughly its own value. If shedding starts at 0.75 while the scale-out steps sit at 0.80 and 0.85,
ELU never climbs past 0.75, **the scaling alarm never fires at all**, and the service quietly sheds
forever on one task while looking healthy. The intuition "protect yourself before asking for help"
produces exactly the wrong order.

> **Invariant: every scale-out threshold must sit strictly below the shed threshold.**
> With §5's steps at 0.70 and 0.85, the shed threshold is **0.92**. Both steps can fire, and the
> alarm stays in breach after shedding engages, because 0.92 > 0.70.

Task 9 of the plan asserts this in a unit test against the configured values, so a later tuning pass
cannot silently invert it.

Change 1 is the second line of defence for the same failure: `ALBRequestCountPerTarget` is measured
at the load balancer and counts arrivals, so it keeps asking for tasks regardless of what the service
does with them — including rejecting them. If the ELU policy is ever clamped into silence, the
request-count policy still scales.

### 6.2 Other design notes

- The rejection path must not do database work and must not allocate meaningfully; a shed request
  should cost ~1 ms, which is what makes it strictly better than a queue slot.
- `Retry-After` should be short (1–2 s) — the fleet is expected to grow within ~100 s, so a client
  that backs off and retries is the behaviour we want.
- This changes what the availability SLO measures. §7 is the consequence, and it was decided
  before this was accepted.

## 7. The 4xx divergence — knowingly accepted

The SLO is defined in two places, and they already disagree about client errors. Nothing noticed
because no load profile has ever produced a 4xx. Change 3 produces them by design.

| a fast 429 counts as | because | result |
|---|---|---|
| Grafana SLO — `service/scripts/generate-slo.js` | `GOOD = http_response_status_code!~"5.."`, applied to the numerator only | **good** |
| k6 SLI — `infra/k6/tests/lib/request.js` | `ok = status >= 200 && status < 300`, then `sloMet.add(ok && …)` | **a miss** |
| k6 availability gate — `infra/k6/tests/lib/slo.js` | `http_req_failed: rate<0.001`, and k6 counts any status ≥ 400 as failed | **breached** |

`slo.yaml` asserts the two agree: *"A 4xx is NOT a miss: a client error is not charged to the
service."* That is true of the Grafana half and false of the k6 half. The divergence is
pre-existing and latent; change 3 activates it.

**Decision D4: accept the divergence; do not touch the tests.** Consequence, stated plainly so no
future reader mistakes it for a regression:

> Once shedding is enabled, a run in which the service behaves **correctly** will report a healthy
> SLO in Grafana and a **failed** run in k6 — exit code 99, with `slo_met` and `http_req_failed`
> both breached. For shedding runs, k6's exit code no longer carries the verdict; Grafana does.

The one-line alternative was considered and rejected by the user: adding
`responseCallback: http.expectedStatuses({min:200,max:299}, 429)` in `lib/request.js` would make
the k6 side match what `slo.yaml` already claims, without touching load shape, stages or
thresholds. It remains available if the red runs prove too confusing in practice; reopening it
requires a new decision, recorded here.

**This is the single highest-risk item in this spec** — not technically, but procedurally. A
verdict that is wrong on purpose is a verdict the next person will misread. Task 1 therefore
carries the documentation work, and it is not optional:

- `slo.yaml` — forward-pointer at the 4xx sentence itself, naming this section.
- `docs/superpowers/specs/2026-09-02-ecs-dynamodb-rps-restructure-design.md` §392 — same.
- `ecs-dynamodb-rps/README.md` — a line in the load-test reading guidance saying that a shedding
  run's k6 exit code is expected to be 99 and what to read instead.

## 8. How this is measured with the tests frozen

Freezing the tests costs less than it sounds, because the right instrument already exists and is
not the one that produced run 8554820.

| profile | usable? | why |
|---|---|---|
| `stress.js` | **yes, unchanged** | 1 min at `RATE`, 30 s ramp to 3×, 2 min hold, ramp down. That *is* a short spike — the case in §2. It deliberately carries no `abortOnFail`, so it runs to completion and records the whole burn. |
| `discovery.js` | not for scaling | Its cumulative `slo_met` abort ends the run ~135 s in, and its steps change every 60 s — far shorter than the control loop. It measures a fixed fleet's ceiling, which is still worth having, but cannot judge a scaling change. |

**Scale-out speed is measured on the AWS side, and has to be**: the k6 result says whether the SLO
held, not when the fleet grew. The primary numbers, all of which were used to write this spec:

- `aws application-autoscaling describe-scaling-activities` — the timestamp of the first action and
  the desired count it jumped to. This is *the* number for changes 1 and 2.
- `aws ecs describe-tasks` `createdAt` → `startedAt`, then target health — the launch and
  registration tail, which is currently an estimate (~50 s and ~40 s; AWS publishes no figure for
  either) and should be replaced with a measurement on the first run.
- CloudWatch `AWS/ECS` and `AWS/ApplicationELB` — the fleet and the offered load, minute by minute.

**A baseline run is required before any change lands.** Without one, "faster" has nothing to be
faster than. One `stress.js` run against today's CPU-only configuration, with the scaling activity
log captured, is plan Task 4.

Accepted up front: with the floor at one, every run begins from a cold single task, so the first
~2 minutes of every spike run will look poor in the k6 summary even after all three changes. That
is the specified design working, not a regression — and it is why change 3 matters more here than
it would with a higher floor.

## 9. Prerequisites and corrections

Two pre-existing defects, both of which distort any measurement taken before they are fixed:

- **The floor and the baseline must agree.** `desired_count = 5` against a floor of 1 is what
  produced §1. With the floor staying at 1 per §2, the fix is `desired_count = 1` — or better,
  `min_capacity = var.desired_count` in `autoscaling.tf`, so there is one number instead of two
  that can drift. The `ignore_changes` comment in `ecs.tf` documents the previous incarnation of
  this same failure and should gain a pointer to this one.
- **Read capacity is 25 RCU short of the model.** **Superseded in its mechanism, not its number, by
  `docs/superpowers/specs/2026-09-18-ecs-dynamodb-rps-capacity-authority-design.md`:** the fix below
  was to delete the two lines from `dev.tfvars` so the generated file would apply. Since 2026-09-18
  `capacity.auto.tfvars` no longer exists and `dev.tfvars` sets `read_capacity = 1025` /
  `write_capacity = 200` itself — the same values, now where they can be seen. Do not re-delete
  them; that leaves the variables unset, and they have no default. The rest of this bullet stands.
  `capacity.auto.tfvars` (generated) says 1,000 rps
  of this mix needs **1,025 RCU / 200 WCU**; `dev.tfvars` overrides to **1,000 / 500**. Invisible
  at today's 171 RCU/s, guaranteed to throttle the moment the service can push 1,000 rps — which is
  the point of this entire spec. Run 8554820 incidentally validated the model: 171.5 RCU/s at
  ~175 rps is 0.98 RCU per request against the predicted 1.025.

## 10. Decisions taken

| id | decision | choice | when |
|---|---|---|---|
| D1 | What the next run measures | Scaling speed first, not capacity | 2026-09-14 |
| D2 | The floor, and the spike shape | Floor stays 1; target is a **short** spike, not a sustained hold | 2026-09-14 |
| D3 | First lever | Scale on requests per target (§4) — extended 2026-09-15 to all three changes | 2026-09-14/15 |
| D4 | How the tests treat a shed request | Accept the k6 red; reject with 429 + `Retry-After` (§7) | 2026-09-15 |
| D5 | Spec shape | One spec covering all three changes | 2026-09-15 |
| D6 | Environment | Torn down; verified clean 2026-09-15 (no table, ALB, NAT, EIP, log group or ECR repo remained) | 2026-09-15 |

## 11. Risks and open questions

1. **`target_value = 6000` is a guess inside a measured bracket.** Per-task capacity is known only
   to lie between 100 and 200 rps. If the true figure is near 200, the fleet over-scales by ~2×; if
   near 100, it is correct. Resolving it needs a pinned-fleet discovery run, which D1 deferred.
   Mitigation: start conservative, and treat the first spike run's steady-state task count as the
   correction signal.
2. **The ELU thresholds (0.70 / 0.85) are unmeasured.** They are chosen to sit below saturation,
   but the relationship between ELU and this service's knee has never been plotted. The first run
   should record ELU alongside delivered rps so the thresholds can be set from data.
3. **The shed threshold can silence the scaler.** Shedding reduces event-loop utilization, so a shed
   threshold at or below the scale-out thresholds clamps ELU under the alarm and the service sheds
   forever on one task while reporting healthy. §6.1 states the invariant (every scale-out threshold
   strictly below the shed threshold), Task 9 asserts it in a unit test, and change 1 is the second
   line of defence — requests-per-target counts arrivals at the load balancer and is unaffected by
   what the service does with them.
4. **A wrong-on-purpose k6 verdict (§7).** Mitigated by documentation only, which is weak. Revisit
   if it causes a single misread run.
5. **Rebuilding the environment costs a fresh ALB endpoint and an image build** — the ECR
   repository was destroyed with everything else, so `scripts/deploy-service.sh` must run before
   the first load test.
6. **Shedding can silence the scaler even with the invariant satisfied** (added 2026-09-16, from
   the final branch review). The admission gate as built is all-or-nothing on a 250 ms ELU window
   with no hysteresis: above 0.92 it rejects every request, ELU falls, it admits every request, ELU
   rises again. The publisher sends a 10-second average to CloudWatch, and an on/off cycle can
   average **below the 0.70 alarm threshold while the task is actively shedding** — so the ELU
   alarm never fires although the ordering 0.70 < 0.85 < 0.92 holds. The request-count policy
   (change 1) still scales, which is why it stays on during the change 3 run. Plan Task 10 checks
   this: published ELU against the 429 rate, and whether alarm `ecs-dynamodb-rps-elu-high` actually
   entered ALARM. If it oscillates, the fix is proportional shedding or hysteresis on the gate — a
   new decision, recorded in a new spec.

## 12. Task outline for the plan

Written out properly in `docs/superpowers/plans/` once this spec is approved. Per the repo's
adaptation of `subagent-driven-development`, every `terraform apply` and `terraform destroy` is its
own task and stops for approval.

1. Documentation corrections: the §7 forward-pointers (`slo.yaml`, the 2026-09-02 spec, the
   README), and the `ecs.tf` pointer from §9. No infrastructure.
2. Fix `desired_count` / `autoscaling_min` (§9) and raise read capacity to 1,025 (§9). Plan only.
3. **Apply** — stops for approval. Then `deploy-service.sh`.
4. Baseline: one `stress.js` run, unchanged, with the scaling activity log and task launch timings
   captured (§8). Record in `results.md`.
5. Change 1 (§4) — HCL, `fmt -check`, `validate`, reviewed `plan`.
6. **Apply**, re-run the identical `stress.js`, compare first-activity timestamp and jump size.
7. Change 2 (§5) — service-side `PutMetricData`, IAM statement, high-resolution alarm, step policy.
8. **Apply**, re-run, compare detection time.
9. Change 3 (§6) — admission control in `server.js`, with unit tests for the threshold behaviour
   (this part *is* application code and takes the red-green loop).
10. **Apply**, re-run, compare `slo_met` among 2xx and the p99 shape. Expect a red k6 verdict (§7).
11. Write up in `results.md` and the project README; **destroy** — stops for approval — then the
    billable-resource sweep.
