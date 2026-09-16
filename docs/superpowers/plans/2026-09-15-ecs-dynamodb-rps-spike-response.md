# ecs-dynamodb-rps — spike response from a floor of one task

- **Status:** partially executed (on hold) — updated 2026-09-16. **Done** on branch
  `spike-response/ecs-dynamodb-rps`: Tasks 1, 2, 5, 7 and 9 (all code, documentation and reviewed
  `plan` output; nothing applied by them). **Attempted and failed:** Task 3 — the 2026-09-15 apply
  created the AWS and Grafana resources but stopped on a 409 Conflict creating the k6 project,
  because the old k6 project 8476029 was still owned by `platform/` state; the environment has since
  been destroyed. **Not started:** Tasks 4, 6, 8, 10, 11 — every one needs the environment.
  **Blocking the rest:** each remaining task contains a `terraform apply` or `destroy`, and the user
  has not approved any further applies. The first step when they do is to clear the stale k6 project
  8476029 out of `platform/` state (Task 3's new first step), otherwise `/env up` hits the same 409.
  Changes 1–3 are each behind a Terraform flag defaulting off — see the gating ruling in the
  execution record.
- **Spec:** `docs/superpowers/specs/2026-09-15-ecs-dynamodb-rps-spike-response-design.md` (approved
  2026-09-15)
- **Goal:** from a floor of **one** task, the service answers a **short** spike — measured as the
  timestamp and size of the first scaling action, and as SLO attainment for the traffic it serves —
  without any change to the k6 load profiles.
- **Starting state:** environment destroyed and swept clean (2026-09-15: no table, ALB, NAT, EIP, log
  group or ECR repository). `master`, working tree carries the uncommitted `dev.tfvars` / `ecs.tf` /
  `variables.tf` / `env` skill edits described in Task 2. *(As of 2026-09-16 those edits are
  committed, and the environment is again fully destroyed after the failed Task 3 apply — see the
  execution record.)*

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

> **Rewritten 2026-09-16, before re-execution.** The first attempt (2026-09-15, see the execution
> record) failed on a k6 409 because `platform/` still owned k6 project 8476029, and the environment
> was destroyed afterwards. The first step below is new; the rest is unchanged. Every flag from
> Tasks 5, 7 and 9 stays **off** in `dev.tfvars` for this apply, so the environment built here is the
> baseline configuration — but the image deployed here already carries all the service code (the
> ELU publisher and the admission gate), so later tasks flip flags and never rebuild.

- [ ] **Clear the stale k6 project from `platform/` state first.** The 2026-09-14 k6-ownership plan's
  `terraform -chdir=platform apply` step never ran, so `platform/` state still lists
  `grafana_k6_project` 8476029 (name `ecs-dynamodb-rps`) and its limits, although by 2026-09-16 the
  project no longer exists in the k6 API. Run `terraform -chdir=platform plan` from the repo root —
  on 2026-09-15 it showed 0 to add, 1 to change (the `platform` workspace description), 2 to destroy
  (k6 project 8476029 and its limits); re-read it, since refresh may now drop the project on its own.
  Then `terraform -chdir=platform apply` — **stops for approval**. Expect the destroy either to no-op
  (refresh already removed the vanished project) or to fail with 404 on a resource that is already
  gone; **record which happened**, and if it is a 404 that leaves the address in state, stop and ask
  before reaching for `terraform state rm`.
- [ ] `/env up ecs-dynamodb-rps` — **stops for approval**. The environment is fully destroyed
  (2026-09-16: `infra/main` state empty, no table, ALB, NAT, EIP, log group or ECR repository), so
  this is a full create, not a resume of the failed 2026-09-15 apply: expect the plan Task 2 recorded
  (56 to add, 0 to change, 0 to destroy), including the ECR repository and the k6 project (the
  latter moved into `infra/main` by the 2026-09-14 plan).
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

> **Note 2026-09-16 (dev.tfvars ahead of the sequence):** `dev.tfvars` commits
> `requests_scaling_enabled = true` and `shedding_enabled = true` (see the gating ruling below), so
> Task 3's `/env up` already lands on the change-3 state, not the baseline. Before this task,
> re-apply with both overridden off: `terraform -chdir=infra/main apply -var-file=dev.tfvars -var
> requests_scaling_enabled=false -var shedding_enabled=false` — **stops for approval**, same as any
> apply. `elu_scaling_enabled` needs no override; it still defaults `false` in the file.

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
  > **Note 2026-09-16 (as built):** the policy is behind `requests_scaling_enabled` (default false,
  > `dev.tfvars` false), so with the committed tfvars the plan adds nothing; "exactly one policy
  > added" holds with the flag on (`-var requests_scaling_enabled=true`), which is how it was
  > verified: `aws_appautoscaling_policy.requests[0]` and nothing else. Reason: the gating ruling in
  > the execution record.

## Task 6 — Apply change 1 and re-measure (STOPS FOR APPROVAL)

> **Rewritten 2026-09-16, before execution, for the flag gating:** the change is one tfvars line, not
> new HCL.
>
> **Note 2026-09-16 (dev.tfvars ahead of the sequence):** `requests_scaling_enabled = true` is
> already committed, so there is no tfvars edit here — the change from Task 4's baseline is dropping
> its `-var requests_scaling_enabled=false` override and keeping the `shedding_enabled=false` one:
> `terraform apply -var-file=dev.tfvars -var shedding_enabled=false`.

- [ ] `plan -var-file=dev.tfvars -var shedding_enabled=false` must show **exactly one resource added,
  `aws_appautoscaling_policy.requests[0]`**, 0 to change, 0 to destroy; anything more means more
  than one thing is changing. No image rebuild, no `deploy-service.sh`.
- [ ] `terraform -chdir=ecs-dynamodb-rps/infra/main apply -var-file=dev.tfvars -var shedding_enabled=false`
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

> **Rewritten 2026-09-16, before execution, for the flag gating.** The original first step was
> "Apply, then `deploy-service.sh` (the service image changed)". It no longer applies: the ELU
> publisher, its IAM statement and its environment variables are not gated and were already in the
> image and task definition deployed at Task 3, so only the alarm and the step policy are new here.
>
> **Note 2026-09-16 (dev.tfvars ahead of the sequence):** `requests_scaling_enabled` needs no
> override — Task 6 already dropped it. `shedding_enabled` stays overridden off until Task 10.

- [ ] `ecs-dynamodb-rps/infra/main/dev.tfvars` — set `elu_scaling_enabled = true`.
  `requests_scaling_enabled` **stays true** from Task 6; nothing else changes. `plan
  -var-file=dev.tfvars -var shedding_enabled=false -var elu_scaling_enabled=true` must show
  **exactly two resources added** — `aws_cloudwatch_metric_alarm.elu_high[0]` and
  `aws_appautoscaling_policy.elu[0]` — 0 to change, 0 to destroy. Then apply with the same flags.
  **No redeploy:** the service image is unchanged.
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
  > **Note 2026-09-16 (as built):** the gate runs **after** `matchRoute` (a pure regex over the path,
  > no I/O) and after the response `finish` listener is attached, but still before body reading and
  > before the handler. Reason: a shed 429 then keeps its route label in the SLO metrics instead of
  > collapsing into `unmatched`; the spec's actual requirement for the rejection path (no database
  > work, ~1 ms — spec §6.2) still holds, at the cost of one regex per shed request.
