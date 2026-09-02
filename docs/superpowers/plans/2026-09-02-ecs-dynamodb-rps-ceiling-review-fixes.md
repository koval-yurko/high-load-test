# ecs-dynamodb-rps-ceiling — review fixes, tier 1

- **Date:** 2026-09-02
- **Status:** complete, 2026-09-02. Tasks 1–5 were squash-merged to master as `4bd3d52`; both
  applies were approved, run and verified; the k6 scripts were re-uploaded. Task 6 (README and
  `/loadtest` text) is edited in the main working tree on top of the owner's README rewrite and
  lands with that rewrite's commit. One owner check remains open and is recorded under the ledger:
  confirm the discovery test's Script tab in the k6 app shows the twenty `rps_N` steps.
- **Spec:** `IMPROVEMENTS.md` at the repo root, items 1–9 (tier 1). Decisions on items 1, 3, 6 and
  12 were taken by the owner on 2026-09-02 and are recorded in that file's *Open questions*
  section. Items 10–15 are out of scope here by that file's own sequencing.
- **Branch:** `worktree-review-fixes`, worktree `.claude/worktrees/review-fixes`.

**Goal:** land the nine changes that alter either a recorded number or whether a breach is noticed,
before the first row of `results.md` exists. Nothing here changes what the service does under load;
it changes how the number is computed, gated, displayed and routed.

**Process notes.** Every task that touches HCL ends with `terraform fmt -check` and `validate`.
`terraform plan` is run once at the end against the real workspace and its output is recorded
here; `terraform apply` is **not** run by this plan. Two applies follow from it, each its own
approval gate: a Grafana-only apply (dashboard, alert rules, canary), and an AWS apply that revises
the collector task definition (SSM secrets) and restarts the collector, which must happen outside a
load window.

---

## Task 1 — generator: 5xx is a miss, dropped iterations gate, p99 reported not gated, explicit routing

Files: `scripts/generate-slo.js`, `test/generate-slo.test.js`, `slo.yaml` (comment only), and the
regenerated `k6/lib/slo.js`, `grafana/alerts.tf`, `grafana/locals.tf`, `grafana/queries.json`.

- [ ] `ratioExpr`: numerator selectors add `http_response_status_code!~"5.."`; denominator
      unchanged. (Item 1.)
- [ ] `renderAlerts`: add two rule groups for the `availability` objective, same fast/slow burn
      shape, ratio = non-5xx count over total count. (Item 1 follow-on.)
- [ ] `renderAlerts`: every rule gets `notification_settings { contact_point = var.alert_contact_point,
      group_by = ["alertname", "slo"] }`. (Item 6.)
- [ ] `renderK6`: add `dropped_iterations: ['count==0']`; per-class entries become `p(99)>=0`.
      (Items 4, 5.)
- [ ] `slo.yaml`: record the 5xx decision beside `objective`.
- [ ] Tests updated; `npm test` green; `npm run slo:generate` then `npm run slo:check` green.

## Task 2 — k6: stepped discovery, rate-derived VUs

Files: `k6/discovery.js`, `k6/constant.js`, `k6/stress.js`.

- [ ] `discovery.js`: one `constant-arrival-rate` scenario per 100 rps step, 60 s each, 100 → 2000,
      per-scenario `slo_met{scenario:rps_N}` threshold, cumulative abort kept as a stop only. (Item 3.)
- [ ] `constant.js` / `stress.js`: `preAllocatedVUs` defaults to `min(100, ceil(rate × 0.125))`,
      `PRE_VUS` still overrides. (Item 4.)
- [ ] Every script parses: `k6 inspect` or `k6 run --vus 1 --iterations 1` against the dead default
      URL exits with connection errors, not a script error.

## Task 3 — Grafana module: templated dimensions, dashboard tweaks, canary rule

Files: `grafana/variables.tf`, `grafana/folder.tf`, `grafana/dashboard.json.tftpl`,
`grafana/canary.tf` (new), `terraform/grafana.tf`.

- [ ] Module takes `alb_arn_suffix`, `target_group_arn_suffix`, `alert_contact_point`; root passes
      `aws_lb.main.arn_suffix` and `aws_lb_target_group.app.arn_suffix`. (Items 2, 6.)
