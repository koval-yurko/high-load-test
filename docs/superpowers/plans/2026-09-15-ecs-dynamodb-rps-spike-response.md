# ecs-dynamodb-rps — spike response from a floor of one task

- **Status:** partially executed (on hold) — Tasks 1–2 done on branch
  `spike-response/ecs-dynamodb-rps`. Blocked on Task 3, the first `terraform apply`, which stops for
  the user's approval by repo rule. Tasks 3–11 not started.
- **Spec:** `docs/superpowers/specs/2026-09-15-ecs-dynamodb-rps-spike-response-design.md` (approved
  2026-09-15)
- **Goal:** from a floor of **one** task, the service answers a **short** spike — measured as the
  timestamp and size of the first scaling action, and as SLO attainment for the traffic it serves —
  without any change to the k6 load profiles.
- **Starting state:** environment destroyed and swept clean (2026-09-15: no table, ALB, NAT, EIP, log
  group or ECR repository). `master`, working tree carries the uncommitted `dev.tfvars` / `ecs.tf` /
  `variables.tf` / `env` skill edits described in Task 2.

**Task ordering rule:** every `terraform apply` and `terraform destroy` is its own task and **stops
for approval** (repo rule — `subagent-driven-development` is adapted this way in CLAUDE.md). A
subagent may write and `plan` Terraform freely; it may not apply it.

**Per-task HCL verification** (every task that touches `.tf`): `terraform fmt -check -recursive`,
`terraform validate`, then a reviewed `plan` whose diff is recorded in the execution record below.

---

## Task 1 — Documentation: record the 4xx divergence (no infrastructure)

Spec §7 makes this mandatory and first: from Task 10 onward a correct run reports a **failed** k6
verdict, and nothing else in the repo says so.