- [ ] **Gating (added 2026-09-16, as built):** the HCL wiring lands here too, plan only —
  `shedding_enabled` (default false, `dev.tfvars` false) and `shed_elu_threshold` (default 0.92) in
  `variables.tf`; the task definition sets `SHED_ELU_THRESHOLD` only when the flag is on, and a
  service with the variable absent never sheds. Plan with the flag on and off shows identical
  resource lists — the difference is inside `container_definitions`, which is known only after apply.
- [ ] Confirm the recorded metrics still classify a shed request correctly — `recordRequest` sees a
  429 and the Grafana `GOOD` selector (`!~"5.."`) must count it as good, per spec §7.
- [ ] Verify: `npm test`.

## Task 10 — Apply change 3 and re-measure (STOPS FOR APPROVAL)

> **Rewritten 2026-09-16, before execution, for the flag gating.** The original first step was
> "Apply / `deploy-service.sh`". There is no image rebuild: the admission gate has been in the image
> since Task 3 and is inert while `SHED_ELU_THRESHOLD` is unset.
>
> **Note 2026-09-16 (dev.tfvars ahead of the sequence):** `shedding_enabled = true` is already
> committed, so there is no tfvars edit here either — the change from Task 8 is dropping the
> `-var shedding_enabled=false` override while keeping `-var elu_scaling_enabled=true`:
> `terraform apply -var-file=dev.tfvars -var elu_scaling_enabled=true`. This lands exactly where a
> plain `apply -var-file=dev.tfvars` would once `elu_scaling_enabled` is flipped `true` in the file
> too — the one flag this sequence never commits, so the override stays needed even here.

