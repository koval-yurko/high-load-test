# ecs-dynamodb-rps-ceiling Scale-and-Measure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover the request rate at which the service stops meeting its class-based SLO, name
which resource caused it, then release one constraint at a time and re-measure identically — and
tear the environment down when the numbers are recorded.

**Architecture:** Nothing new is built. Capacity is raised from the 25/25 free tier to the 1025/200
the capacity model asks for, load is driven by Grafana Cloud k6 from Frankfurt at the frozen
55/15/25/5 mix, and the ceiling is attributed from OTel histograms plus CloudWatch — never from the
HTTP surface, which no longer carries measurements. Then one thing changes at a time: ECS
autoscaling 1→4, and DynamoDB capacity if the database turns out to bind.

**Tech Stack:** Terraform ~1.14 with HCP Terraform (**remote execution**, `working-directory = "terraform"`),
ECS Fargate, DynamoDB provisioned mode, k6 1.4 via Grafana Cloud, Grafana Cloud for the SLO,
dashboards and burn-rate rules.

**Specs:** `docs/superpowers/specs/2026-08-29-ecs-dynamodb-rps-ceiling-design.md` (§4, §6, §9, §10
still in force), amended by `…/2026-08-30-…-sli-collection-design.md` (reverses **D7**) and
`…/2026-08-31-…-attribution-via-metrics-design.md` (reverses **D10**, and supplies the attribution
table this plan uses).

**Re-homes:** Tasks 18–23 of `docs/superpowers/plans/2026-08-29-ecs-dynamodb-rps-ceiling.md`, which
is now `complete`. **Task numbers are not carried over** — the SDD ledger and commit history
reference the old numbers, so this plan numbers from 1 and keeps its own ledger at
`.superpowers/sdd/2026-09-02-ecs-dynamodb-rps-ceiling-scale-and-measure/`. The map:

| here | was | notes |
|---|---|---|
| Task 1 | 18, steps 1–3 | the capacity raise, split out so the gate is its own task |
| Task 2 | 18, steps 4–8 | the discovery run, knee, attribution, script freeze |
| Task 3 | 19 | baselines B and C |
| Task 4 | 20, steps 1–3 | the autoscaling gate |
| Task 5 | 20, steps 4–6 | re-run B and C, re-attribute, commit |
| Task 6 | 21 | raise capacity if the database now binds |
| Task 7 | 22 | write up the results |
| Task 8 | 23 | tear down and sweep |

**Every amendment banner from the old plan is applied inline here.** Do not go back to the 2026-08-29
document for the steps — it accumulated three layers of "this step no longer works as written", and
Phases 5–7 there are now marked history.

---

## Status — **draft**, 2026-09-02. **BLOCKED — do not start.**

The shakedown that gated this plan is complete, and it **falsified the attribution model Task 2
Step 5 depends on**. Evaluated against a case whose answer was known — DynamoDB rejecting 5,588
reads per minute — the four-row table in §5 of the 2026-08-31 spec named the **service**. Three
independent causes: `throttled_requests` reads `0` at instants during sustained throttling;
`SuccessfulRequestLatency` *falls* rather than climbs when DynamoDB throttles, so the "database" row
cannot match a capacity event at all; and SDK retry backoff inflates both the queueing gap and
event-loop delay, which are the "service" row's evidence.

Running Task 2 now would write a confidently-worded, wrong bound-resource into `results.md` — the
platform-vs-service inversion this project exists to avoid, in the one place nothing checks it.

**Unblocks when** a new spec amends §5 of
`docs/superpowers/specs/2026-08-31-ecs-dynamodb-rps-ceiling-attribution-via-metrics-design.md` at
the decision itself, and this plan's Task 2 Step 5 is updated to match.
`ReadThrottleEvents` / `WriteThrottleEvents` were clean, continuous and correct throughout the
shakedown and are in neither `queries.json` nor the table — that is the obvious starting point, but
it is a design decision, not a find-and-replace.

**One of the two open questions is now settled.** The SLO-at-idle question is resolved by
`docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-slo-scope-design.md`: the SLO is defined
over load-bearing traffic, the continuous 7-day window is informational, and authoritative attainment
is run-scoped. Tasks 3 and 7 are updated accordingly, and **Task 1 gains a Step 0** — k6 traffic
cannot currently be isolated by `traffic_source`, and that must be fixed before the freeze.