- [ ] `ecs-dynamodb-rps/slo.yaml` — at the 4xx sentence in the `latency-classes` comment ("A 4xx is
  NOT a miss…"), a forward-pointer naming spec §7 and stating plainly that **k6's `slo_met` does not
  implement this** and records a 4xx as a miss. Put it at the decision, not in a header.
- [ ] `docs/superpowers/specs/2026-09-02-ecs-dynamodb-rps-restructure-design.md` — same pointer at the
  "A 4xx is not a miss" line (~§392).
- [ ] `ecs-dynamodb-rps/README.md` — in **Phase 3 — Read the result**, a line: once admission control
  is live, a shedding run exits **99** with `slo_met` and `http_req_failed` breached, and that is the
  expected result; read SLO attainment from Grafana for those runs.
- [ ] `ecs-dynamodb-rps/infra/main/ecs.tf` — extend the existing `ignore_changes` comment with a
  pointer to the 2026-09-14 recurrence (floor 1 vs baseline 5) and to Task 2's fix.
- [ ] Verify: `npm run slo:check` from `ecs-dynamodb-rps/service/` — the generated artifacts must stay
  byte-identical. A YAML comment must not move them; if it does, the generator reads more than it
  should and that is a finding.

## Task 2 — The two pre-existing defects (HCL, plan only)

Spec §9. Both distort any measurement taken before they land, so they precede the baseline.

- [ ] `ecs-dynamodb-rps/infra/main/autoscaling.tf` — `min_capacity = var.desired_count` on
  `aws_appautoscaling_target.ecs`, so one number governs the floor and the Terraform baseline and
  they cannot drift apart again.
- [ ] `ecs-dynamodb-rps/infra/main/variables.tf` — delete `variable "autoscaling_min"`. Keep
  `autoscaling_max` (15). Deleting it is the point: a second number is what caused run 8554820.
- [ ] `ecs-dynamodb-rps/infra/main/dev.tfvars` — `desired_count = 1` (the floor per spec §2), and
  **delete** `read_capacity` / `write_capacity` so the generated `capacity.auto.tfvars` (1,025 RCU /
  200 WCU) applies, exactly as that file's own comment instructs. Rewrite the stale comment block
  that still describes the free-tier pin.
- [ ] Sanity-check the WCU drop 500 → 200 against measurement: run 8554820 consumed 33.5 WCU/s at
  ~175 rps = 0.19 WCU/rps, so 1,000 rps ≈ 191 WCU. 200 is sized, not guessed.
- [ ] Verify: `fmt -check`, `validate`, `plan -var-file=dev.tfvars` against the empty state — expect a
  full create, with `read_capacity = 1025`, `write_capacity = 200`, `desired_count = 1`,
  `min_capacity = 1`, `max_capacity = 15`.

## Task 3 — Apply, deploy, upload (STOPS FOR APPROVAL)

- [ ] `/env up ecs-dynamodb-rps` — creates everything from nothing, including the ECR repository and
  the k6 project (the latter moved into `infra/main` by the 2026-09-14 plan).
- [ ] `ecs-dynamodb-rps/scripts/deploy-service.sh` — the repository is new and empty, so there is no
  image until this runs. The first `terraform apply` will have created a service that cannot pull;
  expect the deployment circuit breaker to matter here and record what it does.
- [ ] `ecs-dynamodb-rps/scripts/upload-k6.sh` — re-upload the three profiles into the new k6 project.
  `BASE_URL` and `RATE` are baked into the archive at upload time, so this must follow the apply, and
  **`RATE` must be 100** (the discovered capacity from run 8554820) so `stress.js` peaks at 300.
- [ ] Record: the new ALB DNS name, the new k6 project id, and `desired/running` from
  `describe-services` — confirming the fleet sits at 1 and **stays** at 1 fifteen minutes later,
  which is the proof Task 2 worked.

## Task 4 — Baseline: `stress.js` unchanged (needs the environment)

Spec §8. Without this, "faster" has nothing to be faster than. The profile is **not** edited.

- [ ] `/loadtest ecs-dynamodb-rps stress` — 1 min at 100 rps, 30 s ramp to 300, 2 min hold, ramp down.
  No `abortOnFail` in this profile, so it runs to completion.
- [ ] Capture from the AWS control plane, in the run's own window:
  - `aws application-autoscaling describe-scaling-activities` — timestamp of the first action and the
    desired count it jumped to. **Expected: either nothing, or one action to 2**, per spec §3. Record
    whichever it is; "nothing happened" is the baseline.
  - `aws ecs describe-tasks` `createdAt` → `startedAt`, then target health from
    `describe-target-health` — the launch and registration tail. **This is the measurement that
    replaces the two estimated bars (~50 s, ~40 s) in the spec and on the review page.** Amend both
    with the real numbers.
  - CloudWatch `AWS/ECS CPUUtilization`, `AWS/ApplicationELB RequestCount` / `TargetResponseTime`,
    `AWS/DynamoDB` consumed capacity and both throttle metrics.
- [ ] Append the row to `ecs-dynamodb-rps/results.md` — the file does not exist yet, so this creates
  it. `infra change` = "baseline: CPU target tracking, floor 1, 1,025 RCU".
- [ ] Verify the k6 numbers come from this run's own output, per CLAUDE.md — no remembered figures.

## Task 5 — Change 1: scale on requests per target (HCL, plan only)

Spec §4.

- [ ] `ecs-dynamodb-rps/infra/main/autoscaling.tf` — add a **second**
  `aws_appautoscaling_policy` (`requests`) rather than editing the CPU one. Both stay; Application
  Auto Scaling takes the largest desired count any policy asks for, and the CPU policy covers
  requests that are individually expensive (a `/reports` burst is cheap in count, dear in CPU).
  ```hcl
  predefined_metric_specification {
    predefined_metric_type = "ALBRequestCountPerTarget"
    resource_label         = "${aws_lb.main.arn_suffix}/${aws_lb_target_group.app.arn_suffix}"
  }
  target_value       = var.autoscaling_rps_target   # 6000 = requests per target per MINUTE
  scale_out_cooldown = 30
  scale_in_cooldown  = 120
  ```
- [ ] `variables.tf` — `autoscaling_rps_target`, default 6000, with a comment carrying the whole
  derivation: it is per **minute**, 6,000 = 100 rps/task, the per-task capacity is only bracketed
  between 100 and 200 rps by run 8554820, and 6,000 is the conservative end. Name the correction
  signal: the steady-state task count in Task 6's run.
- [ ] Comment the two facts that will otherwise be re-learned: the metric is **not reported at all**
  when no requests flow (alarm → `INSUFFICIENT_DATA`; harmless because the canary sustains ~23 rps
  ≈ 1,380/min at one task, well under target), and it is unsupported with blue/green deployments.
- [ ] Verify: `fmt -check`, `validate`, reviewed `plan` — expect exactly one policy added, nothing
  destroyed.

## Task 6 — Apply change 1 and re-measure (STOPS FOR APPROVAL)

- [ ] `terraform -chdir=ecs-dynamodb-rps/infra/main apply -var-file=dev.tfvars`
- [ ] `/loadtest ecs-dynamodb-rps stress` — **identical profile, identical RATE**. The infrastructure
  changed; the test did not.
- [ ] Compare against Task 4 and record in `results.md`: first scaling action timestamp, the desired
  count it jumped to (the headline — spec §3 predicts CPU could only ever ask for 2, this should ask
  for many more), steady-state task count, and SLO attainment.
- [ ] If the steady-state count is far from what 1,000-rps-equivalent load implies, correct
  `autoscaling_rps_target` and say so — that is the calibration signal named in Task 5.

## Task 7 — Change 2: event-loop utilization at high resolution (service + HCL, plan only)

Spec §5. The service half is application code and takes the red-green loop; the HCL half does not.

- [ ] `service/src/elu.js` — sample `perf_hooks.performance.eventLoopUtilization()` as a delta between
  successive calls. **Test first**: the utilization of a deliberately blocked loop approaches 1, an
  idle loop approaches 0, and successive calls do not double-count. This is the number both this
  change and Task 9 depend on, so it is the one thing here that must be provably right.
- [ ] `service/src/cloudwatch.js` — `PutMetricData` every 10 s: namespace `ecs-dynamodb-rps`, metric
  `EventLoopUtilization`, `StorageResolution: 1`, dimensioned by **service, not task**, so datapoints
  from multiple tasks aggregate under one alarm. Failures must be swallowed and counted, never
  thrown — a metrics outage must not take the service down. Test with a stubbed client.
- [ ] Not EMF-through-logs, and the comment must say why: the `awslogs` driver needs no new IAM, but
  log ingestion delay lands on the exact number this change exists to shrink (spec §5).
- [ ] `infra/main/ecs.tf` — the IAM statement (`cloudwatch:PutMetricData`, which has no resource-level
  permissions, so scope it with a `cloudwatch:namespace` condition) and the new environment
  variables.
- [ ] `infra/main/autoscaling.tf` — **one** `aws_cloudwatch_metric_alarm`: period **20**,
  `evaluation_periods = 1`, threshold **0.70**, statistic Average. Then **one**
  `aws_appautoscaling_policy` of `policy_type = "StepScaling"` with
  `adjustment_type = "PercentChangeInCapacity"`, `metric_aggregation_type = "Maximum"`, and two
  `step_adjustment` blocks whose bounds are **relative to the alarm threshold**:
  `metric_interval_lower_bound = 0` → `+200`, `metric_interval_lower_bound = 0.15` (0.85 absolute) →
  `+400`. `MinAdjustmentMagnitude` 1 so a percentage of 1 task still moves.
- [ ] Comment the ceiling so nobody re-derives it: an alarm with an Auto Scaling action re-invokes at
  most **once per minute**, so 20-second detection buys a fast *first* decision, not a fast repeating
  one — which is why the steps are large.
- [ ] Verify: `npm test` in `service/`, `fmt -check`, `validate`, reviewed `plan`.

## Task 8 — Apply change 2 and re-measure (STOPS FOR APPROVAL)

- [ ] Apply, then `deploy-service.sh` (the service image changed).
- [ ] `/loadtest ecs-dynamodb-rps stress` — identical profile again.
- [ ] The headline number: **seconds between the first over-threshold ELU sample and the scaling
  activity's `StartTime`.** Spec §5 predicts ~30 s against the baseline's ~180 s.
- [ ] Confirm the ELU series is actually arriving at 20-second resolution in CloudWatch before trusting
  any of it — a high-resolution metric that silently landed at 60 s would produce a plausible-looking
  wrong answer.
- [ ] Record in `results.md`.

## Task 9 — Change 3: admission control (service code, TDD)

Spec §6. Application code: red-green loop applies.

- [ ] `service/src/admission.js` — reject when ELU exceeds `SHED_ELU_THRESHOLD` (**0.92**), with
  **429** and `Retry-After: 1`. Tests first: above the threshold rejects, below admits, the rejection
  path touches no repository method, and the response carries the header.
- [ ] **Assert spec §6.1's invariant in a unit test**: every configured scale-out threshold (0.70,
  0.85) is strictly less than the shed threshold (0.92). Shedding lowers ELU, so a shed threshold at
  or below the scale-out steps clamps the metric under the alarm and the service sheds forever on one
  task while looking healthy. A later tuning pass must fail this test rather than discover it in a
  run.