- [ ] Dashboard: ALB and target-group dimensions templated; ECS dimensions use `${project}`;
      `refresh` 1m; SLI panel threshold lines at 0.99 / 0.999 with `min`/`max`; DynamoDB latency
      panel gains a `p99` target. (Items 2, 9.)
- [ ] `canary.tf`: `absent_over_time` rule over 10 m, routed to the same contact point. (Item 7.)
- [ ] `terraform fmt -check` and `validate` in both modules.

## Task 4 — collector secrets via SSM

Files: `terraform/collector.tf`.

- [ ] Two `aws_ssm_parameter` SecureStrings; execution-role policy `ssm:GetParameters` on their
      ARNs; container `secrets` replaces the two password `environment` entries. (Item 8.)
- [ ] `terraform fmt -check` and `validate`.

## Task 5 — verification and plan

- [ ] `npm test`, `npm run slo:check`, `fmt -check`, `validate` all green.
- [ ] `terraform plan -var-file=dev.tfvars` against the workspace. Expected: `grafana_dashboard`
      update, six `grafana_rule_group` updates (notification_settings + 5xx selector), two
      `grafana_rule_group` adds (availability), one `grafana_rule_group` add (canary),
      two `aws_ssm_parameter` adds, one `aws_iam_role_policy` add, one `aws_ecs_task_definition`
      replace (collector) with the `aws_ecs_service.collector` update it implies. Anything else is a
      defect in this plan.
- [ ] Record the plan summary in the ledger. **Stop. Apply is the owner's.**

## Task 6 — README and `/loadtest` skill text (blocked)

The README in the main working tree carries an uncommitted 711-line rewrite. Editing the committed
README on this branch would conflict with it, so this task is **deferred to whoever owns that
rewrite**. What has to change, once it lands:

- Phase 2, shape A: "ramps 50 → 2000 and aborts" becomes "runs 100 → 2000 in 100 rps steps of 60 s;
  the knee is the lowest `rps_N` whose `slo_met{scenario:rps_N}` threshold reads breached, and
  `RATE` is the step before it". Delete the `knee_rps = 50 + 1950 × elapsed/900` formula.
- Phase 2, exit code line: "99 = a threshold was breached" becomes "99 = `slo_met`, `slo_met_tail`,
  `http_req_failed` or `dropped_iterations` breached; per-class p99 is reported, not gated".
- Section 3: note that the server-side SLI counts a 5xx as a miss, matching k6.
- Section 6: the rules route to the existing Slack contact point explicitly; add the absent-SLI
  canary and what it means.
- `.claude/skills/loadtest/SKILL.md`: discovery parsing reads per-scenario thresholds, not an
  abort time.

---

## Ledger

| task | status | commit | notes |
|---|---|---|---|
| 1 | done | `5baa019` | 96/96 tests, `slo:check` clean. Availability rule pair added. |
| 2 | done | `2fc4676` | `k6 inspect` parses all three; 20 scenarios, 13 → 100 VUs, last step starts at 19m. |
| 3 | done | `b0383cb` | `fmt` + `validate` clean; the only validate warning is the pre-existing `failure_threshold` deprecation on service discovery. |
| 4 | done | `3563ca8` | `fmt` + `validate` clean. |
| 5 | done, **apply not run** | | Speculative remote plan on 2026-09-02, workspace `ecs-dynamodb-rps-ceiling`: **7 to add, 7 to change, 1 to destroy.** Adds: 2 `aws_ssm_parameter`, `aws_iam_role_policy.execution_collector_secrets`, `aws_ecs_task_definition.collector` (replacement), `grafana_rule_group` availability fast/slow and `sli_absent`. Changes: `aws_ecs_service.collector`, `grafana_dashboard.attribution`, the four latency rule groups, and `grafana_slo.latency_classes` (its generated query gained the 5xx selector; this one was not in the expected list above and is correct). Destroy: the old collector task definition. Nothing else. |
| 6 | done 2026-09-02, in the main working tree, uncommitted | | Edited on top of the owner's README rewrite once tier 1 was merged (`4bd3d52`): section 3 states the 5xx rule, section 6 describes seven rules and the canary, Phase 2 describes stepped discovery and how to read the knee, the exit-code comment names the four gates. `.claude/skills/loadtest/SKILL.md` gained a "Reading a discovery run" section with the `jq` for per-step thresholds and the `dropped_iterations` gate. Commit lands with the README rewrite. |