**The remaining blocker is the attribution model.** Also from the shakedown:

- **DynamoDB served 2.46× provisioned RCU for six minutes with zero throttling** (61.6 RCU/s against
  25). Task 1's capacity raise still makes sense, but do not assume the database binds where the
  model says it will.
- **The 7-day SLO window was already in breach before any load** (`sli_window` 0.98474 against a
  0.99 objective, at ~4 req/min). Attainment recorded by this plan needs that context or the
  before/after comparison inherits a deficit it did not cause.

Details and query output: `.superpowers/sdd/2026-09-01-ecs-dynamodb-rps-ceiling-observability-shakedown/report.md`.

---

## Global Constraints

1. **`terraform apply` and `terraform destroy` create and delete billable AWS resources.** Each lives
   in its own task and that task **stops for approval** — Tasks 1, 4, 6 and 8. A subagent may write
   and `plan` Terraform freely; it may not `apply` it unprompted.
2. **A load profile is only comparable to itself.** From the freeze in Task 2 onward the three k6
   files do not change. Change infrastructure, never the script — same VUs, same stages, same
   thresholds, same load zone.
3. **Every run starts from a full DynamoDB burst bucket**, after a fixed **6-minute idle**. DynamoDB
   banks unused capacity for ~300 s; a run from a partially drained bucket is not comparable and
   must not be recorded.
4. **No number reaches `results.md` without the k6 output or Grafana query that produced it, from a
   run in the same session.** No remembered figures, no extrapolation.
5. **Terraform does not rebuild the container image.** Any change under `src/` needs an explicit
   build → push → `--force-new-deployment` cycle. This was missing once already and cost a full
   debugging cycle.

---

## Phase 1 — Real capacity and the discovery run

### Task 1: APPROVAL GATE — release the capacity pin and apply

**Files:**
- Modify: `ecs-dynamodb-rps-ceiling/terraform/dev.tfvars`

**This raises billable capacity from 25/25 to 1025/200 and STOPS for approval.** At the fetched
`eu-central-1` rates that is **$0.3212/hour** — about 96¢ for a three-hour session, and **$234/month
if the environment is forgotten**. Everything before this point in the project costs ~$0.055/hour.

- [ ] **Step 0: Make k6 traffic identifiable — this must happen BEFORE the freeze in Task 2**

`traffic_source` cannot currently isolate a k6 run. Measured 2026-09-01: `trafficSource()` in
`src/otel.js` is correct — a forged `k6/v1.4.0` User-Agent produces `traffic_source="k6"` — but **k6
v1.4.0 sends no such User-Agent**, and both shakedown runs landed in `other` at 60.01/s and
115.46/s. Selecting `traffic_source="k6"` returns an **empty population**, which reads exactly like
a healthy silence.

Task 3 and Task 7 both depend on scoping a run's window, and the 2026-09-01 SLO-scope spec makes
run-scoped attainment the *authoritative* number. Set `userAgent` in the k6 `options`, or an explicit
header in `k6/lib/request.js`; verify with a 30-second run that a `k6` series appears, before
touching anything else. **This is the last permitted change to a k6 script** — Task 2 Step 6 freezes
them, and Constraint 2 makes every later edit invalidate every comparison.

- [ ] **Step 1: Release the pin in BOTH places**

Capacity is held at the free tier by two mechanisms, and releasing one silently accomplishes nothing.

```hcl
# 1. delete these two lines from ecs-dynamodb-rps-ceiling/terraform/dev.tfvars
read_capacity  = 25
write_capacity = 25
```

```
# 2. delete the matching HCP WORKSPACE variables, or they win anyway.
#    Workspace vars outrank both dev.tfvars and capacity.auto.tfvars in a remote run.
#    Terraform-category variables named read_capacity and write_capacity,
#    workspace ws-pPiZ7mfesjrzZ8sx
```

Miss the second and the plan returns `No changes` on the table while you wonder why. **Do not edit
`terraform/capacity.auto.tfvars`** — it is generated from the capacity model in `slo.yaml` and
byte-checked by `npm run slo:check`. With the pin gone, its 1025/200 applies on its own.

- [ ] **Step 2: Plan and review**

```bash
terraform -chdir=terraform plan -var-file=dev.tfvars
```