- [ ] `service/src/server.js` — the gate runs **before** routing and before body reading, so a shed
  request costs ~1 ms. `/healthz` is never shed: the ALB must not be told the task is unhealthy
  because it is busy.
- [ ] Confirm the recorded metrics still classify a shed request correctly — `recordRequest` sees a
  429 and the Grafana `GOOD` selector (`!~"5.."`) must count it as good, per spec §7.
- [ ] Verify: `npm test`.

## Task 10 — Apply change 3 and re-measure (STOPS FOR APPROVAL)

- [ ] Apply / `deploy-service.sh`, then `/loadtest ecs-dynamodb-rps stress` — identical profile.
- [ ] **Expect k6 to report failure: exit 99, `slo_met` and `http_req_failed` both breached.** Spec §7
  decided this. It is not a regression, and Task 1 is what stops the next reader thinking it is.
- [ ] The real verdict comes from Grafana: SLO attainment over the run window, plus `slo_met` among
  2xx responses only, plus the shape of p99. The prediction is a **flat** p99 with a visible rejection
  rate, instead of the baseline's rising p99 with none.
- [ ] Record in `results.md`, with both verdicts side by side and a sentence naming which one counts.

## Task 11 — Write up and tear down (STOPS FOR APPROVAL)

- [ ] `ecs-dynamodb-rps/README.md` — the measured results: the four runs, what each change bought,
  and the launch/registration numbers from Task 4.
