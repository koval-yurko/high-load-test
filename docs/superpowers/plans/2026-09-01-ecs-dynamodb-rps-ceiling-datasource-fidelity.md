# ecs-dynamodb-rps-ceiling Datasource Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the one real defect in the forwarded-metrics path — a bare `sum()` over `aws_*` series that double-counts whenever the collector is replaced — stop the dashboard hardcoding a datasource uid, record the ~2-minute skew where it affects a reading, and take the AWS CLI out of the runbook. The dashboard keeps the CloudWatch datasource; the migration to Prometheus was measured and rejected.

**Architecture:** No AWS resource changes and no collector redeploy. `scripts/generate-slo.js` is the single generator behind `grafana/queries.json`, so the `sum()` fix is made in the generator and the artifact is regenerated, never hand-edited. `grafana/dashboard.json.tftpl` gains two template variables it should always have taken. One `terraform apply` against the Grafana provider only.

**Tech Stack:** Node.js 22 (`node:test`), `scripts/generate-slo.js`, Terraform ~1.14 with HCP Terraform remote execution, Grafana Cloud.

**Spec:** `docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-datasource-fidelity-design.md`

**Amends:** nothing. Task 6 adds a corroborating pointer to the *Out of scope* bullet in `docs/superpowers/specs/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection-design.md` section 12, recording that its decision was re-tested and upheld rather than changed.

---

## Status — **complete**, 2026-09-01

> Project renamed to `ecs-dynamodb-rps` on 2026-09-03; paths and names below are pre-rename. See `docs/superpowers/specs/2026-09-02-ecs-dynamodb-rps-restructure-design.md`.

Executed in the worktree `.claude/worktrees/datasource-fidelity`, branch
`worktree-datasource-fidelity`, branched from `5829d18`.

| task | commit |
|---|---|
| 1 — `sum()` fix in the generator | `35ab798` |
| 2 — datasource uids from variables | `d8d1e01` |
| 2 — skew annotations | `3376a5b` |
| spec + plan | `7021800` |
| 3 — apply *(approval gate)* | no commit; one Grafana dashboard resource applied |
| 4 — verify applied dashboard | no commit; evidence below |
| 5 + 6 — README, corroborating pointer | `7426633` |
| 7 — close-out | this commit |

**Task 1 caught a bug in its own first draft.** The initial fix used
`max without (instance)`, which removes the double-count but keeps
`dimension_Operation` — so the two-operation subtrahend for `/reports` added series
with differing label sets, matched nothing, and returned **empty**. Verified against
live Prometheus before it shipped: the old `sum()` and the corrected
`max by (dimension_TableName)` both return 3.579, `max without (instance)` returns
nothing. Empty is the failure mode this project has already been bitten by once, in
the `traffic_source="k6"` selector.

**Task 4 evidence** — dashboard read back from Grafana after the apply, version 6,
updated 2026-09-01T18:33:42Z: the two `TIME SKEW` annotations present;
`cloudwatch_srl_by_operation` using `max by (dimension_TableName, dimension_Operation)`;
the queueing subtrahend using `max by (dimension_TableName)`; zero bare `sum(aws_`
remaining. Task 1 gates: `npm test` 92/92, `npm run slo:check` agrees, all four route
branches of `queueing_ms_by_route` return.

### Task 3 destroyed a resource that was not in its plan

The plan reviewed at the approval gate read `0 to add, 1 to change, 0 to destroy`. The
apply executed `0 to add, 1 to change, **1 to destroy**` and deleted
`module.grafana.grafana_k6_project_limits.this` (`vuh_max_per_month = 50000 -> null`).

Cause: the HCP workspace is shared between the main checkout and this worktree.
`grafana/k6.tf` was an **untracked** file in the main checkout, so it is not on this
branch; it was applied from the main checkout in the interval between this plan and
this apply, and an apply from a configuration that lacks it therefore removes it.

The apply was run as a bare `apply`, so it re-planned against newer state and widened
from the reviewed 0 destroys to 1, silently.