Expected: **the DynamoDB table only**, `read_capacity` 25 → 1025 and `write_capacity` 25 → 200,
**in place**. `PBKDF2_ITERATIONS` is *not* part of this change — it was re-derived to 2662 and
applied on 2026-08-31, so the task definition already carries it.

**If the plan proposes to replace the table, stop.** The seeded data (50 partitions × 20 items) would
be lost, and the feed `Query`'s read-block cost — which the whole capacity model rests on — would
change underneath the comparison.

Two things that trip up a plan run from a fresh shell: a git worktree has no `.terraform/` (it is
git-ignored, so `init` is per-worktree), and HCP credentials come from the root `.env`, which direnv
does not load in a non-interactive shell — `plan` fails with `"organization" must be set` until it is
sourced.

- [ ] **Step 3: STOP — get explicit approval, then `/env up ecs-dynamodb-rps-ceiling`**

---

### Task 2: The discovery run, and what bound it

**Files:** none changed (results are recorded in Task 7).

- [ ] **Step 1: Redeploy, so any `src/` change is actually running**

```bash
CL=$(terraform -chdir=terraform output -raw cluster_name)
SV=$(terraform -chdir=terraform output -raw service_name)
aws ecs update-service --cluster "$CL" --service "$SV" --force-new-deployment >/dev/null
aws ecs wait services-stable --cluster "$CL" --services "$SV"
```

Harmless and fast if `src/` is untouched. Skipping it when `src/` *has* changed means measuring the
old image — see Constraint 5.

- [ ] **Step 2: MANDATORY — idle 6 minutes**

```bash
echo "idling to refill the DynamoDB burst bucket; started $(date -u +%H:%M:%S)"
```

- [ ] **Step 3: Run shape A**

```bash
/loadtest ecs-dynamodb-rps-ceiling discovery
```

- [ ] **Step 4: Compute the knee**

The run aborts when `slo_met` drops below 0.99. Read the elapsed time at abort:

```
knee_rps = START_RATE + (MAX_RATE - START_RATE) × (elapsed_seconds / RAMP_SECONDS)
         = 50 + 1950 × (elapsed / 900)
```

If the run completes without aborting, the ceiling is **above** `MAX_RATE` — raise `MAX_RATE` and
re-run rather than reporting 2000 as the answer.

- [ ] **Step 5: Attribute the ceiling — this is the deliverable**

Use the four-row table in **§5 of
`docs/superpowers/specs/2026-08-31-ecs-dynamodb-rps-ceiling-attribution-via-metrics-design.md`.**
The old plan's table is superseded twice over and must not be used.

All four discriminators come from one Grafana datasource, as the named queries in
`ecs-dynamodb-rps-ceiling/grafana/queries.json` — generated from `slo.yaml`, so they cannot drift
from the dashboard or from `/loadtest`:

| query | what it settles |
|---|---|
| `throttled_requests` | the primary discriminator — measured **inside** DynamoDB, so the Node event loop cannot contaminate it |
| `cloudwatch_srl_by_operation` | DynamoDB's own latency clock, per operation |
| `queueing_ms_by_route` | the **gap** between the service's `db` phase and DynamoDB's clock — this *is* the queueing measurement |
| `cpu_saturation_ratio` | `rate(cpu_sum)` against the 0.25 vCPU allocation |

Read it top-down, `throttled_requests` first. **Throttling presents as latency before it presents as
errors** (spec §10): the SDK retries `ProvisionedThroughputExceededException` with backoff, and those
retries sit *inside* the measured `db` phase — so they inflate `queueing_ms_by_route`, the signal
that otherwise indicates a service-bound ceiling. A latency breach must always be checked against
`throttled_requests` before it is attributed to the service.

Expect the `cpu` phase to run roughly **40% above its idle figure** under load. A 0.25 vCPU container
hits its CPU quota; that is the binding mechanism, not instrumentation drift. `pbkdf2_iterations`
does not move — `scripts/calibrate.js` measures `burn()` in isolation and the real instrumentation
cost is 0.51 µs/request, about one iteration.

- [ ] **Step 6: FREEZE the scripts**

From here the three k6 files do not change. Any later edit invalidates every comparison; if one is
genuinely wrong, that is a separate `test(...)` commit that explicitly voids the prior rows.

```bash
git commit --allow-empty -m "test(ecs-dynamodb-rps-ceiling/k6): freeze load profiles after discovery run"
```

---