- [ ] Amend the spec and the review artifact with the real numbers in place of the estimates and the
  modelled convergence chart. The chart is labelled "arithmetic, not a measurement"; replace it or
  annotate it with what actually happened.
- [ ] Completeness check before writing up: no row in `results.md` may have a blank `infra change`,
  `k6 attainment`, `service attainment` or `throttles`. Re-derive those field indices by piping the
  header through `awk -F'|'` — never by counting pipes, because a leading-pipe Markdown row makes
  `$1` the empty string before the first column. The snippet is in `.claude/skills/loadtest/SKILL.md`.
- [ ] Commit. Conventional Commits; these are `perf(ecs-dynamodb-rps)` commits and their bodies carry
  the before/after numbers, which is what makes `git log --grep '^perf'` the history of what moved.
- [ ] `/env down ecs-dynamodb-rps` — **stops for approval** — then the billable-resource sweep.
  `terraform destroy` succeeding is not evidence the account is clean.

---

## Execution record

- **Task 1** — done, `768e42c`. The `ignore_changes` comment Task 1 said to extend did not exist
  in `ecs.tf`; a new comment now sits above `desired_count = var.desired_count` instead. Two stale
  lines in the spec were also corrected: risk 2's ELU thresholds 0.80/0.95 became 0.70/0.85, and
  "baseline is Task 2" became plan Task 4. `npm run slo:check`: "slo.yaml and its generated
  outputs agree".
- **Task 2** — done, `4a10da7`. `fmt -check` clean, `validate` ok (2 pre-existing warnings in
  unrelated files). `plan -var-file=dev.tfvars` against the empty state: **56 to add, 0 to change,
  0 to destroy**; planned `read_capacity = 1025`, `write_capacity = 200`, `desired_count = 1`,
  `min_capacity = 1`, `max_capacity = 15`. No NAT gateway or EIP; the one VPC endpoint is the
  DynamoDB gateway endpoint.