**The obvious remedy does not work here, and saying so is the point of this note.**
`plan -out=tfplan` then `apply tfplan` is the standard answer, and Terraform's own
warning — *"you didn't use the -out option, so Terraform can't guarantee to take exactly
these actions"* — points straight at it. Against **HCP remote execution it fails**:
attempted 2026-09-01, `terraform plan -out=…` returns `Error: Failed to decode JSON
plan: EOF`. Do not write that remedy into a runbook without running it first.

**What actually holds the gate on a shared remote workspace**, in order of preference:

1. **Do not share the workspace.** Two checkouts planning against one HCP workspace is
   the root cause; a worktree doing infrastructure work wants its own workspace, or it
   must not apply at all.
2. **Apply from the HCP UI**, where the run being reviewed is the run that executes —
   there is no re-plan between approval and execution.
3. **Lock the workspace** for the duration of a gated apply, so no other checkout can
   move state underneath it.

The narrow lesson generalises past Terraform: **an approval gate is only real if what
was approved is what executes.** A gate that re-derives its action at execution time is
decoration.

Restoring the limits is possible from this branch **after the rebase onto `master`**,
which brings `k6.tf` and its `k6_*` variables with it — before the rebase it was not,
because the configuration genuinely lacked the resource. Committing `k6.tf` to `master`
is what stops this recurring.

### One deviation from the written verification

Task 5's check was "`grep -c 'aws cloudwatch' README.md` returns 0". It returns **1** —
the sentence instructing the reader *not* to run that command. Naming it makes the
prohibition findable by anyone searching for the old recipe, so the text stands and
this line records why the stated check does not hold literally.

---

## Task 1 — Fix `sum()` over `aws_*` series in the generator

**Files:** `ecs-dynamodb-rps-ceiling/scripts/generate-slo.js`, regenerating `ecs-dynamodb-rps-ceiling/grafana/queries.json`

Every `aws_*` series carries an `instance` label naming the Alloy task that scraped it. The collector
runs `desired_count = 1`, so `sum()` is correct today — but during any collector replacement the old
task's series overlap the new one's and every `sum()` reads double.

- [ ] Step 1: In `queueingExpr` (~line 464), change `sum(${SRL}{…})` to `max without (instance) (${SRL}{…})`. This is the site that would otherwise understate queueing delay by one whole DynamoDB latency.
- [ ] Step 2: In the throttle entries (~line 512), change `sum(aws_dynamodb_read_throttle_events_sum{…})` and the write counterpart to `max without (instance) (…)`.
- [ ] Step 3: Aggregate `cloudwatch_srl_by_operation`, currently a bare selector, the same way — preserving its `dimension_Operation` grouping so panel 5's per-operation breakdown survives: `max without (instance) (…)`.
- [ ] Step 4: `npm run slo:generate`, then confirm `git diff grafana/queries.json` shows only the intended aggregation changes and no reflow of unrelated queries.
- [ ] Step 5: `npm test` (expect the full suite green) and `npm run slo:check` (expect agreement — the generator and the checked-in artifact must not diverge).

**Verification:** `npm run slo:check` exits 0 and `queries.json` contains no bare `sum(aws_`.

---

## Task 2 — Datasource uids from variables, and the skew annotations

**Files:** `ecs-dynamodb-rps-ceiling/grafana/dashboard.json.tftpl`, `ecs-dynamodb-rps-ceiling/grafana/folder.tf`

`dashboard.json.tftpl` embeds `a4139e7c-dc84-47c8-b90b-d710ec0fe3fb` as a literal 33 times while
`cloudwatch_datasource_uid` and `prometheus_datasource_uid` sit declared in `grafana/variables.tf`,
passed in by `terraform/grafana.tf`, and used by `alerts.tf` and `slo.tf`.