### Task 3: Baselines B and C

**Files:** none changed.

**Every run from here records two attainment figures, never one:**

| column | source |
|---|---|
| `k6 attainment` | the run's `slo_met` rate — the **gate**, client-side, includes Frankfurt RTT and ALB queueing |
| `service attainment` | the Grafana SLO query over the run's own window — **the authoritative number**, server-side only |

Expect k6 to be the lower of the two. **If it is higher, one of them is wrong.**

**`service attainment` is computed over the run's own window, and that is deliberate.** Per
`docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-slo-scope-design.md`, the continuously
computed 7-day figure is *informational* — its population between runs is ~4 req/min, whose noise
floor exceeds the objective. Do not copy the 7-day number into `results.md`, and do not treat a red
7-day SLO as a finding about a run.

**Expect the fast class to have less headroom than it looks.** At 60 rps, warm, it met its 50 ms
threshold 99.43% of the time — 0.43 points above the objective at trivial load. If the discovery run
shows that margin shrinking, say so explicitly rather than reporting only the aggregate. Query the service
figure through the datasource proxy — `K6_PROMETHEUS_RW_*` is write-scoped and returns
`invalid scope requested`, which a naive parser reads as "no data":

```bash
PROXY="$GRAFANA_URL/api/datasources/proxy/uid/grafanacloud-prom/api/v1"
curl -s -H "Authorization: Bearer $GRAFANA_AUTH" --data-urlencode "query=<sli_ratio>" "$PROXY/query"
```

k6 traffic labels itself: `traffic_source` is derived from the User-Agent in `src/otel.js`, and k6
sends `k6/x.y.z`. Runs therefore appear as `traffic_source="k6"` while the heartbeat stays
`heartbeat` — the evidence spec §17.1 needs on whether generator traffic belongs in the SLO
population. **The heartbeat keeps running during load tests**; at ~4 req/min against thousands it is
statistically irrelevant but not zero, so exclude it if a run's population must be exactly the
generated load. **Use `traffic_source!="heartbeat"`, not `traffic_source="k6"`** — the positive form
matches nothing until Task 1 Step 0 lands, and an empty population reads as silence rather than as an
error.

- [ ] **Step 1: Idle 6 minutes, then run shape B at the knee**

```bash
/loadtest ecs-dynamodb-rps-ceiling constant
```

with `RATE=<knee>`. Expected: all thresholds satisfied, **k6 exit 0**. If B breaches at the knee, the
knee was read too high — recompute it from the abort time rather than adjusting the threshold.

- [ ] **Step 2: Idle 6 minutes, then run shape C**

```bash
/loadtest ecs-dynamodb-rps-ceiling stress
```

with `RATE=<knee>`. Expected: thresholds breached, **k6 exit 99**. **A stress run that passes is a
failed experiment** — the multiplier is too low; raise `MULTIPLIER` and note that C's definition
changed before any comparison is drawn.

Remember k6's inverted booleans: in `--summary-export` JSON a threshold's boolean is *"was it
breached"*, so `true` = FAILED. And capture the exit code off the `k6` command itself — behind a pipe
you get the pipe's status.

- [ ] **Step 3: Record both rows** via `/loadtest`, with `infra change` =
  `"baseline: 1 task, no autoscaling, 1025/200"`.

---

## Phase 2 — Improve and re-measure

### Task 4: APPROVAL GATE — enable ECS autoscaling 1→4

**Files:**
- Modify: `ecs-dynamodb-rps-ceiling/terraform/dev.tfvars`

**One change only.** **If Task 2 attributed the ceiling to the *database* rather than the service,
autoscaling tasks will change nothing — skip to Task 6**, raise capacity instead, and record why the
order was swapped. That is a result, not a deviation.

This is the first time more than one task serves the SLI. The `instance` label that makes the
comparison meaningful was fixed on 2026-08-31: the AWS resource detector supplies no
`service.instance.id` on Fargate, so every task previously reported `instance="local-1"` (the app is
PID 1 in every container) and four tasks would have collapsed onto one series — silently corrupting
the one comparison this phase exists for. It now reads the task id from
`ECS_CONTAINER_METADATA_URI_V4`, verified with two distinct `instance` values at `desired-count 2`.
Nothing to do; recorded so a reader who hits a strange-looking 4-task ratio knows it was already
found. Series growth is not a concern — roughly 10–20 active series per task against a 10,000
free-tier ceiling.