**Applies, each an approval gate, in this order:**

1. **Grafana only — DONE 2026-09-02**, approved by the owner, `terraform apply -var-file=dev.tfvars
   -target=module.grafana`: 3 added, 6 changed, 0 destroyed. Verified against the live stack through
   the Grafana API immediately after:
   - all 7 project rules carry `receiver = "Slack - Kovalchuk & Co"`, `group_by = [alertname, slo]`;
     every one evaluates `health=ok`, state `inactive` (idle traffic, nothing burning);
   - the 13 rules the Grafana SLO app generates for `grafana_slo.latency_classes` carry no
     `notification_settings` and so still fall through to the root policy, which today also names
     Slack. Expected: this repo does not own those rules;
   - dashboard stored with `refresh = 1m`, ALB dimensions equal to the live suffixes, one `p99`
     target on panel 5, panel 19 with threshold steps 0.99 / 0.999 and range 0.95–1;
   - the new `sli_ratio` over 1h returned 0.9958, the availability miss rate returned 0, and the
     canary's `absent_over_time` returned empty (SLI present). No empty-result query;
   - every ALB panel target (14–17) executed as stored returned data: 180 datapoints over 3h for
     RequestCount, TargetResponseTime and HealthyHostCount; the 4XX/5XX counters returned only the
     minutes CloudWatch published, which is how those metrics behave.
2. **AWS — DONE 2026-09-02**, approved by the owner, `terraform apply -var-file=dev.tfvars`:
   4 added, 1 changed, 1 destroyed (two SSM parameters, the execution-role policy, collector task
   definition revision 4 replacing revision 3, the collector service updated in place). Verified
   immediately after:
   - `describe-task-definition` on revision 4: `environment` holds `OTLP_ENDPOINT`, `OTLP_USERNAME`,
     `PROM_URL`, `PROM_USERNAME`, `ALLOY_CONFIG_CONTENT`; `secrets` holds `OTLP_PASSWORD` and
     `PROM_PASSWORD` by SSM ARN. Both parameters exist as Standard-tier SecureString;
   - collector logs: the old task shut its pipeline down cleanly at 14:49:08Z, the new task is
     polling CloudWatch, and there is no 401/403 from Grafana Cloud. The recurring
     `iam:ListAccountAliases` AccessDenied at level=info is pre-existing exporter noise, present for
     the old task as well, and harmless: the exporter only uses the alias as a label;
   - Grafana: the freshest forwarded `aws_dynamodb_*` sample was 39 s old, from exactly one
     collector `instance`, and the app's OTLP samples were 4 s old. No gap outlasted one scrape.

3. **k6 re-upload — DONE 2026-09-02.** `k6 cloud upload` for `discovery.js`, `constant.js`,
   `stress.js`, no `-e` flags, each reaching `test status: Archived`. The stored archives show the
   new shapes: discovery as 20 scenarios ending with `rps_2000` at `startTime 19m0s`, constant at the
   50 rps fallback with 7 VUs, stress at 150 rps peak with 19 VUs. The fallback rate is expected:
   the scripts read `RATE` from the k6 app's environment-variable settings at run time, so a UI run
   uses the measured knee once it is set there, exactly as README Phase 2 describes.
   **What was and was not verified.** The k6 Cloud API confirms each upload created an archived run
   on the right load test (for discovery: run 8484496, `run_status` 10 = archived, created
   2026-09-02T15:12Z, `test_id` 1330768). The API does not return archive contents, the legacy
   `k6-test.script` field still holds the script the test was created with on 2026-09-01 and is not
   updated by uploads, and the Grafana UI could not be checked from this session: the browser is
   signed in as a user that sees only the Default project as Viewer. So the evidence that the stored
   archive is the new script is the k6 CLI's own upload output, which printed the 20 `rps_N`
   scenarios it was archiving. **Before the first recorded run, open the discovery test in the k6
   app as the project owner and confirm its Script tab shows `rps_100` … `rps_2000`.**

Remaining: set the per-scenario reading of discovery in the `/loadtest` skill and the README (Task 6).