- [ ] **Both earlier flags stay on:** `requests_scaling_enabled = true` (committed) and
  `elu_scaling_enabled = true` (`-var` override, Task 8). Keeping the request-count policy on is not
  incidental — it is the second line of defence if shedding clamps ELU under the alarm (spec §6.1),
  because it counts arrivals at the load balancer, including the requests the service rejects. Leave
  `shed_elu_threshold` at its default 0.92.
- [ ] `plan -var-file=dev.tfvars -var elu_scaling_enabled=true` — expect a **new task-definition revision** (replacement of
  `aws_ecs_task_definition.app`) and an **in-place update of `aws_ecs_service.app`** to point at it;
  nothing else. Do not treat the plan as proof the variable is set: when Task 9 planned the flag on
  and off against the empty state the two resource lists were identical, because
  `container_definitions` was known only after apply, and against a live environment the change is
  one line buried in a JSON string diff. Then `apply -var-file=dev.tfvars -var
  elu_scaling_enabled=true`, and let the rolling deployment finish (`aws ecs wait services-stable
  --cluster ecs-dynamodb-rps --services ecs-dynamodb-rps`).
- [ ] **Verify the running task definition actually carries the threshold**, because the plan could
  not:
  ```bash
  TD=$(aws ecs describe-services --cluster ecs-dynamodb-rps --services ecs-dynamodb-rps \
    --query 'services[0].taskDefinition' --output text)
  aws ecs describe-task-definition --task-definition "$TD" \
    | jq '.taskDefinition.containerDefinitions[] | select(.name=="app").environment[]
          | select(.name=="SHED_ELU_THRESHOLD")'
  ```
  Expect `{"name": "SHED_ELU_THRESHOLD", "value": "0.92"}`. Absent means the service is not shedding
  and the run would measure Change 2 again — stop.
- [ ] `/loadtest ecs-dynamodb-rps stress` — identical profile.
- [ ] **Expect k6 to report failure: exit 99, `slo_met` and `http_req_failed` both breached.** Spec §7
  decided this. It is not a regression, and Task 1 is what stops the next reader thinking it is.
- [ ] The real verdict comes from Grafana: SLO attainment over the run window, plus `slo_met` among
  2xx responses only, plus the shape of p99. The prediction is a **flat** p99 with a visible rejection
  rate, instead of the baseline's rising p99 with none.