- [ ] **Step 1: Flip the flag**

```hcl
autoscaling_enabled = true
```

- [ ] **Step 2: Plan and review**

```bash
terraform -chdir=terraform plan -var-file=dev.tfvars
```

Expected: **exactly two resources added** — `aws_appautoscaling_target.ecs[0]` and
`aws_appautoscaling_policy.cpu[0]` — and nothing else changed. If anything else appears, more than
one thing is changing and the comparison would be worthless.

- [ ] **Step 3: STOP — approval, then `/env up ecs-dynamodb-rps-ceiling`**

---

### Task 5: Re-run B and C identically, and re-attribute

**Files:** none changed.

- [ ] **Step 1: Idle 6 minutes, then re-run both shapes byte-identically**

```bash
/loadtest ecs-dynamodb-rps-ceiling constant --compare
/loadtest ecs-dynamodb-rps-ceiling stress   --compare
```

Same `RATE`, same scripts, same load zone. `--compare` refuses if the profile or the script changed —
**that refusal is the guard working, not an error to route around.**

- [ ] **Step 2: Attribute again**

Re-run the Task 2 Step 5 table. Autoscaling should move the service ceiling to roughly 4× its
baseline, and the expected outcome is that the bound resource has moved to the **database** — which
is what Task 6 exists for.

- [ ] **Step 3: Commit, with the numbers in the body**

```bash
git add ecs-dynamodb-rps-ceiling/terraform/dev.tfvars
git commit -m "perf(ecs-dynamodb-rps-ceiling/terraform): enable ecs autoscaling 1->4 on cpu target"
```

The body carries before/after p95, error rate and SLO attainment. Per `CLAUDE.md`,
`git log --grep '^perf'` is the history of what actually moved the needle, so a `perf` commit without
numbers defeats its own purpose.

---

### Task 6: APPROVAL GATE — raise capacity if the database now binds

**Files:**
- Modify: `ecs-dynamodb-rps-ceiling/slo.yaml`
- Regenerate: `ecs-dynamodb-rps-ceiling/terraform/capacity.auto.tfvars`

**Skip this task entirely if Task 5 left the service still bound.** Raising capacity that is not the
constraint spends money and proves nothing.

- [ ] **Step 1: Raise `target_rps` in `slo.yaml`** to the service ceiling measured in Task 5, then
  regenerate:

```bash
/slo ecs-dynamodb-rps-ceiling
```

Capacity comes from the model, never from a hand-edited number. Read the new `$/hour` off
`capacity-model.html` before approving — this is where the cost of the improved SLO becomes a real
figure.

- [ ] **Step 2: Plan, review, STOP for approval, then `/env up ecs-dynamodb-rps-ceiling`**

Confirm the plan is an in-place capacity change, not a table replacement.

- [ ] **Step 3: Idle 6 minutes, then re-run B and C**

```bash
/loadtest ecs-dynamodb-rps-ceiling constant --compare
/loadtest ecs-dynamodb-rps-ceiling stress   --compare
```

- [ ] **Step 4: Commit**

```bash
git add ecs-dynamodb-rps-ceiling/slo.yaml ecs-dynamodb-rps-ceiling/terraform/capacity.auto.tfvars
git commit -m "perf(ecs-dynamodb-rps-ceiling): raise provisioned capacity to release the db ceiling"
```

---

## Phase 3 — Record and tear down

### Task 7: Write up the results

**Files:**
- Modify: `ecs-dynamodb-rps-ceiling/README.md`
- Create/modify: `ecs-dynamodb-rps-ceiling/results.md`
- Modify: `README.md` (repo root)

**Every number in these files must come from a run in this session**, quoted with the k6 output or
Grafana query that produced it — `CLAUDE.md`'s verification rule applied literally. **Every
attainment figure is run-scoped**, over that run's own window; the continuous 7-day SLO is
informational and does not belong in `results.md` (2026-09-01 SLO-scope spec, P2).