- [ ] Step 1: In `folder.tf`, extend the `templatefile` call so the variable map is `queries.json` **merged with** `cloudwatch_datasource_uid` and `prometheus_datasource_uid`.
- [ ] Step 2: Replace every CloudWatch uid literal with `${cloudwatch_datasource_uid}` and every Prometheus uid literal with `${prometheus_datasource_uid}`. Confirm by count: the file must end with zero occurrences of the literal uid.
- [ ] Step 3: Extend the descriptions of *Queueing delay by route* and *DB wall-clock vs DynamoDB's own clock* to record that the DynamoDB side of the subtraction arrives ~2 minutes later than the service side — measured, values preserved exactly — so the two are not aligned in time when read live. State the bound: worst observed error 7.4 ms against a 642–938 ms signal, about 1%.
- [ ] Step 4: `terraform -chdir=terraform fmt -check` and `terraform -chdir=terraform validate`.
- [ ] Step 5: `terraform -chdir=terraform plan -var-file=dev.tfvars`. **Expect exactly one resource change: `module.grafana.grafana_dashboard.attribution` updated in place.** Any diff touching `aws_ecs_task_definition`, the collector service, or any AWS resource means the collector is being redeployed and this plan's central constraint has been violated — stop.

**Verification:** plan shows `1 to change, 0 to add, 0 to destroy`, and the changed resource is the dashboard.

---

## Task 3 — Apply *(APPROVAL GATE)*

**This task stops for human approval.** Grafana provider only — no AWS resource is created, changed
or destroyed and nothing becomes billable — but `CLAUDE.md` requires every `apply` to be its own
gated task, and the guard hook keeps it off the allowlist.

- [ ] Step 1: Present the Task 2 plan output and wait for explicit approval.
- [ ] Step 2: `terraform -chdir=terraform apply -var-file=dev.tfvars`.

---

## Task 4 — Verify the applied dashboard

An empty panel reads exactly like a healthy silence; this project has already been bitten by that
once, in the `traffic_source="k6"` selector.

- [ ] Step 1: Read the live dashboard back through the Grafana API and confirm the applied JSON carries the two resolved datasource uids and no literal.
- [ ] Step 2: Confirm panels 2, 5, 21 and 22 return data over a window containing known traffic.
- [ ] Step 3: Confirm the regenerated queueing query still evaluates — a `max without (instance)` that drops a needed label would return empty.

**Verification:** all four panels non-empty; no panel references a hardcoded uid.

---

## Task 5 — README: Phase 3 stops shelling out to CloudWatch

**Files:** `ecs-dynamodb-rps-ceiling/README.md`

- [ ] Step 1: Replace the three `aws cloudwatch get-metric-statistics` invocations in *Phase 3 — Check state* with links to panel 2 (*DynamoDB throttle events*) and panel 5 (*SuccessfulRequestLatency by operation*), in the link style the rest of the README already uses.
- [ ] Step 2: Keep the surrounding analysis verbatim — the `db_wall_avg_by_route` warning, the per-route operation mapping, and the "throttling shows up as latency before it shows up as errors" note are not CloudWatch mechanics.
- [ ] Step 3: Note the ~2-minute skew where the runbook tells the reader to compare the service's DB timing against DynamoDB's own clock.

**Verification:** no `aws cloudwatch` invocation remains in the README; `grep -c 'aws cloudwatch' README.md` returns 0.

---

## Task 6 — Corroborate the upheld decision at its source

**Files:** `docs/superpowers/specs/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection-design.md`

`CLAUDE.md` requires a forward-pointer when a later document **changes** an earlier decision. This one
upholds it — but the *Out of scope* bullet states its decision without a reason, which is what made it
look re-litigable.

- [ ] Step 1: At that bullet in section 12, add a dated note recording that the decision was re-examined on 2026-09-01 against the 250 rps run and upheld, because the forwarded path understates `ReadThrottleEvents` peaks by ~21% (5588 native vs 4360 forwarded), citing this spec.

**Verification:** the bullet now carries its reason and the evidence address.

---

## Task 7 — Close out

- [ ] Step 1: Set this plan's Status to **complete** with the commit list.
- [ ] Step 2: Set the spec's Status to **complete**.
- [ ] Step 3: Full-branch review for anything restating the rejected migration as if it were happening.