- [ ] **Check that shedding did not silence the scaler** (added 2026-09-16, from the final branch
  review). The admission gate is all-or-nothing on a 250 ms ELU window with no hysteresis: above
  0.92 it rejects everything, which drops ELU, which re-admits everything, which raises ELU again.
  The publisher sends a 10-second average, and an on/off cycle can average **below the 0.70 alarm
  threshold even while the task is shedding** — the §6.1 invariant (0.70 and 0.85 < 0.92) holds on
  paper and still fails in effect. Over the run window, plot the published `ecs-dynamodb-rps` /
  `EventLoopUtilization` series against the 429 rate (ALB `HTTPCode_Target_4XX_Count`, or the
  service's status-code series in Grafana), and confirm from
  `aws cloudwatch describe-alarm-history --alarm-name ecs-dynamodb-rps-elu-high` that the alarm
  actually entered `ALARM` while 429s were being returned, and from
  `describe-scaling-activities` that the ELU step policy (not only the request-count policy) acted.
  If ELU oscillates under 0.70 while shedding, record it as a finding: the request-count policy is
  then the only thing scaling, and the follow-up is proportional shedding or hysteresis on the gate
  — a **new decision**, recorded in a new spec, not a threshold tweak. Spec §11 carries this as a
  risk.
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
- **Task 3** — **attempted, failed, not complete.** Apply run 2026-09-15 20:24:43–20:28:20 UTC with
  the user's approval. The AWS and Grafana resources were created; `module.k6.grafana_k6_project.this`
  failed with **409 Conflict**: k6 project 8476029 (name `ecs-dynamodb-rps`) was still owned by
  `platform/` state, because the 2026-09-14 k6-ownership plan's `terraform -chdir=platform apply`
  step had never run. A `terraform -chdir=platform plan` then showed 0 to add, 1 to change (the
  `platform` workspace description), 2 to destroy (k6 project 8476029 and its limits). The user
  declined further applies and asked for all non-apply work to be finished first.
  `deploy-service.sh` and `upload-k6.sh` never ran. **Later, by 2026-09-16 and outside this
  session, the environment was destroyed:** `infra/main` state empty; no table, ALB, NAT gateway,
  EIP, log group or ECR repository; only INACTIVE ECS cluster/service/task-definition records in the
  tagging API. k6 project 8476029 is absent from the k6 API but **still listed in `platform/` state**
  (stale). Task 3's text was rewritten on 2026-09-16 to clear that state first and to expect a full
  create.
- **Gating ruling (2026-09-15, applies to Tasks 5, 7, 9 and to 6, 8, 10).** Deviation from the task
  text, which assumed each change's code lands right before its own apply. Because Tasks 5, 7 and 9
  were executed before the baseline run (Task 4) exists, **each change sits behind its own Terraform
  flag, defaulting false in `dev.tfvars`**: `requests_scaling_enabled` (Change 1),
  `elu_scaling_enabled` (Change 2), `shedding_enabled` (Change 3). Reason: "change one thing,
  identical profile" requires the baseline and every re-measure to run from the **same commit**; each
  re-measure task then flips exactly one flag and leaves the earlier flags on. All service code — the
  ELU publisher and the admission gate — ships in the image deployed at Task 3; the publisher, its
  IAM statement and its environment variables are not gated (publishing changes no scaling behaviour
  and gives the baseline an ELU series), and the gate is inert while `SHED_ELU_THRESHOLD` is unset.
  **Superseded in part, 2026-09-16:** `dev.tfvars` now commits `requests_scaling_enabled = true` and
  `shedding_enabled = true` — only `elu_scaling_enabled` still defaults `false`. Tasks 4, 6, 8 and 10
  carry `-var` overrides that reconstruct the original one-flag-per-run sequence on top of that file;
  see the note at each.
  Tasks 6, 8 and 10 were rewritten on 2026-09-16 to match.
- **Task 5** — done, `46abda3`. Code and plan only. Deviation: the policy is gated by
  `requests_scaling_enabled` (gating ruling above). `plan` with the flag on adds exactly
  `aws_appautoscaling_policy.requests[0]`; with it off, nothing.
- **Task 7** — done, `c0241b4` (service: ELU sampler and CloudWatch publisher) and `71549e4` (HCL:
  alarm and step policy). Code and plan only. Deviation: the alarm and step policy are gated by
  `elu_scaling_enabled`; the IAM statement, environment variables and publisher are always on.
  `plan` with the flag on adds exactly `aws_appautoscaling_policy.elu[0]` and
  `aws_cloudwatch_metric_alarm.elu_high[0]`. The alarm's 20-second period was checked against the
  CloudWatch PutMetricAlarm API reference ("Valid values are 10, 20, 30, and any multiple of 60").
- **Task 9** — done, `6172d0f` (HCL: `shedding_enabled` / `shed_elu_threshold` and the conditional
  `SHED_ELU_THRESHOLD`) and `6b2baba` (service: admission gate, 429 + `Retry-After: 1`). Code and
  plan only. Deviations: (1) gated by `shedding_enabled`, with the HCL wiring landing here because
  Task 10 is apply-only; (2) the gate runs after `matchRoute` and the `finish` listener rather than
  "before routing", so shed 429s keep their route label (dated note at the task line); (3) the
  §6.1 invariant test reads the configured thresholds from `autoscaling.tf`, `variables.tf` and
  `dev.tfvars` rather than literals, so a tuning pass must fail it. `npm test`: 128/128. `plan` with
  the flag on and off: identical resource lists — the difference is inside `container_definitions`,
  known only after apply, which is why Task 10 verifies the running task definition directly.
- **Final branch review fix wave (2026-09-16)** — this plan's status, record and apply tasks
  rewritten for the gating; README, spec and comment corrections; a validation block on
  `shed_elu_threshold`. No resource change (`plan -var-file=dev.tfvars` still 56 / 0 / 0).