The README does **not** need restructuring: it was rewritten on 2026-08-31 around the reader's
question, with generated Grafana deep-links (the old plan's Task 22 Step 1 is superseded). What it
needs is **§7 filled in** — it currently says no load test has been run — and any detection/recovery
latency the shakedown measured left in place in §6.

- [ ] **Step 1: Fill in README §7** — the knee, the bound resource and its evidence, and the two
  before/after pairs, pointing at `results.md` for the rows.

- [ ] **Step 2: Check every results row is complete**

```bash
grep -c '^|' ecs-dynamodb-rps-ceiling/results.md
awk -F'|' 'NR>2 && NF>3 && ($4 ~ /^ *$/ || $6 ~ /^ *$/ || $8 ~ /^ *$/ || $9 ~ /^ *$/) \
  { print "INCOMPLETE ROW:", $0 }' ecs-dynamodb-rps-ceiling/results.md
```

A row with a blank `infra change` or a blank `bound resource` is not a result — fill it or delete it.
The indices were verified against the current header, not counted by eye: `$4` = infra change,
`$6` = bound resource, `$8` = k6 attainment, `$9` = service attainment. The last two are the entire
reason the schema gained a second attainment column, and a row carrying only one of them is exactly
the ambiguity the split exists to remove. Schema lives in `.claude/skills/loadtest/SKILL.md`.

- [ ] **Step 3: Update the repo README project table** — replace the `ecs-dynamodb-rps-ceiling` row's
  status with the headline figure (the knee, at the mix, with the bound resource) and confirm the
  planned projects still read "not built yet".

- [ ] **Step 4: Commit**

```bash
git add ecs-dynamodb-rps-ceiling/README.md ecs-dynamodb-rps-ceiling/results.md README.md
git commit -m "docs(ecs-dynamodb-rps-ceiling): record measured capacity and before/after results"
```

---

### Task 8: APPROVAL GATE — tear down and sweep

**Files:** none changed.

**This deletes data and infrastructure and STOPS for approval.** Do not run it until Task 7 is
committed — the measurements are the deliverable and the environment is not.

- [ ] **Step 1: Confirm the results are committed**

```bash
git status --short
git log --oneline -1
```

- [ ] **Step 2: STOP — approval, then `/env down ecs-dynamodb-rps-ceiling`**

- [ ] **Step 3: Sweep — a clean teardown is not evidence of a clean account**

`/env down` runs the sweep. The tag query is the primary check:

```bash
aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=Project,Values=ecs-dynamodb-rps-ceiling \
  --query 'ResourceTagMappingList[].ResourceARN' --output table
```

Then the survivors AWS often creates untagged — unattached EIPs, log groups, ECR repositories, and
NAT gateways (there should be none by design; one appearing means the design broke somewhere).

**Four things the original sweep list predates, one of which can make `destroy` itself fail:**

- **Cloud Map** — `aws_service_discovery_private_dns_namespace.internal` and
  `..._service.collector`. A namespace **refuses deletion while a service is still registered**,
  surfacing as a `destroy` error rather than a silent survivor. If `destroy` fails here, let it
  finish removing the ECS service and re-run; **do not delete the namespace by hand** while
  Terraform still tracks it.
- **The collector** — ECS service, task definition, security group, IAM role + inline policy, and
  log group `/ecs/ecs-dynamodb-rps-ceiling-collector`.
- **The heartbeat** — Lambda `ecs-dynamodb-rps-ceiling-heartbeat`, its EventBridge **Scheduler**
  schedule (not an EventBridge *rule* — check `aws scheduler list-schedules`; it does not appear
  under `aws events`), two IAM roles, and log group
  `/aws/lambda/ecs-dynamodb-rps-ceiling-heartbeat`. **The schedule keeps firing until deleted**, so
  a half-torn-down environment goes on generating traffic and Lambda invocations.
- **Grafana Cloud is not in the AWS tag sweep at all.** `destroy` removes the folder, dashboard, four
  rule groups and `grafana_slo`, but nothing in `resourcegroupstaggingapi` would tell you if it had
  not:

```bash
curl -s -H "Authorization: Bearer $GRAFANA_AUTH" \
  "$GRAFANA_URL/api/prometheus/grafana/api/v1/rules" | grep -c latency-classes   # expect 0
```

Metrics already shipped to Grafana Cloud are **not** deleted by teardown and age out on the 14-day
free-tier retention. That is fine, and worth knowing before someone hunts for a leak.

- [ ] **Step 4: Report the sweep output**

List anything found, with the reason it costs money. **Do not delete anything the sweep finds without
asking** — a survivor may belong to another project in this account.

- [ ] **Step 5: Set this plan's Status to `complete`**
