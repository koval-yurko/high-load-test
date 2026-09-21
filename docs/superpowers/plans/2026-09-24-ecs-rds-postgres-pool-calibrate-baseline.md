# ecs-rds-postgres-pool — Calibration and Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

- **Status:** **in progress** (2026-09-24). Approval covers the plan, not its gates: Tasks 1, 7, 10
  and 12 (`terraform apply`) and Task 17 (`terraform destroy`) each still stop and ask before they
  run.
  - **Done:** Tasks 3, 4, 5, 6 and 13 — every task that needs no AWS — each committed and reviewed.
    Task 1 is done through Step 3 (its plan is exactly the three additions it predicts).
  - **Blocked on the first apply:** Tasks 1 Step 4, 2, 7–10, 12, 14–17. By the user's decision on
    2026-09-24, nothing is deployed until the pre-deploy code work below is finished, so that a
    session with a live instance spends itself on measurement and `dev.tfvars` edits only.
  - **Pre-deploy work added after the plan was written, and now complete:** Task 18 (the calibrator
    could not run in the image as built), Task 19 (the parts of Task 11 that need no measurement) and
    Task 20 (the README as a runbook). They are below, after Task 17.
  - **Every task that does not need AWS is therefore done.** What remains is the apply gate and the
    measurement that follows it, plus the four steps of Task 11 that bake in threshold values only the
    real instance can produce.
- **Plan 3 of 4** (the spec's "Execution shape", §12). This is spec phases 3 and 4: apply, deploy,
  calibrate on the real instance, freeze the class thresholds, regenerate everything derived from
  them, then run the baseline at `pool_size = 5` and record the first rows of `results.md`.
- **Spec:** `docs/superpowers/specs/2026-09-19-ecs-rds-postgres-pool-design.md`
- **Predecessors:** `docs/superpowers/plans/2026-09-20-ecs-rds-postgres-pool-service.md` (plan 1,
  complete, merged as `36735a4`) and
  `docs/superpowers/plans/2026-09-21-ecs-rds-postgres-pool-infrastructure.md` (plan 2, complete,
  merged as `5c52b58`). **Plan 2 left two steps for this plan's opening** — its Task 1 Steps 3–4
  (the `platform/` apply) and its Task 17 (the reviewed `plan` of `infra/main`) — so they are
  Tasks 1 and 2 here. Plan 2's section "Amended during execution and plan-3 handoff" lists nine
  inherited items (a)–(i); every one of them is picked up by a task below, and Task 17 checks that
  off.
- **Decisions recorded on:** <https://claude.ai/artifact/LziP91hH2LVmQTDYoQ2Y7A> (2026-09-24, two
  decisions, no dissenting notes) — D1 and D3 below.

**Goal:** A `db.t4g.micro` environment in which the connection pool of 5 is demonstrably the binding
constraint while the database still has CPU to spare, class thresholds frozen from measurements on
that instance, and a baseline recorded in `results.md` with both attainment columns — the "before"
row every knob in plan 4 is compared against.

**Architecture:** Nothing in the infrastructure changes shape. The heavy route gains a second cost
knob so that hold time and database CPU can be set independently (D1); `scripts/calibrate.js` solves
both knobs from per-route hold times measured inside the VPC (D2); the class thresholds are then
derived from a low-rate probe (D3) and everything generated from them is written for the first time.

**Tech Stack:** Terraform ~> 1.14.0, `hashicorp/aws` ~> 6.0, `grafana/grafana` ~> 3.0, HCP Terraform
remote execution, Grafana Alloy, Grafana Cloud k6 1.4, Node 22, Prisma 7.10 over `pg`, PostgreSQL 16
on `db.t4g.micro`.

**This plan spends money and stops five times.** Four `terraform apply` tasks and one `terraform
destroy` task, each its own task, each stopping for approval.

---

## Global Constraints

Copied from the spec, `CLAUDE.md` and plan 2; every task's requirements implicitly include these.

- **Terraform is the only way infrastructure exists.** No click-ops. Read-only `aws … describe-*`
  and `get-metric-*` calls are allowed and are required below. `aws ecs run-task` and `aws ecs
  update-service` are operational, not infrastructural: they create no lasting resource, and
  `scripts/deploy-service.sh` already uses the latter. They are the only two write-shaped AWS CLI
  calls this plan permits.
- **No project script may run `terraform apply` or `destroy`.** The `permissions.ask` rules match on
  command text, so an apply buried in a script never reaches the approval gate.
- **Every apply and destroy is its own task and stops for approval.** A subagent may write and
  `plan` HCL freely; it may not `apply` it unprompted. The instruction is the gate — `CLAUDE.md`
  records that the stronger hook is not registered and that a `direnv exec . terraform -chdir=…
  apply` may not prompt at all.
- **Every `terraform`, `aws` and `k6` command runs as `direnv exec . <command>`.** direnv fires only
  in interactive shells; the Bash tool, subagents and scripts get nothing, and the failure looks like
  a missing workspace or an auth error. `terraform fmt` is the exception.
- **In this worktree, git is `/usr/bin/git`.** The rtk hook rewrites a bare `git` and the worktree
  guard then refuses it. One git command per Bash call.
- **No measured number without the run that produced it, in the same session.** No SLO, latency,
  throughput or cost figure may be reported, written into a document, or carried between sessions
  without the k6 output, Grafana query or price query that produced it. This plan produces the
  project's first numbers, so this rule is live in almost every task.
- **A load profile is only comparable to itself.** When a knob moves, the infrastructure changes and
  the k6 script does not — same VUs, same stages, same thresholds.
- **`Project = ecs-rds-postgres-pool` on every resource**, via `default_tags`. The teardown sweep
  finds orphans by that tag.
- **Every file forked from `ecs-dynamodb-rps` carries the two-line header** naming the sibling file
  and the fork date (this plan's forks are dated 2026-09-24): `// Forked from <path> on <date>.`
  then `// A bug fixed here does not reach the sibling copy; fix both.` — `#` for HCL.
- **Per-task verification for HCL is `terraform fmt -check`, then `validate`.** For service code it
  is the red-green loop: `npm test` from `ecs-rds-postgres-pool/service`, and a single file is
  `node --test test/<file>.test.js` — a **path**, not a name.

### The numbers this plan is allowed to assume

Exactly three, all of them arithmetic or configuration rather than measurement:

| value | where it comes from |
|---|---|
| mean hold target **20 ms** | the spec's §5 capacity line: a pool of 5 ÷ 0.020 s = 250 rps |
| target database CPU at the knee **0.5 × vCPUs** | the spec's §5 relationship ("the pool binds first *while the database still has CPU headroom*") |
| mix **55/15/25/5** (read/write/feed/report) | `slo.yaml`'s `capacity.mix`, read by the calibrator rather than retyped |

Everything else — hold times, row counts, sleep, thresholds, the knee, `max_connections`, the vCPU
count — is measured by a task below.

---

## Decisions made in this plan

**This section is the thing to read first in review.** D1 and D3 were answered by the user on
<https://claude.ai/artifact/LziP91hH2LVmQTDYoQ2Y7A>; D2, D4 and D5 follow from them.

### D1. The heavy route gets a timed wait beside its scan, because a CPU-only knob cannot satisfy §5

The spec's calibration target (§5) is a *relationship*: at the knee the pool of 5 must be full while
the database still has CPU to spare, "approximately `DBLoadRelativeToNumVCPUs ≈ 0.5`". The knob plan
1 built, `REPORT_SCAN_ROWS`, is pure CPU: an in-memory scan plus `count(DISTINCT feed_id)`.

**That combination is unreachable, and the arithmetic says so before any money is spent.** When the
pool is saturated its 5 connections are held continuously. Write *f* for the fraction of a hold
during which the database is actually working on the statement; the rest is the in-VPC round trip and
the `pg`/Prisma work on a 0.25-vCPU task. Then

```
database load / vCPU at the pool knee  =  pool_size × f ÷ vCPUs  =  5 × f ÷ 2  =  2.5 f
```

so the target needs *f* ≈ 0.2. A scan of a RAM-resident table is CPU-bound end to end, *f* ≈ 1, and
the load lands near 2.5 — the database gives out at roughly 40% of the rate at which the pool would
have. That is precisely the failure §1 of the spec is written to avoid: both saturated, nothing
attributable.

**Decision (user, 2026-09-24): split the heavy hold into CPU work and a timed wait.** The report CTE
gains `pg_sleep(sleep_ms / 1000.0)` as one more member of the same single statement, so it is still
one pool checkout. `REPORT_SCAN_ROWS` then sets the database's CPU cost and `REPORT_SLEEP_MS` sets
the rest of the hold, and *f* becomes something the calibrator solves for instead of a property of
the workload. Plan 1 rejected **pure** `pg_sleep` because a sleeping connection burns no CPU and
leaves the "database has headroom" half of the target unreadable; the mix keeps a real, calibrated
CPU share, so `DBLoadCPU` still says something.

**Two consequences, both of which must be written down rather than discovered:**

1. **The metric named in the target changes from `DBLoadRelativeToNumVCPUs` to `DBLoadCPU ÷
   vCPUs`.** A session inside `pg_sleep` is `state = 'active'` in `pg_stat_activity` with wait event
   `Timeout: PgSleep`, so Performance Insights counts it in average active sessions.
   `DBLoadRelativeToNumVCPUs` will therefore read around 2.5 at the knee **by construction**, and
   that is not a failure — it is the sleep being counted. The question §5 actually asks, "does the
   database have room to do more work", is answered by `DBLoadCPU` against the instance's vCPU
   count. Task 16 writes this into the spec at §5 and at the §4.4 metric table.
2. **The sleep stands in for lock and I/O wait, and the README says so.** An I/O-bound workload on
   this instance would produce exactly the same shape — `DBLoadNonCPU` high, `DBLoadCPU` low — which
   is why this is a legitimate stand-in rather than a trick. It is also deterministic, which a
   working set deliberately spilled out of `shared_buffers` would not be (gp3 burst credit makes
   that vary run to run).

The alternatives the user was shown and did not take: measure first and stop if the arithmetic holds
(honest, but spends a session confirming it), and start the baseline at `pool_size = 1`, where the
target holds by construction at any *f* (no service change, but a pool of one serialises everything
and the baseline stops being about a small pool).

### D2. Calibration targets the **mean** hold across the mix, not the heavy statement's own

`scripts/calibrate.js` as plan 1 wrote it searches for the row count at which *the heavy statement
alone* takes `TARGET_HOLD_MS` (default 20). The spec's 250 rps comes from `pool ÷ mean hold`, and a
report is 1 request in 20. A 20 ms heavy statement leaves the mean hold at a few milliseconds and
puts the pool's knee above 1,000 rps — beyond both the 100-VU subscription cap and a 0.25-vCPU task.

**This is a plain arithmetic error in plan 1's handoff, not a design choice, and Task 4 fixes it.**
The calibrator measures all four routes, then solves the two knobs from the mix. Both target lines
reduce to one fraction that does not depend on the knee:

```
mean_db_cpu ÷ mean_hold  =  target_cpu_relative × vcpus ÷ pool_size     ( = 0.5 × 2 ÷ 5 = 0.2 )
```

### D3. Class thresholds are 3 × the unloaded server-side p99, rounded up

The k6 profiles import `infra/k6/tests/lib/slo.js`, which is generated from the thresholds, so no
committed profile can run until they exist — and the thresholds are what the VU sizing derives from.
The circle is broken with a throwaway probe: a 10 rps, 5-minute k6 script written in the scratchpad,
never committed, carrying no thresholds at all. Its purpose is to put traffic through all three
classes; the numbers are then read **server-side** from Grafana, because the SLI is server-side.

**Decision (user, 2026-09-24): `threshold_ms = 3 × p99(class)` at that low rate**, rounded up to the
next 5 ms below 50 ms, 10 ms below 200 ms, and 50 ms above. Three times leaves enough room that
jitter and the heartbeat never breach at low load, while pool queueing — which grows steeply as the
pool saturates — still crosses it close to the knee. The rule is written into `slo.yaml` beside the
numbers, with the probe's date, so the next reader knows what the numbers are and are not.

`pool_connection_timeout_ms` follows from the heavy threshold: **heavy + 100 ms**, replacing today's
unmeasured 900 (plan 2, ruling R17). The spec (§4.3) wants a saturated pool to fail *just above* the
heavy class so overload lands on the availability budget as 5xx rather than growing as unbounded
latency.

### D4. Seeding and calibration run inside the VPC, as one-off Fargate tasks

Hold time measured from a laptop over the public endpoint (the database is internet-reachable since
plan 2's ruling R19) would carry internet round-trip time inside every sample — tens of milliseconds
against a 20 ms target. So both run where the service runs: `aws ecs run-task` with the service's own
task definition and a container command override, wrapped in `scripts/run-oneoff.sh` (Task 5).

This also removes a second apply. `seed_on_boot` stays `false` in `dev.tfvars` permanently: the seed
is a one-off task, not a boot flag, so nothing has to be flipped on and then off again.

### D5. The `posts` table is not reset; its size is recorded

Ruling R20 from plan 2, kept here because two files still say the opposite: `slo.yaml`'s capacity
block ("RE-SEED BEFORE EVERY MEASURED RUN") and the comment block in `scripts/calibrate.js`. 20% of
the mix inserts and the heartbeat inserts every minute, so the table grows; every `results.md` row
records `SELECT count(*) FROM posts` taken immediately before the run instead. Task 4 and Task 11
correct the two stale comments.

---

## File Structure

```
ecs-rds-postgres-pool/
  service/
    src/config.js          MODIFY  reportSleepMs from REPORT_SLEEP_MS (Task 3)
    src/db.js              MODIFY  the report CTE gains pg_sleep (Task 3)
    src/handlers.js        MODIFY  passes sleepMs (Task 3)
    scripts/calibrate.js   REWRITE the mean-hold solver (Task 4)
    test/db.test.js        MODIFY  (Task 3)
    test/config.test.js    MODIFY  (Task 3)
    test/handlers.test.js  MODIFY  (Task 3)
    test/calibrate.test.js MODIFY  (Task 4)
  scripts/
    run-oneoff.sh          NEW     one-off Fargate task: seed, calibrate (Task 5)
  infra/main/
    variables.tf           MODIFY  report_sleep_ms (Task 6)
    ecs.tf                 MODIFY  REPORT_SLEEP_MS in local.app_environment (Task 6)
    outputs.tf             MODIFY  report_sleep_ms in the knobs output (Task 6)
    dev.tfvars             MODIFY  calibrated knobs (Task 9), pool timeout (Task 11)
  infra/grafana/
    locals.tf              GENERATED (Task 11)
    alerts.tf              GENERATED (Task 11)
    slo.tf                 NEW, hand-written, forked from the sibling (Task 11)
    dashboard.json.tftpl   MODIFY  panel 19 text panel -> the SLI query (Task 11)
  infra/k6/tests/
    lib/slo.js             GENERATED (Task 11)
    discovery.js constant.js stress.js   MODIFY  VU sizing from the thresholds (Task 11)
    lib/mix.js             MODIFY  feed ids stop aliasing (Task 11)
  slo.yaml                 MODIFY  thresholds (Task 11), target_rps (Task 14), D5 text (Task 4)
  results.md               NEW     the run ledger (Tasks 14, 15)
  README.md                MODIFY  "Is it about to break?", measured results (Tasks 11, 16)

platform/                  APPLIED, not modified (Task 1)
.claude/skills/loadtest/SKILL.md   MODIFY  this project's result columns (Task 13)
docs/superpowers/specs/2026-09-19-ecs-rds-postgres-pool-design.md   MODIFY (Task 16)
docs/superpowers/plans/2026-09-20-ecs-rds-postgres-pool-service.md  MODIFY (Task 16)
```

**Task order is dictated by what must exist before something can be measured**: the environment
before the deploy, the deploy before the calibration, the calibration before the thresholds, the
thresholds before any committed k6 profile can run at all.

---

## Task 1: The Terraform Cloud workspace (plan 2's deferred apply)
> **Executed 2026-09-24, steps 1-3 only.** The wiring is verified, `DB_PASSWORD` is present (48
> characters), `fmt -check` and `init` are clean, and the plan is exactly the three additions this
> task predicts. **Step 4, the apply, is still open and is the human's gate.** Note for the next
> reader: this worktree needed `direnv allow` before any credentialed command worked.
**Files:** none. `platform/tfc.tf` is already committed (plan 2, ruling R2); only the apply is owed.

**Interfaces:**
- Consumes: nothing.
- Produces: the TFC workspace `ecs-rds-postgres-pool` (execution mode `remote`, working directory
  `infra/main`) and the sensitive `db_password` variable in the shared variable set. Task 2's `init`
  cannot run without it.

- [x] **Step 1: Confirm the tree is what plan 2 left**

```bash
cd /Users/koval/dev/test/high-load-test/.claude/worktrees/ecs-rds-postgres-pool-calibrate-baseline
/usr/bin/git log --oneline -1
grep -n 'ecs-rds-postgres-pool' platform/tfc.tf
grep -n 'db_password' platform/variables.tf platform/tfc.tf .envrc .env.example
```

Expected: the branch tip is `5c52b58`; `local.projects` carries
`"ecs-rds-postgres-pool" = { working_directory = "infra/main" }`; `db_password` is declared in
`platform/variables.tf`, forwarded (sensitive) by `local.tf_vars`, exported by `.envrc` as
`TF_VAR_db_password` from `DB_PASSWORD`, and documented in `.env.example`.

- [x] **Step 2: Confirm the password exists in the environment**

```bash
direnv exec . bash -c 'echo "DB_PASSWORD length: ${#DB_PASSWORD}"'
```

Expected: 48 (it was generated with `openssl rand -hex 24`). **Never print the value.** If it is
empty, stop: the root `.env` is missing it, and `platform`'s plan would then send an empty variable
that the root module's 20–128 character validation rejects on the first apply.

- [x] **Step 3: Format and plan**

```bash
terraform -chdir=platform fmt -check
direnv exec . terraform -chdir=platform init
direnv exec . terraform -chdir=platform plan
```

Expected: exactly **three to add** — `tfe_workspace.project["ecs-rds-postgres-pool"]`,
`tfe_workspace_settings.project["ecs-rds-postgres-pool"]` and
`tfe_variable.terraform["db_password"]` (sensitive) — and **nothing else**. A plan touching the
existing workspace, the variable set itself or the project means something drifted: report it, do
not apply through it.

- [ ] **Step 4: ⛔ STOP — apply requires approval**

Do not run this yourself. Report that the plan is ready, paste it, and wait.

```bash
direnv exec . terraform -chdir=platform apply
```

- [ ] **Step 5: Confirm the settings took**

```bash
direnv exec . terraform -chdir=platform state show 'tfe_workspace.project["ecs-rds-postgres-pool"]' | grep -E 'working_directory|auto_apply|terraform_version'
direnv exec . terraform -chdir=platform state show 'tfe_workspace_settings.project["ecs-rds-postgres-pool"]' | grep execution_mode
```

Expected: `working_directory = "infra/main"`, `auto_apply = false`,
`terraform_version = "~> 1.14.0"`, `execution_mode = "remote"`. `working_directory` is the line that
matters: unset, every later remote run fails with "no file exists at ./../grafana/…", because the
upload root would no longer be the project directory.

---

## Task 2: The reviewed plan of `infra/main` (plan 2's Task 17)

**Files:** none created. This task produces a reviewed plan and a set of recorded answers.

**Interfaces:**
- Consumes: the workspace from Task 1.
- Produces: the evidence that the first apply is safe to run, plus the confirmation that the tree
  still formats and validates against the real backend rather than `-backend=false` (plan 2 ruling
  R1 verified everything locally, so a bad `cloud {}` block would surface here for the first time).

- [ ] **Step 1: Format, init against the real workspace, validate**

```bash
cd ecs-rds-postgres-pool
terraform fmt -check -recursive infra/
direnv exec . terraform -chdir=infra/main init
direnv exec . terraform -chdir=infra/main validate
```

If `init` changes `infra/main/.terraform.lock.hcl`, commit it (plan 2 ruling R3: remote runs need
pinned providers). If `fmt -check` complains, run `terraform fmt -recursive infra/`, commit, re-check.

- [ ] **Step 2: Plan**

```bash
direnv exec . terraform -chdir=infra/main plan -var-file=dev.tfvars
```

Expect "undeclared variable" warnings for `grafana_prom_url`, `grafana_prom_username` and
`grafana_prom_password`: the shared variable set still sends them and this root module dropped the
collector's CloudWatch pipeline that declared them. Not a defect — plan 2, inherited item (h).

- [ ] **Step 3: Answer each question with the resource and value you saw**

Do not summarise; answer each one, quoting the plan.

1. **How many resources to add?** Nothing to change or destroy — nothing exists.
2. **No proxy resources appear**, because `proxy_enabled = false`.
3. **The RDS instance** carries `skip_final_snapshot = true`, `backup_retention_period = 0`,
   `delete_automated_backups = true`, `deletion_protection = false`.
4. **The log groups** `/aws/rds/instance/ecs-rds-postgres-pool/postgresql` and `/ecs/…` are in the
   plan, so Terraform owns them and destroy takes them.
5. **No NAT gateway and no EIP** anywhere.
6. **`Project = ecs-rds-postgres-pool`** via `default_tags` — confirm on the VPC, the instance, the
   ALB.
7. **The container environment** (from the `app_environment` output, since `container_definitions`
   prints as `(sensitive value)`) carries every variable in the README's contract table, with
   `POOL_MAX = 5`, `REPORT_SCAN_ROWS = 0`, `SEED_ON_BOOT` empty, and **no**
   `OTEL_SERVICE_INSTANCE_ID`.
8. **`database_target` is `"instance"`.**
9. **No autoscaling target, scaling policy or ELU alarm.**
10. **The k6 project, the Grafana folder, the dashboard, the saturation rule group and the
    SLI-absent rule group appear**; `grafana_slo` and the burn-rate rule groups do **not** (they
    arrive in Task 11).

- [ ] **Step 4: Prove knob 3 is still wired, without applying it**

```bash
direnv exec . terraform -chdir=infra/main plan -var-file=dev.tfvars -var proxy_enabled=true 2>&1 | tail -20
```

Expected: **refused**, with the precondition message about `proxy_borrow_latency_threshold`. That is
the guard working, and it is plan 4's problem, not this plan's. Discard the plan.

- [ ] **Step 5: Report and stop**

Do **not** apply here. Tasks 3–6 write the code the first apply should carry, so the apply is Task 7.

---

## Task 3: The sleep knob in the heavy route
> **Complete 2026-09-24** — commit `0422c79`, task review clean (spec met, quality approved).
**Files:**
- Modify: `ecs-rds-postgres-pool/service/src/config.js`
- Modify: `ecs-rds-postgres-pool/service/src/db.js`
- Modify: `ecs-rds-postgres-pool/service/src/handlers.js`
- Test: `ecs-rds-postgres-pool/service/test/config.test.js`, `test/db.test.js`, `test/handlers.test.js`

**Interfaces:**
- Consumes: plan 1's `createRepo({ prisma, config })`, `loadConfig(env)`, `createHandlers({ repo, config })`.
- Produces: `config.reportSleepMs` (from `REPORT_SLEEP_MS`, default `0`), and
  `repo.report({ scanRows, sleepMs, post })` — **the signature gains `sleepMs`**. Task 4's
  calibrator and Task 6's Terraform variable both depend on these names.

This is decision D1. Service code, so the red-green loop applies.

- [x] **Step 1: Write the failing tests**

In `test/config.test.js`, extend the defaults test with:

```js
assert.equal(c.reportSleepMs, 0, 'an uncalibrated service must not sleep');
```

and add:

```js
test('REPORT_SLEEP_MS is read as milliseconds', () => {
  const c = loadConfig({ DATABASE_URL: 'postgresql://u:p@h:5432/d', REPORT_SLEEP_MS: '320' });
  assert.equal(c.reportSleepMs, 320);
});
```

In `test/db.test.js`, add `reportSleepMs: 0` to the shared `config` object at the top, and add:

```js
test('report sleeps INSIDE the one statement, so the hold is still one checkout', async () => {
  const prisma = fakePrisma();
  await createRepo({ prisma, config }).report({ scanRows: 5000, sleepMs: 320, post: buildPost(1) });
  assert.equal(prisma.calls.length, 1,
    'the wait must be part of the same statement -- a second round trip would be a second checkout');
  const text = String(prisma.calls[0][1]);
  assert.match(text, /pg_sleep/i);
  assert.match(text, /materialized/i,
    'the sleep CTE is MATERIALIZED so it cannot be inlined away from the plan');
  assert.match(text, /count\(distinct/i, 'the CPU half of the knob stays');
});

test('report at sleepMs 0 keeps the same statement shape', async () => {
  const prisma = fakePrisma();
  await createRepo({ prisma, config }).report({ scanRows: 0, sleepMs: 0, post: buildPost(1) });
  assert.equal(prisma.calls.length, 1);
  const text = String(prisma.calls[0][1]);
  assert.match(text, /pg_sleep/i,
    'pg_sleep(0) returns immediately; removing it at 0 would make the baseline a different statement');
  assert.match(text, /insert\s+into\s+posts/i);
});
```

In `test/handlers.test.js`, add — matching the fake-repo style already in that file:

```js
test('the report handler passes both knob positions from config', async () => {
  const seen = [];
  const repo = { report: async (a) => { seen.push(a); return { n: 0, bytes: 0, feeds: 0, recordId: 1 }; } };
  const handlers = createHandlers({ repo, config: { reportScanRows: 4000, reportSleepMs: 320, seedFeeds: 16 } });
  await handlers.report({ body: { feedId: 2 }, timer: fakeTimer() });
  assert.equal(seen[0].scanRows, 4000);
  assert.equal(seen[0].sleepMs, 320,
    'the sleep is what makes DBLoadCPU readable at the pool knee (plan 3, D1)');
});
```

If `test/handlers.test.js` has no `fakeTimer` helper, use the timer stub the file already builds for
its other cases — read the top of the file and reuse it rather than introducing a second shape.

- [x] **Step 2: Run them and watch them fail**

```bash
cd ecs-rds-postgres-pool/service
npm test -- test/config.test.js
node --test test/db.test.js test/handlers.test.js
```

Expected: FAIL — `reportSleepMs` is undefined and the SQL has no `pg_sleep`. (`npm test` takes a
**path**, never a name; `npm test -- <pattern>` fails with `Could not find '<pattern>'`.)

- [x] **Step 3: Implement — `config.js`**

Add next to `reportScanRows`:

```js
    // The second half of the calibrated knob (plan 3, decision D1). The scan
    // sets what the DATABASE spends; this sets the rest of the hold, so pool
    // occupancy and database CPU can be aimed at independently. 0 => pg_sleep(0),
    // which returns immediately and leaves the statement's shape unchanged.
    reportSleepMs: num(env, 'REPORT_SLEEP_MS', 0),
```

- [x] **Step 4: Implement — `db.js`**

Replace the `NOT pg_sleep, deliberately` paragraph in `report`'s doc comment with:

```js
     * The hold is deliberately TWO costs in one statement (plan 3, decision D1,
     * amending plan 1's "NOT pg_sleep" note):
     *
     *   scanRows -> what the database SPENDS ON CPU
     *   sleepMs  -> the rest of the hold, waiting rather than working
     *
     * Plan 1 was right that a pure pg_sleep workload is useless here: it leaves
     * DBLoadCPU near zero, so "the pool binds while the database still has
     * headroom" becomes unreadable. But a pure scan is CPU-bound end to end, and
     * five such connections against 2 vCPUs put the database at ~2.5x its CPU
     * before the pool of 5 ever binds -- the two saturating together, which is
     * the one outcome the spec exists to avoid. Splitting the cost makes the
     * ratio a knob: scripts/calibrate.js solves for both.
     *
     * The wait is part of the SAME statement, so it is still one checkout. It
     * stands in for lock or I/O wait, which is what a database-bound workload on
     * a bigger table would show anyway -- and it is deterministic, which a
     * working set spilled out of shared_buffers onto gp3 would not be.
     *
     * NOTE: a session in pg_sleep is `active` in pg_stat_activity with wait
     * event Timeout:PgSleep, so Performance Insights counts it. At the knee
     * DBLoadRelativeToNumVCPUs reads ~2.5 BY CONSTRUCTION; the metric that
     * answers the spec's question is DBLoadCPU against the instance's vCPUs.
```

and the statement itself:

```js
    async report({ scanRows, sleepMs = 0, post }) {
      const [row] = await prisma.$queryRaw`
        WITH scanned AS (
          SELECT feed_id, score, body FROM posts ORDER BY id LIMIT ${scanRows}
        ),
        agg AS (
          SELECT count(*)::int                       AS n,
                 coalesce(sum(length(body)), 0)::int AS bytes,
                 count(DISTINCT feed_id)::int        AS feeds,
                 coalesce(avg(score), 0)::float      AS avg_score
            FROM scanned
        ),
        waited AS MATERIALIZED (
          SELECT pg_sleep(${sleepMs}::float8 / 1000.0) AS slept
        ),
        ins AS (
          INSERT INTO posts (feed_id, author, body, score)
          SELECT ${post.feedId}::int, ${post.author}::varchar, ${post.body}::varchar, 0 FROM agg
          RETURNING id
        )
        SELECT a.n, a.bytes, a.feeds, a.avg_score, i.id AS record_id
          FROM agg a, ins i, waited w`;
```

`MATERIALIZED` is not decoration: an inlined CTE whose only column is dropped could be optimised out
of the plan, and the hold would silently lose its wait.

- [x] **Step 5: Implement — `handlers.js`**

```js
      const out = await timer.measure('db', () => repo.report({
        scanRows: config.reportScanRows,
        sleepMs: config.reportSleepMs,
        post,
      }));
```

- [x] **Step 6: Green, then commit**

```bash
cd ecs-rds-postgres-pool/service && npm test
```

Expected: the whole suite green.

```bash
/usr/bin/git add ecs-rds-postgres-pool/service
/usr/bin/git commit -m "feat(ecs-rds-postgres-pool/service): add the heavy route's sleep knob"
```

---

## Task 4: The calibrator solves both knobs from the mix
> **Complete 2026-09-24** — commit `1a66d85`, task review clean; the reviewer re-derived the
> solver's arithmetic independently. Deferred minor: this file's top-of-file header still describes
> the old single-knob search.
**Files:**
- Modify: `ecs-rds-postgres-pool/service/scripts/calibrate.js`
- Test: `ecs-rds-postgres-pool/service/test/calibrate.test.js`
- Modify: `ecs-rds-postgres-pool/slo.yaml` (the stale re-seed comment — D5)

**Interfaces:**
- Consumes: `searchScanRows` (kept as it is), `loadSlo` from `scripts/generate-slo.js`,
  `repo.report({ scanRows, sleepMs, post })` from Task 3.
- Produces: `solveKnobs({ holds, mix, poolSize, vcpus, targetMeanHoldMs, targetCpuRelative })`,
  exported and unit-tested, returning `{ cpuFraction, lightHoldMs, reportCpuMs, reportHoldMs,
  sleepMs, kneeRps, feasible, reason }`. Task 9 runs the CLI half against the real instance.

This is decision D2.

- [x] **Step 1: Write the failing tests**

Add to `test/calibrate.test.js` (keep the four existing `searchScanRows` cases):

```js
import { searchScanRows, solveKnobs } from '../scripts/calibrate.js';

const MIX = { read: 0.55, write: 0.15, feed: 0.25, report: 0.05 };
const SPEC = { mix: MIX, poolSize: 5, vcpus: 2, targetMeanHoldMs: 20, targetCpuRelative: 0.5 };

test('the CPU fraction comes from the pool and the vCPUs, not from the knee', () => {
  const r = solveKnobs({ holds: { read: 1, write: 1, feed: 2, report: 0 }, ...SPEC });
  // 0.5 x 2 / 5: at most a fifth of each hold may be the database working, or
  // the database saturates before the pool does.
  assert.equal(r.cpuFraction, 0.2);
});

test('it solves the two knobs so that mean hold and database CPU both land on target', () => {
  const holds = { read: 1, write: 1, feed: 2, report: 0 };
  const r = solveKnobs({ holds, ...SPEC });
  const lightHold = 0.55 * 1 + 0.15 * 1 + 0.25 * 2;          // 1.2 ms
  assert.equal(r.lightHoldMs, lightHold);
  // mean hold 20 ms  =>  0.05 x reportHold + 1.2  =>  reportHold = 376 ms
  assert.ok(Math.abs(r.reportHoldMs - 376) < 1e-9, `got ${r.reportHoldMs}`);
  // mean db cpu 4 ms =>  0.05 x reportCpu  + 1.2  =>  reportCpu  = 56 ms
  assert.ok(Math.abs(r.reportCpuMs - 56) < 1e-9, `got ${r.reportCpuMs}`);
  assert.ok(Math.abs(r.sleepMs - 320) < 1e-9, `got ${r.sleepMs}`);
  assert.equal(r.feasible, true);
});

test('the knee it predicts is the one the spec derives', () => {
  const r = solveKnobs({ holds: { read: 1, write: 1, feed: 2, report: 0 }, ...SPEC });
  assert.equal(r.kneeRps, 250);   // pool 5 / 20 ms
});

test('light routes that already exceed the CPU budget are reported, not squeezed', () => {
  // 5 ms per light route puts mean light CPU at 5 ms against a 4 ms budget:
  // no report cost can fix that, and a negative scan row count is not an answer.
  const r = solveKnobs({ holds: { read: 5, write: 5, feed: 5, report: 0 }, ...SPEC });
  assert.equal(r.feasible, false);
  assert.match(r.reason, /light routes/i);
  assert.ok(r.reportCpuMs < 0, 'the arithmetic is still reported, so the gap is visible');
});

test('a mix missing a share is refused rather than treated as zero', () => {
  assert.throws(() => solveKnobs({ holds: { read: 1, write: 1, feed: 2, report: 0 },
    ...SPEC, mix: { read: 0.55, write: 0.15, feed: 0.25 } }), /report/);
});
```

- [x] **Step 2: Run them and watch them fail**

```bash
cd ecs-rds-postgres-pool/service && node --test test/calibrate.test.js
```

Expected: FAIL — `solveKnobs` is not exported.

- [x] **Step 3: Implement `solveKnobs`**

Insert above `searchScanRows` in `scripts/calibrate.js`:

```js
/**
 * The two knob positions, solved from measured per-route hold times.
 *
 * Little's law fixes the knee: knee = poolSize / meanHold. The database's CPU
 * load at that knee is knee x meanDbCpu, and relative to the instance's vCPUs
 * that is (knee x meanDbCpu) / vcpus. Setting it to targetCpuRelative and
 * substituting the knee cancels it out entirely:
 *
 *     meanDbCpu / meanHold  =  targetCpuRelative x vcpus / poolSize
 *
 * With the spec's 0.5, a db.t4g.micro's 2 vCPUs and a pool of 5 that is 0.2: at
 * most a fifth of each hold may be the database actually working, or the
 * database saturates before the pool does (plan 3, decision D1). Everything
 * below is that one line solved for the heavy route's two costs.
 *
 * The light routes' DB time is not measured separately -- their whole hold is
 * charged to the CPU budget, which is an over-estimate (it includes the round
 * trip and the pg/Prisma work) and therefore errs toward leaving MORE headroom
 * than the target. They are index hits, so the error is small.
 */
export function solveKnobs({ holds, mix, poolSize, vcpus, targetMeanHoldMs, targetCpuRelative }) {
  const share = (kind) => {
    const v = mix?.[kind];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`capacity.mix has no share for "${kind}" -- slo.yaml is the one source for the mix`);
    }
    return v;
  };
  const lightHoldMs = share('read') * holds.read + share('write') * holds.write + share('feed') * holds.feed;
  const reportShare = share('report');
  const cpuFraction = (targetCpuRelative * vcpus) / poolSize;
  const reportCpuMs = (targetMeanHoldMs * cpuFraction - lightHoldMs) / reportShare;
  const reportHoldMs = (targetMeanHoldMs - lightHoldMs) / reportShare;
  const feasible = reportCpuMs > 0 && reportHoldMs > reportCpuMs;
  const reason = reportCpuMs <= 0
    ? `the light routes alone spend ${lightHoldMs.toFixed(2)} ms of the ${(targetMeanHoldMs * cpuFraction).toFixed(2)} ms CPU budget per request`
    : reportHoldMs <= reportCpuMs
      ? 'the CPU cost needed already exceeds the whole hold: the mean hold target is too small for this mix'
      : '';
  return {
    cpuFraction, lightHoldMs, reportCpuMs, reportHoldMs,
    sleepMs: reportHoldMs - reportCpuMs,
    kneeRps: poolSize / (targetMeanHoldMs / 1000),
    feasible, reason,
  };
}
```

- [x] **Step 4: Rewrite the CLI half**

Replace everything under `if (import.meta.url === …)` with the block below. Three things change from
plan 1's version: it measures all four routes rather than only the heavy one, it solves for two knobs
instead of searching against a 20 ms heavy target, and its comment about re-seeding is corrected to
D5.

```js
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig } = await import('../src/config.js');
  const { createPool } = await import('../src/pool.js');
  const { createPrisma, createRepo, buildPost } = await import('../src/db.js');
  const { loadSlo } = await import('./generate-slo.js');

  const config = loadConfig();
  const { pool, warm, close } = createPool({ config, onWait: () => {} });
  const prisma = createPrisma(pool);
  const repo = createRepo({ prisma, config });
  await warm();

  // The mix comes from slo.yaml, never from a literal here: it is the same
  // document the k6 profiles and the Grafana rules are generated from. Its class
  // thresholds are still null at this point -- that is what this run exists to
  // make derivable -- so the threshold guard is switched off for this read only.
  const sloPath = new URL('../../slo.yaml', import.meta.url).pathname;
  const doc = loadSlo(sloPath, undefined, { requireCapacityMix: true, requireThresholds: false });

  // Median of five: one probe on a burstable instance is noise. Each probe of
  // the report route inserts a row, and nothing here resets the table -- the
  // growth is RECORDED instead, on every results.md row (plan 2, ruling R20).
  const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const timed = async (fn, n = 5) => {
    const samples = [];
    for (let i = 0; i < n; i += 1) {
      const t0 = process.hrtime.bigint();
      await fn();
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return median(samples);
  };

  const holds = {
    read: await timed(() => repo.getPost(1)),
    write: await timed(() => repo.createPost(buildPost(1))),
    feed: await timed(() => repo.feedPage(1, config.feedPageSize)),
    report: 0,
  };

  const poolSize = Number(process.env.POOL_MAX ?? config.poolMax);
  const vcpus = Number(process.env.DB_VCPUS ?? 2);
  const targetMeanHoldMs = Number(process.env.TARGET_MEAN_HOLD_MS ?? 20);
  const targetCpuRelative = Number(process.env.TARGET_CPU_RELATIVE ?? 0.5);
  const solved = solveKnobs({ holds, mix: doc.capacity.mix, poolSize, vcpus, targetMeanHoldMs, targetCpuRelative });

  if (!solved.feasible) {
    console.error(`\nUNUSABLE: ${solved.reason}.\n` +
      `Measured holds (ms): ${JSON.stringify(holds)}\n` +
      `The spec's own answer to this is section 13's first risk row: report it and re-examine the ` +
      `instance class or the pool size before running any comparison. Do NOT write a knob into dev.tfvars.`);
    await prisma.$disconnect(); await close(); process.exit(1);
  }

  // The scan is searched with the sleep at ZERO, so what is being measured is
  // the database's CPU cost alone. The sleep is added afterwards, in Terraform.
  const measure = async (rows) =>
    timed(() => repo.report({ scanRows: rows, sleepMs: 0, post: buildPost(1) }));

  // The scan cannot read more rows than the seed created: above SEED_ROWS every
  // probe reads the same whole table and hold time goes flat, so a search that
  // "converged" up there would report a row count that means nothing.
  const hi = config.seedRows;
  const search = await searchScanRows({ measure, targetMs: solved.reportCpuMs, hi, tolerance: solved.reportCpuMs * 0.05 });

  if (search.rows >= hi) {
    console.error(`\nUNUSABLE: the search pinned at ${hi} rows, the whole seeded table, and still ` +
      `reached only ${search.ms.toFixed(2)} ms against a ${solved.reportCpuMs.toFixed(2)} ms target.\n` +
      `Raise SEED_ROWS (watch the working set against shared_buffers) or make the aggregate cost ` +
      `more per row, then re-run. Do NOT write this number into dev.tfvars.`);
    await prisma.$disconnect(); await close(); process.exit(1);
  }

  const sleepMs = Math.round(solved.reportHoldMs - search.ms);
  console.log(JSON.stringify({
    holds, solved, search,
    knobs: { report_scan_rows: search.rows, report_sleep_ms: sleepMs },
    inputs: { poolSize, vcpus, targetMeanHoldMs, targetCpuRelative, mix: doc.capacity.mix },
  }, null, 2));
  console.log(`\nSet in infra/main/dev.tfvars:\n  report_scan_rows = ${search.rows}\n  report_sleep_ms  = ${sleepMs}`);
  console.log(`Predicted knee: ${solved.kneeRps.toFixed(0)} rps at pool ${poolSize}, with DBLoadCPU ~= ${targetCpuRelative} x ${vcpus} vCPUs.`);

  await prisma.$disconnect();
  await close();
}
```

- [x] **Step 5: Correct the stale re-seed instruction in `slo.yaml`**

In the `capacity:` block, replace the "RE-SEED BEFORE EVERY MEASURED RUN" paragraph with:

```yaml
  # THE TABLE IS NOT RESET BETWEEN RUNS; ITS SIZE IS RECORDED INSTEAD.
  #
  # 20% of the mix inserts (`write` 15%, `report` 5%) and the heartbeat inserts
  # every minute, so `posts` grows whether or not a load test is running. A
  # drop-and-re-seed before every run was the earlier instruction; it was dropped
  # on 2026-09-22 (plan docs/superpowers/plans/
  # 2026-09-21-ecs-rds-postgres-pool-infrastructure.md, ruling R20) because the
  # seed is not idempotent and the reset is more machinery than the drift is
  # worth. Every results.md row records `SELECT count(*) FROM posts`, taken just
  # before the run, so a comparison can be read against the table it ran on.
  #
  # scripts/calibrate.js inserts one row per probe for the same reason, and is
  # covered by the same rule.
```

- [x] **Step 6: Green, then commit**

```bash
cd ecs-rds-postgres-pool/service && npm test
```

```bash
/usr/bin/git add ecs-rds-postgres-pool/service ecs-rds-postgres-pool/slo.yaml
/usr/bin/git commit -m "feat(ecs-rds-postgres-pool/service): solve both knobs from the mix"
```

---

## Task 5: The one-off task runner
> **Complete 2026-09-24** — commits `e37d81f` and `8053cc5` after one fix round; the scoped
> re-review found all four findings addressed and no new breakage. See the amendment note below.
**Files:**
- Create: `ecs-rds-postgres-pool/scripts/run-oneoff.sh`

**Interfaces:**
- Consumes: the `cluster_name` and `service_name` outputs; the running service's own task definition
  and network configuration, read with `aws ecs describe-services`.
- Produces: an executable `./scripts/run-oneoff.sh <command…>` that runs one Fargate task with the
  app container's command overridden, waits for it to stop, prints its CloudWatch logs and exits with
  the container's exit code. Tasks 8 and 9 use it for the seed and the calibration.

This is decision D4.

> **Amended during execution (2026-09-24, commit `8053cc5`):** the script below waits with
> `aws ecs wait tasks-stopped`, and that waiter is fixed at 6 s × 100 attempts — **ten minutes**, with
> no CLI flag to raise it. Under `set -e` a longer seed or calibration therefore died with a raw
> waiter error, printed no logs, and left the caller unable to tell a failed task from a slow one. It
> is replaced by a bounded poll of `describe-tasks` for `lastStatus == STOPPED` every 10 s, with
> `WAIT_SECONDS` (default 2700) as the ceiling and a timeout message naming the task ARN. Three
> smaller corrections went with it: the container's own exit code is propagated rather than collapsed
> to `1` (an OOM kill at 137 and a calibration that refused to converge at 1 are not the same event),
> a trailing bare `-e` prints the usage line instead of a raw `shift` error, and the container name is
> held in one variable so a rename fails loudly everywhere instead of silently returning no logs.
> **The committed script is the authority; the listing below is what it was written from.**

- [x] **Step 1: Write the script**

```bash
cat > ecs-rds-postgres-pool/scripts/run-oneoff.sh <<'EOF'
#!/usr/bin/env bash
# One-off Fargate task on this project's cluster, with the app container's
# command overridden. Used for the seed and for calibration.
#
#     ./scripts/run-oneoff.sh node prisma/seed.js
#     ./scripts/run-oneoff.sh -e TARGET_MEAN_HOLD_MS=20 node scripts/calibrate.js
#
# WHY NOT FROM A LAPTOP. The database is reachable from the internet (the
# security group admits 5432 from anywhere, guarded by the password and
# rds.force_ssl -- plan 2, ruling R19), so both of these WOULD run locally. They
# must not: calibration measures connection HOLD TIME against a 20 ms target, and
# a run from outside the VPC carries tens of milliseconds of internet round trip
# inside every sample. In the VPC the round trip is a fraction of a millisecond,
# which is what the service itself pays.
#
# WHY NOT A BOOT FLAG. seed_on_boot would need one apply to turn it on and
# another to turn it off before scaling out (the seed is not idempotent). A
# one-off task is one command and leaves nothing behind.
#
# This creates NO infrastructure: the task exits and is reaped. It is the same
# class of call as the `aws ecs update-service` in deploy-service.sh beside it.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../scripts/lib.sh"

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PROJECT=$(basename "$PROJECT_DIR")
REPO_ROOT=$(cd "$PROJECT_DIR/.." && pwd)

ENV_OVERRIDES=()
while [ $# -gt 0 ]; do
  case "$1" in
    -e) ENV_OVERRIDES+=("${2:-}"); shift 2 ;;
    *)  break ;;
  esac
done
[ $# -gt 0 ] || die "usage: ./scripts/run-oneoff.sh [-e KEY=VALUE]... <command> [args...]"

d() { direnv exec "$REPO_ROOT" "$@"; }

header "one-off task" "$PROJECT" "Runs one Fargate task with an overridden command. No load is generated."

step "Reading the environment"
OUT=$(d terraform -chdir="$PROJECT_DIR/infra/main" output -json 2>/dev/null || true)
CLUSTER=$(printf '%s' "$OUT" | jq -r '.cluster_name.value // empty')
SERVICE=$(printf '%s' "$OUT" | jq -r '.service_name.value // empty')
[ -n "$CLUSTER" ] && [ -n "$SERVICE" ] || blocked "one-off task" \
  "infra/main has no outputs -- the environment is not applied" \
  "/env up $PROJECT" \
  "./scripts/run-oneoff.sh $*"
ok "cluster $CLUSTER, service $SERVICE"

# The task definition and the network configuration are taken from the RUNNING
# SERVICE rather than from Terraform outputs: that way this task lands on the
# same subnets, the same security group and the same revision the service is
# actually running, and no new output has to be maintained for it.
step "Copying the service's task definition and network configuration"
SVC=$(d aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
        --query 'services[0].{taskDefinition:taskDefinition,net:networkConfiguration}' --output json)
TASKDEF=$(printf '%s' "$SVC" | jq -r '.taskDefinition')
NETCFG=$(printf '%s' "$SVC" | jq -c '.net')
ok "$TASKDEF"

CMD_JSON=$(printf '%s\n' "$@" | jq -R . | jq -sc .)
ENV_JSON=$(printf '%s\n' "${ENV_OVERRIDES[@]:-}" | jq -R 'select(length > 0) | split("=") | {name: .[0], value: (.[1:] | join("="))}' | jq -sc .)
OVERRIDES=$(jq -nc --argjson cmd "$CMD_JSON" --argjson env "$ENV_JSON" \
  '{containerOverrides: [{name: "app", command: $cmd, environment: $env}]}')

step "Starting the task"
TASK_ARN=$(d aws ecs run-task --cluster "$CLUSTER" --task-definition "$TASKDEF" \
  --launch-type FARGATE --network-configuration "$NETCFG" --overrides "$OVERRIDES" \
  --started-by "run-oneoff" --query 'tasks[0].taskArn' --output text)
[ -n "$TASK_ARN" ] && [ "$TASK_ARN" != "None" ] || die "run-task returned no task ARN"
TASK_ID="${TASK_ARN##*/}"
ok "task $TASK_ID"

info "waiting for it to stop (the seed takes minutes; calibration longer)"
d aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"

# The log stream is awslogs-stream-prefix/container/task-id, and the prefix is
# whatever ecs.tf set -- read it rather than assuming, so a changed prefix fails
# here instead of printing nothing and looking like a silent task.
PREFIX=$(d aws ecs describe-task-definition --task-definition "$TASKDEF" \
  --query "taskDefinition.containerDefinitions[?name=='app']|[0].logConfiguration.options.\"awslogs-stream-prefix\"" --output text)
GROUP=$(d aws ecs describe-task-definition --task-definition "$TASKDEF" \
  --query "taskDefinition.containerDefinitions[?name=='app']|[0].logConfiguration.options.\"awslogs-group\"" --output text)

echo
step "Output"
d aws logs get-log-events --log-group-name "$GROUP" --log-stream-name "$PREFIX/app/$TASK_ID" \
  --start-from-head --query 'events[].message' --output text || warn "no log events (yet)"

EXIT=$(d aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query "tasks[0].containers[?name=='app']|[0].exitCode" --output text)
REASON=$(d aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].stoppedReason' --output text)

echo
if [ "$EXIT" = "0" ]; then
  handoff "one-off task" "task $TASK_ID exited 0" "read the output above" "$REASON"
else
  printf '\n%s└─ task %s exited %s -- %s%s\n\n' "$C_BOLD$C_RED" "$TASK_ID" "$EXIT" "$REASON" "$C_RESET"
  exit 1
fi
EOF
chmod +x ecs-rds-postgres-pool/scripts/run-oneoff.sh
```

- [x] **Step 2: Confirm it contains no apply, and that it parses**

```bash
grep -n "terraform apply\|terraform destroy" ecs-rds-postgres-pool/scripts/run-oneoff.sh || echo "no apply: ok"
bash -n ecs-rds-postgres-pool/scripts/run-oneoff.sh && echo "syntax ok"
```

The grep stays literal (plan 2, ruling R11): weakening it to skip comments would let a commented-out
apply pass. If a comment above needs the words, reword the comment.

- [x] **Step 3: Commit**

```bash
/usr/bin/git add ecs-rds-postgres-pool/scripts/run-oneoff.sh
/usr/bin/git commit -m "feat(ecs-rds-postgres-pool): one-off fargate task runner"
```

---

## Task 6: Wire `report_sleep_ms` through Terraform
> **Complete 2026-09-24** — commit `3e8f73c`, task review clean, no findings.
**Files:**
- Modify: `ecs-rds-postgres-pool/infra/main/variables.tf`, `ecs.tf`, `outputs.tf`, `dev.tfvars`

**Interfaces:**
- Consumes: `REPORT_SLEEP_MS` from Task 3.
- Produces: `var.report_sleep_ms`, its entry in `local.app_environment`, and its appearance in the
  `knobs` output. Task 9 sets its value; Task 10 applies it.

- [x] **Step 1: Declare the variable**

In `variables.tf`, immediately after `report_scan_rows`:

```hcl
variable "report_sleep_ms" {
  description = "THE SECOND HALF OF THE CALIBRATED KNOB: how long the heavy route's single statement waits, in milliseconds, beside the CPU cost report_scan_rows sets. The two are separate because the pool must bind while the database still has CPU headroom, and a purely CPU-bound hold puts 5 connections at ~2.5x this instance's 2 vCPUs before the pool of 5 ever binds (plan 3, decision D1). 0 means uncalibrated: pg_sleep(0) returns immediately."
  type        = number
  default     = 0
}
```

- [x] **Step 2: Put it in the container environment**

In `ecs.tf`'s `local.app_environment`, directly below the `REPORT_SCAN_ROWS` entry:

```hcl
    { name = "REPORT_SLEEP_MS", value = tostring(var.report_sleep_ms) },
```

- [x] **Step 3: Record it as a knob position**

In `outputs.tf`, inside the `knobs` output's map, below `report_scan_rows`:

```hcl
    report_sleep_ms  = var.report_sleep_ms
```

- [x] **Step 4: Leave `dev.tfvars` uncalibrated, and say why**

Below the `report_scan_rows` line:

```hcl
report_sleep_ms  = 0 # THE OTHER HALF OF THE KNOB. Plan 3 sets it; 0 means uncalibrated.
```

- [x] **Step 5: Format, validate, commit**

```bash
cd ecs-rds-postgres-pool
terraform fmt -check -recursive infra/ && direnv exec . terraform -chdir=infra/main validate
```

```bash
/usr/bin/git add ecs-rds-postgres-pool/infra/main
/usr/bin/git commit -m "feat(ecs-rds-postgres-pool/terraform): the heavy route's sleep knob"
```

---

## Task 7: ⛔ First apply — the environment exists

**Files:** none.

**Interfaces:**
- Consumes: Tasks 1, 2 and 6.
- Produces: the VPC, ALB, ECR repository, ECS cluster and service, the collector, the heartbeat, the
  RDS instance, the Grafana folder/dashboard/saturation rules and the k6 project. Everything after
  this task measures something that only exists now.

- [ ] **Step 1: Re-plan, since Task 6 changed the module**

```bash
cd ecs-rds-postgres-pool
direnv exec . terraform -chdir=infra/main plan -var-file=dev.tfvars
```

Confirm `REPORT_SLEEP_MS = 0` appears in the `app_environment` output and that the resource count is
Task 2's count unchanged (the variable adds an environment entry, not a resource).

- [ ] **Step 2: ⛔ STOP — apply requires approval**

Do not run this yourself. Report the plan's totals, paste the summary, and wait.

```bash
direnv exec . terraform -chdir=infra/main apply -var-file=dev.tfvars
```

**Expect 10–15 minutes**, almost all of it the RDS instance. The ECS service will not reach a steady
state on this apply: ECR is empty until Task 8 pushes an image, so tasks fail to pull. That is
expected and is not a reason to re-apply.

- [ ] **Step 3: Record what exists**

```bash
direnv exec . terraform -chdir=infra/main output -json > /tmp/rds-pool-outputs.json
jq -r 'to_entries[] | "\(.key)\t\(.value.value | tostring | .[0:100])"' /tmp/rds-pool-outputs.json
direnv exec . aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=Project,Values=ecs-rds-postgres-pool \
  --query 'length(ResourceTagMappingList)'
```

Expected: `base_url`, `db_endpoint`, `k6_project_id`, `cluster_name`, `service_name`,
`app_environment`, `database_target = "instance"`, `knobs`, `psql`; and a non-zero tagged-resource
count. Record the count — Task 17's sweep compares against it.

- [ ] **Step 4: Confirm the instance is what was ordered**

```bash
direnv exec . aws rds describe-db-instances --db-instance-identifier ecs-rds-postgres-pool \
  --query 'DBInstances[0].{class:DBInstanceClass,pi:PerformanceInsightsEnabled,piRetention:PerformanceInsightsRetentionPeriod,az:MultiAZ,storage:AllocatedStorage,backup:BackupRetentionPeriod}'
```

Expected: `db.t4g.micro`, Performance Insights **enabled** with 7-day retention, single-AZ, 20 GiB,
backup retention 0. **Performance Insights is the one that can take the whole attribution story
down** (spec §3.3): if it is off or the apply refused it, stop and report — the fallback is
`db.t4g.medium`, which changes the connection ceiling and forces §6.2's arithmetic to be redone.

---

## Task 8: Deploy, seed, and the first-deploy checks

**Files:** none created. This task produces measurements and a report.

**Interfaces:**
- Consumes: Task 7's environment, `scripts/deploy-service.sh`, `scripts/run-oneoff.sh`.
- Produces: a running service with a seeded database, and answers to plan 2's inherited items (b),
  (c) and (d), plus the real `max_connections` and vCPU count that Task 9 and Task 11 need.

- [ ] **Step 1: Build, push, deploy**

```bash
cd ecs-rds-postgres-pool
./scripts/deploy-service.sh
```

The script builds `--platform linux/amd64`, pushes, forces a new deployment and waits for stability.
**TLS is the thing most likely to fail here** and it fails first in AWS, because there is no local
Postgres: the image carries the RDS CA bundle and `src/pool.js` verifies the server certificate
against it plus Node's public roots (plan 2, decision D4). A failure looks like a task that starts,
throws on the first query and is replaced. Read `/ecs/ecs-rds-postgres-pool` before changing
anything.

- [ ] **Step 2: Confirm the service answers, and that migrations ran**

```bash
BASE=$(jq -r .base_url.value /tmp/rds-pool-outputs.json)
curl -fsS "$BASE/healthz"; echo
curl -fsS "$BASE/posts/1" -o /dev/null -w '%{http_code}\n'
```

Expected: `{"ok":true}`, then `404` — the table exists (migrations ran at boot) and is empty.

- [ ] **Step 3: Seed, as a one-off task**

```bash
./scripts/run-oneoff.sh node prisma/seed.js
```

Expected: exit 0. The seed writes `seed_rows` (50,000) rows across `seed_feeds` (16) feeds and ends
with `VACUUM ANALYZE` on both tables — without which the first run of a session measures a different
query plan than the second (spec §5).

```bash
curl -fsS "$BASE/posts/1" -o /dev/null -w '%{http_code}\n'
curl -fsS "$BASE/feeds/1/posts" | head -c 200; echo
```

Expected: `200`, and a feed page of rows.

- [ ] **Step 4: Measure what plan 2 could only estimate**

The connection string is built from the outputs rather than from the `psql` output's text, so nothing
has to be sed out of a human-readable line. `PGPASSWORD` is expanded **inside** direnv's environment:
`DB_PASSWORD` does not exist in the calling shell, and with `set -u` in a script that is a hard
failure rather than an empty password.

```bash
cd ecs-rds-postgres-pool
HOST=$(direnv exec . terraform -chdir=infra/main output -raw db_endpoint | cut -d: -f1)
direnv exec . bash -c "PGPASSWORD=\$DB_PASSWORD psql \
  'host=$HOST port=5432 dbname=app user=app sslmode=require' \
  -c 'SHOW max_connections;' \
  -c 'SHOW shared_buffers;' \
  -c 'SELECT count(*) AS posts FROM posts;' \
  -c \"SELECT pg_size_pretty(pg_total_relation_size('posts')) AS posts_size;\""
```

`app` is both the database name and the user, from `variables.tf`'s defaults, and `dev.tfvars`
overrides neither — check the `psql` output against this if that ever changes.

Record all four. **The connection ceiling is the number knob 2 aims at**: plan 2 wrote
`max_connections_alert = 100` against an *estimated* ~112. If the real ceiling differs, re-derive the
alert threshold from it (roughly 90% of the real value) and change `dev.tfvars` in Task 11's commit
rather than leaving the estimate in place. **The table must fit inside `shared_buffers`**, or the
"fast" routes are reading from gp3 and the first run of a session differs from the second by an order
of magnitude.

```bash
direnv exec . aws ec2 describe-instance-types --instance-types t4g.micro \
  --query 'InstanceTypes[0].VCpuInfo.DefaultVCpus'
```

Expected: `2`. This is the `vcpus` input to Task 9's solver, and it is the denominator of the whole
calibration; it is read rather than remembered.

- [ ] **Step 5: Confirm the metrics arrived, with the names the dashboard expects**

The heartbeat hits all four routes once a minute, so there is traffic without a load test. Wait ~6
minutes after the deploy, then in Grafana Explore (Prometheus datasource) run each of:

```promql
db_pool_wait_duration_seconds{job="ecs-rds-postgres-pool"}
db_pool_waiting{job="ecs-rds-postgres-pool"}
db_pool_idle{job="ecs-rds-postgres-pool"}
db_pool_total{job="ecs-rds-postgres-pool"}
http_server_request_duration_seconds{job="ecs-rds-postgres-pool", class=~"fast|standard|heavy"}
sum by (pool_opened) (rate(db_pool_wait_duration_seconds{job="ecs-rds-postgres-pool"}[5m]))
```

Plan 2, inherited item (c): confirm the label really is spelled `pool_opened` and that the three
gauges carry **no** unit suffix. A name that is wrong here is a panel that is empty forever, and an
empty panel and a healthy system look identical — which is why `canary.tf`'s SLI-absent rule exists.
Also confirm the `class` label is present: without it the SLI query matches nothing.

- [ ] **Step 6: Confirm the credit metrics publish at the period the rule reads**

Plan 2, inherited item (d) and ruling R9:

```bash
direnv exec . aws cloudwatch get-metric-statistics --namespace AWS/RDS \
  --metric-name CPUCreditBalance --dimensions Name=DBInstanceIdentifier,Value=ecs-rds-postgres-pool \
  --start-time "$(date -u -v-2H +%Y-%m-%dT%H:%M:%SZ)" --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 300 --statistics Average --query 'length(Datapoints)'
```

Expected: a non-zero count. A zero means the 300 s period is wrong for this instance, and the rule
would be silent rather than healthy. Record the balance: **a run does not start until it is full**,
and a run that depletes it is disqualified and re-run (spec §7.2).

- [ ] **Step 7: Cross-check `vcpu_per_task`**

Plan 2, inherited item (b): `slo.yaml`'s `attribution.vcpu_per_task` must equal `task_cpu / 1024`
from `dev.tfvars`, and dashboard panel 23 hardcodes the same figure.

```bash
grep -n 'vcpu_per_task' slo.yaml
grep -n 'task_cpu' infra/main/dev.tfvars
grep -n '0.25' infra/grafana/dashboard.json.tftpl | head
```

Expected: `0.25`, `256`, and the panel's own use of 0.25. Task 11 adds the automated check.

- [ ] **Step 8: Report**

State, with the command output beside each: the deploy's outcome, the four database figures, the
vCPU count, which metric names resolved, the credit datapoint count and balance, and the
`vcpu_per_task` cross-check.

---

## Task 9: Calibrate on the real instance

**Files:**
- Modify: `ecs-rds-postgres-pool/infra/main/dev.tfvars`

**Interfaces:**
- Consumes: Task 4's calibrator, Task 5's runner, Task 8's vCPU count.
- Produces: `report_scan_rows` and `report_sleep_ms` in `dev.tfvars`, with the run that produced them
  recorded. This is the spec's §5 calibration.

- [ ] **Step 1: Run the calibrator inside the VPC**

```bash
cd ecs-rds-postgres-pool
# slo.yaml is the one source of the mix; it is read HERE, where the dev
# dependencies exist, because the image carries neither the file nor `yaml`.
MIX=$(cd service && node -e "
  import('./scripts/generate-slo.js').then(m => {
    const doc = m.loadSlo('../slo.yaml', undefined, { requireCapacityMix: true, requireThresholds: false });
    process.stdout.write(JSON.stringify(doc.capacity.mix));
  })")
echo "mix: $MIX"
./scripts/run-oneoff.sh -e CAPACITY_MIX="$MIX" -e DB_VCPUS=2 -e TARGET_MEAN_HOLD_MS=20 \
  -e TARGET_CPU_RELATIVE=0.5 node scripts/calibrate.js
```

Substitute the vCPU count Task 8 read if it was not 2. Keep the whole JSON output — it is the
evidence for the two numbers, and no number below may be reported without it.

- [ ] **Step 2: Read the result before writing anything**

The output carries `holds` (per-route medians), `solved` (the arithmetic), `search` (the row count
and the CPU time it reached) and `knobs` (what to set). Three outcomes:

| outcome | what it means | what to do |
|---|---|---|
| `feasible: true`, search converged | the target is reachable on this instance | Step 3 |
| `feasible: false` | the light routes alone spend the CPU budget | **stop**: report it. The spec's §13 first risk row is the answer — re-examine the instance class or the pool size before running any comparison |
| search pinned at `SEED_ROWS` | the knob cannot reach the CPU target on a table this size | **stop**: raise `seed_rows` (watching the working set against `shared_buffers`, Task 8 Step 4) and re-run |

**Do not round a stop into a pass.** A calibration that did not converge makes every later number in
this plan meaningless, which is the one failure mode the spec spends most of its length avoiding.

- [ ] **Step 3: Write the two knobs**

In `infra/main/dev.tfvars`, replacing the uncalibrated lines:

```hcl
report_scan_rows = <search.rows>   # calibrated <date> on db.t4g.micro: <search.ms> ms of database CPU
report_sleep_ms  = <sleepMs>       # the rest of the <solved.reportHoldMs> ms hold, as wait rather than work
```

Both comments carry the date and the instance class, because the numbers are CPU- and
instance-specific: a different class invalidates them, exactly as the sibling's `pbkdf2_iterations`.

- [ ] **Step 4: Commit**

```bash
/usr/bin/git add ecs-rds-postgres-pool/infra/main/dev.tfvars
/usr/bin/git commit -m "perf(ecs-rds-postgres-pool/terraform): calibrated heavy-route knobs

Calibrated <date> against the deployed db.t4g.micro. <paste the holds, the
solved targets and the search result here.>"
```

This is a `perf` commit by the repository's table: its point is the measurement that makes the SLO
loop possible, and its body carries the numbers.

---

## Task 10: ⛔ Apply the calibrated knobs

**Files:** none.

**Interfaces:**
- Consumes: Task 9's `dev.tfvars`.
- Produces: a service whose heavy route costs what the calibration says. Everything measured after
  this point is measured against the calibrated workload.

- [ ] **Step 1: Plan**

```bash
cd ecs-rds-postgres-pool
direnv exec . terraform -chdir=infra/main plan -var-file=dev.tfvars
```

Expected: one task definition revision and the service update that follows it, nothing else. In
particular **no RDS change**: a plan proposing to touch the instance means something else drifted.

- [ ] **Step 2: ⛔ STOP — apply requires approval**

```bash
direnv exec . terraform -chdir=infra/main apply -var-file=dev.tfvars
```

- [ ] **Step 3: Confirm the service is running the new numbers**

```bash
direnv exec . terraform -chdir=infra/main output -json app_environment | jq '{REPORT_SCAN_ROWS, REPORT_SLEEP_MS, POOL_MAX, POOL_CONNECTION_TIMEOUT_MS}'
BASE=$(direnv exec . terraform -chdir=infra/main output -json | jq -r .base_url.value)
time curl -fsS -X POST "$BASE/reports" -H 'content-type: application/json' -d '{"feedId":1}' -o /dev/null
```

Expected: the two knobs at their calibrated values, and the `/reports` call taking roughly the
`reportHoldMs` Task 9 solved for, plus internet round trip. A report that returns in a few
milliseconds means the new task definition is not what is serving.

---

## Task 11: Freeze the thresholds and generate everything derived from them

**Files:**
- Modify: `ecs-rds-postgres-pool/slo.yaml`, `infra/main/dev.tfvars`
- Create (generated): `infra/grafana/locals.tf`, `infra/grafana/alerts.tf`, `infra/k6/tests/lib/slo.js`
- Create (hand-written): `infra/grafana/slo.tf`
- Modify: `infra/grafana/dashboard.json.tftpl`, `infra/k6/tests/{discovery,constant,stress}.js`,
  `infra/k6/tests/lib/mix.js`, `scripts/upload-k6.sh`, `service/scripts/generate-slo.js`,
  `service/test/generate-slo.test.js`, `README.md`

**Interfaces:**
- Consumes: the running, calibrated environment.
- Produces: `slo.yaml` with three real `threshold_ms` values; `local.class_ratio_query`,
  `local.slo_objective`, `local.slo_window`; `grafana_slo.latency_classes`; the burn-rate rule
  groups; `CLASS_THRESHOLD_MS`, `SLO_MET_RATE` and `thresholds` in the k6 library. Tasks 14 and 15
  cannot run a committed profile before this task.

This is decision D3.

> **Split 2026-09-24:** Steps 8–11 need no measurement, so they moved to **Task 19** and are done
> before any apply — the point being that a session with a live instance spends itself on
> measurement, not on editing files. What stays here is what genuinely depends on the running
> instance: the probe, the thresholds, the generation, `slo.tf`, the SLI panel, and the final
> verification.

- [ ] **Step 1: Drive the probe**

Write a throwaway profile in the scratchpad — **not** under `infra/k6/`, because it carries no
thresholds and must never be mistaken for one of the three real shapes:

```bash
cd ecs-rds-postgres-pool/infra/k6
# Written INTO tests/ only because the profile imports ./lib/request.js and
# ./lib/env.js by relative path, and deleted three commands later. It is never
# committed: it carries no thresholds, and a fourth file under tests/ would read
# like a fourth load profile.
cat > tests/probe.js <<'EOF'
// THROWAWAY -- not a load profile. Low-rate traffic through all three classes so
// the class thresholds can be derived from real latency (plan 3, decision D3).
// No thresholds of its own: this is not a measurement of the SLO, it is the
// input to defining one.
import { doRequest } from './lib/request.js';
import { BASE_URL, USER_AGENT } from './lib/env.js';
export const options = {
  userAgent: USER_AGENT,
  scenarios: { probe: { executor: 'constant-arrival-rate', rate: 10, timeUnit: '1s',
    duration: '5m', preAllocatedVUs: 20 } },
};
export default function () { doRequest(BASE_URL); }
EOF
BASE=$(direnv exec . terraform -chdir=../main output -json | jq -r .base_url.value)
direnv exec . k6 run -e BASE_URL="$BASE" tests/probe.js
rm tests/probe.js
/usr/bin/git status --short ecs-rds-postgres-pool/infra/k6/tests/   # must show no probe.js
```

Run it locally (`k6 run`), not in the cloud: 10 rps for 5 minutes is far below any plausible knee, so
this measures unloaded latency rather than capacity, and the numbers that matter are read from the
server side anyway.

- [ ] **Step 2: Read the server-side p99 per class**

k6's own numbers include the round trip from wherever the run started; the SLI does not. In Grafana
Explore, over the probe's own window:

```promql
histogram_quantile(0.99, sum by (class) (rate(
  http_server_request_duration_seconds{job="ecs-rds-postgres-pool", http_route!~"/healthz", class=~"fast|standard|heavy"}[5m])))
```

Record all three values with the query and the window. Also record the same for `db.pool.wait` —
at 10 rps it should be near zero, which is the evidence that these are *unloaded* numbers.

- [ ] **Step 3: Freeze the thresholds**

`threshold_ms = 3 × p99`, rounded **up** to the next 5 ms below 50, 10 ms below 200, 50 ms above.
In `slo.yaml`, replace the null block:

```yaml
    classes:
      # FROZEN <date> from a 10 rps / 5 min probe against the calibrated
      # db.t4g.micro, as 3x the unloaded SERVER-SIDE p99 per class, rounded up
      # (plan 3, decision D3). Server-side because that is what the SLI measures;
      # 3x because it must not be breached by jitter at low load, while pool
      # queueing -- which grows steeply as the pool saturates -- still crosses it
      # near the knee. The measured p99s were fast <x> ms, standard <y> ms,
      # heavy <z> ms.
      fast:     { threshold_ms: <3x>, endpoints: [getPost, createPost] }
      standard: { threshold_ms: <3y>, endpoints: [feed] }
      heavy:    { threshold_ms: <3z>, endpoints: [report] }
```

- [ ] **Step 4: Set the pool's wait limit from the heavy threshold**

In `infra/main/dev.tfvars`, replacing the unmeasured 900 (plan 2, ruling R17):

```hcl
# Just above the heavy class threshold (<heavy> ms + 100), so an over-deep queue
# fails FAST and burns the availability budget as 5xx rather than growing without
# bound and showing only as latency (spec 4.3). Frozen with the thresholds on <date>.
pool_connection_timeout_ms = <heavy + 100>
```

- [ ] **Step 5: Generate, and see what appears**

```bash
cd ecs-rds-postgres-pool/service
npm run slo:generate
npm run slo:check
```

Expected: `wrote infra/grafana/classmap.json` (unchanged or rewritten), `queries.json` **now
including `sli_ratio`**, and the three files that did not exist before — `infra/grafana/locals.tf`,
`infra/grafana/alerts.tf`, `infra/k6/tests/lib/slo.js`. `slo:check` must now exit **0**; it has been
red on purpose since plan 1.

- [ ] **Step 6: Write `slo.tf` by hand**

The generator does not write it. Fork the sibling's:

```bash
cp ../../ecs-dynamodb-rps/infra/grafana/slo.tf ../infra/grafana/slo.tf
```

Add the fork header dated 2026-09-24, then: put this project's thresholds in the `description`,
delete the trailing paragraph about Synthetic Monitoring and the DynamoDB heartbeat and replace it
with one naming this project's chain (heartbeat Lambda → the service's OTLP export → the Alloy
collector → Grafana Cloud). Keep `objectives` reading `local.slo_objective` and `local.slo_window`
from the generated `locals.tf` — typing them by hand is the drift the one-source rule exists to
prevent.

- [ ] **Step 7: Give panel 19 its query back**

`infra/grafana/dashboard.json.tftpl` row 6 holds a text panel reading "The SLI query arrives when
plan 3 freezes the class thresholds". Replace it with the real SLI panel, **keeping `"id": 19`** —
the generated burn-rate rules link to that panel id, and renumbering breaks every alert's link back
to the graph that explains it.

```bash
grep -n '"id": 19' infra/grafana/dashboard.json.tftpl
grep -n '__panelId__\|panelId' infra/grafana/alerts.tf | head
```

Confirm the two agree. The panel's query is `${sli_ratio}` from `queries.json` — a template key, not
inlined PromQL; every `${…}` in the template must be a key `folder.tf` passes to `templatefile()`.

- [ ] **Step 8: Size the VUs from the thresholds, and stop demanding `MEAN_SECONDS`**

All three profiles currently throw without `-e MEAN_SECONDS`. Replace that guard in each of
`discovery.js`, `constant.js` and `stress.js` with:

```js
// Little's law: VUs = rate x mean latency. The mean is the mix-weighted class
// threshold, so the sizing moves with slo.yaml instead of with a constant
// somebody typed: a run that just meets its SLO never starves for VUs, and the
// 100-VU subscription cap (infra/k6/main.tf) is only reached far past the knee.
// -e MEAN_SECONDS still wins, for a deliberate override.
import { CLASS_THRESHOLD_MS } from './lib/slo.js';
const MIX = { fast: 0.70, standard: 0.25, heavy: 0.05 };   // 55% read + 15% write are both fast
const DERIVED_MEAN_SECONDS =
  (MIX.fast * CLASS_THRESHOLD_MS.fast + MIX.standard * CLASS_THRESHOLD_MS.standard
   + MIX.heavy * CLASS_THRESHOLD_MS.heavy) / 1000;
const MEAN_SECONDS = Number(__ENV.MEAN_SECONDS) > 0 ? Number(__ENV.MEAN_SECONDS) : DERIVED_MEAN_SECONDS;
```

`discovery.js` imports `CLASS_THRESHOLD_MS` alongside its existing `thresholds`/`SLO_MET_RATE`
import. This also closes plan 2's inherited item (a): `upload-k6.sh` passes only `BASE_URL` and
`RATE`, and with the guard gone an archive made by that script is runnable again. Confirm it:

```bash
cd ecs-rds-postgres-pool/infra/k6
direnv exec . k6 archive -e BASE_URL=http://example.invalid -e RATE=100 -O /tmp/a.tar tests/constant.js
tar -xOf /tmp/a.tar metadata.json | jq '.options.scenarios.steady | {rate, preAllocatedVUs}'
```

Expected: the rate, and a `preAllocatedVUs` equal to `ceil(100 × DERIVED_MEAN_SECONDS)`, capped at
100.

- [ ] **Step 9: Stop the feed ids aliasing**

Plan 2, inherited item (e): the 20-slot mix cycle taken modulo 16 feeds never lands the feed route on
feeds 4, 8, 12 or 16. In `infra/k6/tests/lib/request.js`, derive the feed id from a counter that
advances **per feed request** rather than from the iteration number:

```js
// The feed id advances once per FEED request, not per iteration: the mix cycle
// is 20 long and there are 16 feeds, so iteration % 16 never selects feeds 4, 8,
// 12 or 16 -- a quarter of the seeded table would never be read, and the ones
// that were would stay hotter in cache than the workload implies.
let feedTurn = 0;
const nextFeed = (feeds) => (feedTurn++ % feeds) + 1;
```

and use `nextFeed(FEEDS)` in the feed and report calls, where `FEEDS` is the `seed_feeds` value the
profile already knows (16). Keep the deterministic property: two runs still issue the same sequence.

- [ ] **Step 10: Automate the `vcpu_per_task` cross-check**

Plan 2, inherited item (b). In `service/scripts/generate-slo.js`, inside `validateSlo`, add a rule
that `attribution.vcpu_per_task` is present and positive, and in `test/generate-slo.test.js` add a
case asserting that the value in `slo.yaml` equals `task_cpu / 1024` read from
`infra/main/dev.tfvars`:

```js
test('vcpu_per_task agrees with the task size Terraform allocates', () => {
  const tfvars = readFileSync(new URL('../../infra/main/dev.tfvars', import.meta.url), 'utf8');
  const taskCpu = Number(/task_cpu\s*=\s*(\d+)/.exec(tfvars)[1]);
  const doc = parse(readFileSync(new URL('../../slo.yaml', import.meta.url), 'utf8'));
  assert.equal(doc.attribution.vcpu_per_task, taskCpu / 1024,
    'the CPU saturation ratio divides by this; a stale value silently rescales the panel');
});
```

- [ ] **Step 11: Write the README's runbook section**

`generate-slo.js` points every alert's `runbook_url` at this README's `#6-is-it-about-to-break`
anchor, and **that heading does not exist** — the link is dead today. Add section **6. Is it about to
break?** (the number must match the anchor) listing the rule groups this project now has: the burn
rules per objective, SLI-absent, and the five saturation rules, each with what it fires on and what
it means. Model it on the sibling's section of the same name, but with this project's rules — do not
copy DynamoDB's throttle rows.

- [ ] **Step 12: Format, validate, test, commit**

```bash
cd ecs-rds-postgres-pool
terraform fmt -check -recursive infra/ && direnv exec . terraform -chdir=infra/main validate
cd service && npm test && npm run slo:check
```

```bash
/usr/bin/git add ecs-rds-postgres-pool
/usr/bin/git commit -m "feat(ecs-rds-postgres-pool/grafana): freeze thresholds, generate the slo"
```

---

## Task 12: ⛔ Apply the SLO, the burn rules and the pool timeout

**Files:** none.

- [ ] **Step 1: Plan**

```bash
cd ecs-rds-postgres-pool
direnv exec . terraform -chdir=infra/main plan -var-file=dev.tfvars
```

Expected: `grafana_slo.latency_classes`, the burn-rate rule groups and the updated dashboard to add
or change; one task definition revision for the new `POOL_CONNECTION_TIMEOUT_MS`; nothing else.

- [ ] **Step 2: ⛔ STOP — apply requires approval**

```bash
direnv exec . terraform -chdir=infra/main apply -var-file=dev.tfvars
```

- [ ] **Step 3: Confirm the SLO exists and the dashboard reads**

Open the Grafana folder `ecs-rds-postgres-pool`: the SLO, the burn rules, the saturation rules and
the SLI-absent rule. On the dashboard, panel 19 must show a ratio near 1 under heartbeat traffic —
**not** "No data". No data here means the SLI query matches nothing, and every number this plan goes
on to record would be unverifiable.

---

## Task 13: `/loadtest` learns this project's columns
> **Complete 2026-09-24, out of plan order** — commit `ebdc3b6`, task review clean. Pulled forward
> because it needs no AWS and the apply gate was open. The reviewer re-derived the `awk` field
> indices against both projects' headers.
**Files:**
- Modify: `.claude/skills/loadtest/SKILL.md`
- Create: `ecs-rds-postgres-pool/results.md` (header only)

**Interfaces:**
- Produces: a results table this project can fill without carrying DynamoDB's empty cells. Spec §10
  item 3 asks for exactly this; plan 2's inherited item (g) is the same thing from the other side.

- [x] **Step 1: Split the table into a shared spine and per-project columns**

In `SKILL.md`'s "Recording" section, keep the spine — `date | profile | infra change | RPS | k6
attainment | service attainment | budget burn x | p95 fast/std/heavy | db ms | cpu ms | EL lag p99 |
$/hr` — and state that the columns between `EL lag p99` and `$/hr` come from the project. Add this
project's:

```markdown
`ecs-rds-postgres-pool`: | pool wait p95 | waiting peak | DBLoadCPU/vCPU | connections | pool size | credit balance | posts rows |
`ecs-dynamodb-rps`:      | throttles | RCU/WCU |
```

- [x] **Step 2: Replace the DynamoDB-only reading instructions for this project**

The skill's "Read the throttle counts from CloudWatch" section reads a `table_name` output that does
not exist here. Add this project's equivalent, from `AWS/RDS` with
`DBInstanceIdentifier=ecs-rds-postgres-pool`: `DatabaseConnections` (Maximum over the run window),
`DBLoadCPU` (Average, divided by the instance's vCPUs), `CPUCreditBalance` (Minimum) and
`CPUSurplusCreditBalance` (Maximum — **above zero disqualifies the run**, spec §7.2 and plan 2's
ruling R8). Keep the sparse-metric warning: a quiet minute produces **no datapoint, not a zero**.

- [x] **Step 3: Re-derive the completeness check's field indices**

The check `awk`s fixed field numbers, and this table's schema just changed. Re-derive them by piping
the new header through `awk -F'|'` and printing the fields — never by counting pipes, because a
leading-pipe Markdown row makes `$1` the empty string before the first column. Update both the
snippet and the sentence naming which field is which.

- [x] **Step 4: Create `results.md` with the header only**

No placeholder rows. Add one line above the table saying what a row means and that `posts rows` is
`SELECT count(*) FROM posts` taken immediately before the run, because the table is not reset (D5).

- [x] **Step 5: Commit**

```bash
/usr/bin/git add .claude/skills/loadtest/SKILL.md ecs-rds-postgres-pool/results.md
/usr/bin/git commit -m "docs(repo): give /loadtest per-project result columns"
```

---

## Task 14: Discovery — the knee, and whether the pool really binds first

**Files:**
- Modify: `ecs-rds-postgres-pool/slo.yaml` (`capacity.target_rps`), `results.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the measured knee, and the answer to the question this whole plan exists for: **at the
  knee, is the pool the constraint while the database still has CPU?**

- [ ] **Step 1: Check the run gate**

Spec §7.2: a run does not start until the credit balance is full, and a run that depletes it is
disqualified and re-run. Record `CPUCreditBalance` before starting, and
`SELECT count(*) FROM posts` — that is the row's `posts rows` column.

- [ ] **Step 2: Upload and run discovery**

```bash
cd ecs-rds-postgres-pool
./scripts/upload-k6.sh                       # discovery only: the knee is not known yet
OUT=$(direnv exec . terraform -chdir=infra/main output -json)
BASE_URL=$(printf '%s' "$OUT" | jq -r .base_url.value)
K6_PROJECT=$(printf '%s' "$OUT" | jq -r .k6_project_id.value)
K6_CLOUD_PROJECT_ID="$K6_PROJECT" direnv exec . k6 cloud run \
  --summary-export=/tmp/k6-rds-discovery.json -e BASE_URL="$BASE_URL" infra/k6/tests/discovery.js
echo "exit: $?"
```

Capture the exit code **on the k6 line itself** — behind a pipe you get the pipe's status. `99` means
a gating threshold was breached, `0` means all passed.

- [ ] **Step 3: Read the knee correctly**

In the summary JSON a threshold's boolean is **"was it breached"**: `true` = crossed = FAILED. The
knee is the **lowest** `rps_N` whose `slo_met{scenario:rps_N}` reads `true`; the rate for
`constant.js` is the step **before** it. If no step breached, the ceiling is above `MAX_RATE` — raise
it and re-run rather than reporting `MAX_RATE` as the answer. Use the `/loadtest` skill's parser
rather than a fresh one.

- [ ] **Step 4: Read the relationship at the knee — this is the deliverable of the calibration**

Over the knee step's own window, record:

| what | where |
|---|---|
| `DBLoadCPU` ÷ vCPUs | CloudWatch `AWS/RDS`, Average over the step |
| `DBLoadRelativeToNumVCPUs` | the same — **expected to be much higher**, because `pg_sleep` counts as an active session (D1) |
| pool wait p99 by class | `pool_wait_p99_by_class` from `queries.json` |
| pool wait split by `pool_opened` | `pool_wait_p99_opened` — a wait that coincides with `pool_total` rising is connection setup, not a queue |
| `db_pool_waiting` peak | the gauge |
| `DatabaseConnections` | CloudWatch, Maximum — must be 5, one task at `pool_size = 5` |

**The pass condition:** pool wait rises sharply at the knee while `DBLoadCPU ÷ vCPUs` sits near 0.5.
Then the pool is the constraint and releasing it in plan 4 will move the bottleneck somewhere
visible.

**If `DBLoadCPU ÷ vCPUs` is at or above 1 at the knee, stop and report.** Do not proceed to the
baseline: the spec's §13 first risk row governs, and the honest options are a longer sleep (raising
the hold without raising CPU) re-derived through Task 9, or a different instance class. Say which
number failed and by how much.

- [ ] **Step 5: Record the knee, and the row**

In `slo.yaml`: `target_rps: <knee>`, with a comment naming the date, the profile and that it is the
discovered knee at `pool_size = 5`. Append the discovery row to `results.md` with every column,
`infra change` = "baseline: pool 5, 1 task, calibrated knobs".

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add ecs-rds-postgres-pool/slo.yaml ecs-rds-postgres-pool/results.md
/usr/bin/git commit -m "test(ecs-rds-postgres-pool/k6): discovery run, knee at <n> rps"
```

---

## Task 15: The baseline — constant and stress at pool 5

**Files:**
- Modify: `ecs-rds-postgres-pool/results.md`

**Interfaces:**
- Consumes: the knee from Task 14.
- Produces: the two rows plan 4 compares every knob against, and the **red-first** evidence the spec
  §9 demands: the k6 threshold encoding the SLO is watched to *fail* against the small pool before
  anything is changed.

- [ ] **Step 1: Re-upload at the measured knee**

```bash
cd ecs-rds-postgres-pool
./scripts/upload-k6.sh --rate <knee>
```

Without `--rate`, `constant` and `stress` are not uploaded at all — an absent test is honest, a test
frozen at the 50 rps placeholder is not.

- [ ] **Step 2: Run `constant` at the knee**

Check the credit balance and the `posts` count first, as in Task 14 Step 1.

```bash
K6_CLOUD_PROJECT_ID="$K6_PROJECT" direnv exec . k6 cloud run \
  --summary-export=/tmp/k6-rds-constant.json -e BASE_URL="$BASE_URL" -e RATE=<knee> \
  infra/k6/tests/constant.js
echo "exit: $?"
```

Expected: exit `0` — at the knee the SLO holds. Confirm `tags.rate_source` is `explicit`: a run
tagged `default` is not a capacity measurement.

- [ ] **Step 3: Run `stress`, and watch the threshold fail**

```bash
K6_CLOUD_PROJECT_ID="$K6_PROJECT" direnv exec . k6 cloud run \
  --summary-export=/tmp/k6-rds-stress.json -e BASE_URL="$BASE_URL" -e RATE=<knee> \
  infra/k6/tests/stress.js
echo "exit: $?"
```

Expected: exit **99**, and `slo_met` breached. **This is the red half of the red-green loop** — with
no local test suite it is the only place the discipline appears, and it is not optional: it is what
proves the assertion can fail before any knob is claimed to have fixed it. Record *which* threshold
broke and *how*: latency (the pool queue) or availability (`connectionTimeoutMillis` firing as 5xx,
which is what the timeout set in Task 11 is for).

- [ ] **Step 4: Read the server-side attainment for both runs**

Two attainment columns, never one number in both. `k6 attainment` is the run's `slo_met` rate;
`service attainment` is the Grafana SLI query over the run's own window — the same PromQL the alert
rules use, restricted to classified traffic. Compute `budget burn x` from the **service** figure:
observed miss rate ÷ sustainable miss rate.

- [ ] **Step 5: Append both rows and commit**

```bash
/usr/bin/git add ecs-rds-postgres-pool/results.md
/usr/bin/git commit -m "test(ecs-rds-postgres-pool/k6): baseline at pool 5, two profiles"
```

---

## Task 16: Write it down — README, spec and plan amendments

**Files:**
- Modify: `ecs-rds-postgres-pool/README.md`
- Modify: `docs/superpowers/specs/2026-09-19-ecs-rds-postgres-pool-design.md`
- Modify: `docs/superpowers/plans/2026-09-20-ecs-rds-postgres-pool-service.md`
- Modify: this plan's `Status:` line

- [ ] **Step 1: The README's measured results**

Replace "No runs yet — plan 3 produces the first numbers." with the baseline table: the two runs,
their columns, and one paragraph saying what the calibration achieved — the hold time, the CPU share
at the knee, and the knee itself. Every figure needs the run it came from. Add the calibrated knob
positions to the knob-sequence table, and the real `max_connections` from Task 8 in place of the
"~112 estimated" note.

- [ ] **Step 2: Amend the spec at the decisions this plan changed**

`CLAUDE.md` requires the forward-pointer **at the decision itself**, not only in a header.

1. **§5, at "approximately `DBLoadRelativeToNumVCPUs ≈ 0.5`"**: append that plan 3 (this file,
   decision D1) replaced the metric with `DBLoadCPU ÷ vCPUs`, because the heavy route now waits as
   well as works and a `pg_sleep` session counts as an active session in Performance Insights — so
   `DBLoadRelativeToNumVCPUs` reads about `pool_size ÷ vCPUs` at the knee by construction.
2. **§5, at "What the knob actually is"**: append that the knob is now two — `REPORT_SCAN_ROWS` for
   the database's CPU cost and `REPORT_SLEEP_MS` for the rest of the hold — and why a CPU-only knob
   could not satisfy the section's own target (the `2.5 f` arithmetic).
3. **§5, at "for a pool of 5 to bind at roughly 250 rps … mean hold time must be about 20 ms"**:
   append that plan 1's calibrator aimed that 20 ms at the heavy statement alone, that a report is
   5% of the mix, and that plan 3's calibrator solves for the mean (decision D2).
4. **§9**, if the mix changed in Task 11 Step 9, note what changed and why.

- [ ] **Step 3: Amend plan 1 at its workload section**

In `2026-09-20-ecs-rds-postgres-pool-service.md`, at the "Where the cost knob lives, and why not
`pg_sleep`" paragraph and at "Calibration in plan 3 turns this one number until mean hold time
reaches roughly the 20 ms the spec derives": append that plan 3 kept the reasoning but added a
**second** knob — a `pg_sleep` inside the same statement — because a CPU-only hold cannot satisfy the
spec's relationship at pool 5 on 2 vCPUs, and name this file.

- [ ] **Step 4: Update this plan's status**

Set `Status:` to `complete`, or to `partially executed (on hold)` **with the task numbers that are
done and what is blocking the rest**. A plan sitting at the wrong status is a lie the next reader
acts on.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add ecs-rds-postgres-pool/README.md docs/superpowers
/usr/bin/git commit -m "docs(ecs-rds-postgres-pool): baseline results and spec amendments"
```

---

## Task 17: ⛔ Tear down, or hand over to plan 4

**Files:** none.

**Interfaces:**
- Produces: either a clean account or a documented decision to keep the environment running.

- [ ] **Step 1: Decide, and say which**

Plan 4 needs this exact environment: the same instance, the same calibration, the same seeded table.
Re-creating it costs an apply, a deploy, a seed and a fresh calibration — and the calibration is
instance-specific, so plan 4 would have to re-run it anyway on a new instance.

- **Plan 4 starts now** → keep it running, and say so in `results.md`. The idle bill is roughly
  $0.076/hr (spec §7.6, an estimate until Task 16's price query replaces it).
- **Otherwise** → destroy. The environment is cheap to recreate and expensive to forget.

- [ ] **Step 2: ⛔ STOP — destroy requires approval**

```bash
/env down ecs-rds-postgres-pool
```

Expect it to be slow: an RDS instance takes 5–15 minutes to delete, and the sibling's teardown
recorded an internet gateway alone taking 3m39s on ENI detachment.

- [ ] **Step 3: Sweep, because a successful destroy is not evidence**

```bash
direnv exec . aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=Project,Values=ecs-rds-postgres-pool \
  --query 'ResourceTagMappingList[].ResourceARN' --output text
```

Expected: empty. The survivors to look for by name, even untagged: the RDS final snapshot
(`skip_final_snapshot = true` should prevent it), automated backups, the
`/aws/rds/instance/ecs-rds-postgres-pool/postgresql` and `/ecs/ecs-rds-postgres-pool` log groups, the
DB subnet and parameter groups, any EIP, and the Grafana Cloud k6 project.

- [ ] **Step 4: Confirm plan 2's inherited list is closed**

Walk items (a)–(i) of plan 2's "What plan 3 inherits" and state where each was answered: (a) Task 11
Step 8, (b) Task 8 Step 7 and Task 11 Step 10, (c) Task 8 Step 5, (d) Task 8 Step 6, (e) Task 11
Step 9, (f) D5 and Task 4 Step 5, (g) Task 13, (h) Task 2 Step 2, (i) **not closed — it belongs to
plan 4's knob 3**, and must be carried into plan 4's own inherited list rather than dropped here.

---

## Task 18: Make the calibrator runnable inside the image
> **Complete 2026-09-24** — commit `f637dc9`, task review clean, no findings. The in-image check
> is the evidence that matters: the module imports inside the runtime-only container and solves
> the knobs from `CAPACITY_MIX`, where before it would have thrown on `yaml`.
**Files:**
- Modify: `ecs-rds-postgres-pool/service/scripts/calibrate.js`
- Modify: `ecs-rds-postgres-pool/service/test/calibrate.test.js`
- Modify: this plan's Task 9 Step 1 command

**Interfaces:**
- Consumes: Task 4's `solveKnobs`.
- Produces: a `calibrate.js` whose CLI half runs in the deployed container. Task 9 depends on it
  entirely, and today Task 9 would fail within a second of starting.

**Why this task exists.** Task 4's CLI reads the mix through
`loadSlo` from `scripts/generate-slo.js`, and that breaks twice over inside the image:

1. **`slo.yaml` is not in the image.** `scripts/deploy-service.sh` builds with `service/` as the
   Docker context (`docker build --platform linux/amd64 -t "$REPO:latest" "service/"`), and
   `slo.yaml` sits one level above it at the project root. Docker cannot copy from outside the
   context, so the file is simply absent.
2. **`yaml` is a devDependency.** The runtime stage installs with `npm ci --omit=dev`, so
   `generate-slo.js`'s `import { parse } from 'yaml'` throws `ERR_MODULE_NOT_FOUND` at import time —
   before any measurement is attempted.

Both were introduced by Task 4 and neither is visible from a unit test, because the tests import the
pure functions and never the CLI half.

**The fix keeps `slo.yaml` as the one source of the mix** and moves the reading to the operator's
machine, where the dev dependencies exist: the mix is passed in as `CAPACITY_MIX`, a JSON object, and
the container parses that instead of a YAML file it does not have.

- [x] **Step 1: Write the failing test**

In `test/calibrate.test.js`:

```js
import { readMix } from '../scripts/calibrate.js';

test('the mix comes from CAPACITY_MIX when the container has no slo.yaml', () => {
  const mix = readMix({ CAPACITY_MIX: '{"read":0.55,"write":0.15,"feed":0.25,"report":0.05}' });
  assert.deepEqual(mix, { read: 0.55, write: 0.15, feed: 0.25, report: 0.05 });
});

test('a malformed CAPACITY_MIX fails loudly rather than silently mis-sizing the experiment', () => {
  assert.throws(() => readMix({ CAPACITY_MIX: 'not json' }), /CAPACITY_MIX/);
});

test('the four shares must all be present, because solveKnobs divides by the report share', () => {
  assert.throws(() => readMix({ CAPACITY_MIX: '{"read":0.55,"write":0.15,"feed":0.25}' }), /report/);
});

test('without CAPACITY_MIX it says where the value comes from', () => {
  assert.throws(() => readMix({}), /slo\.yaml/);
});
```

- [x] **Step 2: Run it and watch it fail**

```bash
cd ecs-rds-postgres-pool/service && node --test test/calibrate.test.js
```

Expected: FAIL — `readMix` is not exported.

- [x] **Step 3: Implement `readMix`, and drop the `generate-slo.js` import from the CLI**

```js
/**
 * The request mix, as the container receives it.
 *
 * NOT read from slo.yaml here, though slo.yaml remains its only source. The
 * image is built with service/ as the Docker context, so the project-root
 * slo.yaml is not in it, and `yaml` is a devDependency that `npm ci --omit=dev`
 * leaves out -- so a container that tried to parse it would fail at import time,
 * before measuring anything. The caller reads slo.yaml where the dev
 * dependencies live (scripts/run-oneoff.sh's caller, see the plan's Task 9) and
 * passes the result in as CAPACITY_MIX.
 *
 * Every share is required: solveKnobs divides by the report share, and a missing
 * one would silently size the whole experiment against three quarters of a
 * workload.
 */
export function readMix(env = process.env) {
  const raw = env.CAPACITY_MIX;
  if (!raw) {
    throw new Error('CAPACITY_MIX is required: pass the mix from slo.yaml (capacity.mix) as JSON, '
      + 'because slo.yaml itself is not in the image');
  }
  let mix;
  try { mix = JSON.parse(raw); } catch (err) {
    throw new Error(`CAPACITY_MIX is not valid JSON (${err.message})`);
  }
  for (const kind of ['read', 'write', 'feed', 'report']) {
    if (typeof mix?.[kind] !== 'number' || !Number.isFinite(mix[kind])) {
      throw new Error(`CAPACITY_MIX has no numeric share for "${kind}"`);
    }
  }
  return mix;
}
```

In the CLI block, delete the `loadSlo` import and the two lines that read `slo.yaml`, and replace
`doc.capacity.mix` with `readMix()`. Keep the printed `inputs.mix`, so the run's own output still
records the mix it was given.

- [x] **Step 4: Fix this file's stale header while you are in it**

Task 4's review left a deferred minor: the top-of-file comment still says the script "finds the
`REPORT_SCAN_ROWS` that makes the heavy route hold a connection for the target time". It now measures
all four routes and solves two knobs against the mean hold. Rewrite those lines to say so.

- [x] **Step 5: Prove it would load in the runtime image**

The failure this task fixes is an import-time one, so check it the same way — with the dev
dependencies unavailable:

```bash
cd ecs-rds-postgres-pool/service
npm test
docker build --platform linux/amd64 -t ecs-rds-postgres-pool:calibrate-check .
docker run --rm ecs-rds-postgres-pool:calibrate-check node -e "
  import('./scripts/calibrate.js').then(m => console.log('loaded; exports:', Object.keys(m).join(',')))"
docker run --rm -e CAPACITY_MIX='{"read":0.55,"write":0.15,"feed":0.25,"report":0.05}' \
  ecs-rds-postgres-pool:calibrate-check node -e "
  import('./scripts/calibrate.js').then(m => console.log(JSON.stringify(m.solveKnobs({
    holds: { read: 1, write: 1, feed: 2 }, mix: m.readMix(), poolSize: 5, vcpus: 2,
    targetMeanHoldMs: 20, targetCpuRelative: 0.5 }))))"
```

Expected: the module loads (no `ERR_MODULE_NOT_FOUND` for `yaml`), and the second command prints the
solved knobs. **A module-level import of the CLI's dependencies would still fail here** — the CLI's
`await import(...)` calls are inside the `import.meta.url` guard, so importing the file does not run
them. If either command fails, that is the bug this task exists to catch.

- [x] **Step 6: Update Task 9's command in this plan**

Task 9 Step 1 must pass the mix. Replace its command with:

```bash
cd ecs-rds-postgres-pool
# slo.yaml is the one source of the mix; it is read HERE, where the dev
# dependencies exist, because the image carries neither the file nor `yaml`.
MIX=$(cd service && node -e "
  import('./scripts/generate-slo.js').then(m => {
    const doc = m.loadSlo('../slo.yaml', undefined, { requireCapacityMix: true, requireThresholds: false });
    process.stdout.write(JSON.stringify(doc.capacity.mix));
  })")
echo "mix: $MIX"
./scripts/run-oneoff.sh -e CAPACITY_MIX="$MIX" -e DB_VCPUS=2 -e TARGET_MEAN_HOLD_MS=20 \
  -e TARGET_CPU_RELATIVE=0.5 node scripts/calibrate.js
```

- [x] **Step 7: Commit**

```bash
git add ecs-rds-postgres-pool/service docs/superpowers/plans/2026-09-24-ecs-rds-postgres-pool-calibrate-baseline.md
git commit -m "fix(ecs-rds-postgres-pool/service): let the calibrator run in the image"
```

---

## Task 19: The measurement-free half of Task 11
> **Complete 2026-09-24** — commits `0494e4b` and `8371b75` after one fix round. The archive check
> gave `preAllocatedVUs: 17` against the scaffolding thresholds, all 16 feeds are reached, and the
> `vcpu_per_task` test was proven to fail before being trusted. The fix round hedged a D1 claim in
> the README that had been stated as fact.
**Files:**
- Modify: `ecs-rds-postgres-pool/infra/k6/tests/lib/request.js`, `tests/lib/mix.js`
- Modify: `ecs-rds-postgres-pool/infra/k6/tests/{discovery,constant,stress}.js`
- Modify: `ecs-rds-postgres-pool/service/scripts/generate-slo.js`, `service/test/generate-slo.test.js`
- Modify: `ecs-rds-postgres-pool/README.md`

**Interfaces:**
- Produces: profiles that size their own VUs once `lib/slo.js` exists, a generator that refuses a
  `vcpu_per_task` disagreeing with the task size, a mix that reads every seeded feed, and the README
  section every alert's `runbook_url` already points at.

**Why this task exists.** Task 11 bundles four steps that need no measurement with five that cannot
happen before the instance exists. Doing the first four now means the session with a live database
spends itself on measurement rather than on editing files. **Task 11 keeps its Steps 1–7 and 12 and
drops Steps 8–11, which move here verbatim.**

- [x] **Step 1: Size the VUs from the thresholds (Task 11 Step 8's content)**

Apply Task 11 Step 8 exactly as it is written there, to all three profiles.

- [x] **Step 2: Verify the sizing without inventing a committed threshold**

The profiles import `lib/slo.js`, which does not exist until Task 11 freezes the thresholds, so the
check needs a throwaway stand-in. Write one, archive against it, and delete it in the same step —
**it must never be committed**, and the numbers in it are not thresholds, they are scaffolding:

```bash
cd ecs-rds-postgres-pool/infra/k6
cat > tests/lib/slo.js <<'EOF'
// THROWAWAY SCAFFOLDING - not generated, not committed. Values are arbitrary and
// exist only to prove the VU arithmetic; the real file is generated in Task 11.
export const CLASS_THRESHOLD_MS = { fast: 100, standard: 200, heavy: 1000 };
export const TAIL_MULTIPLIER = 3;
export const SLO_MET_RATE = 0.95;
export const thresholds = { slo_met: ['rate>0.95'] };
EOF
direnv exec . k6 archive -e BASE_URL=http://example.invalid -e RATE=100 -O /tmp/a.tar tests/constant.js
tar -xOf /tmp/a.tar metadata.json | jq '.options.scenarios.steady | {rate, preAllocatedVUs}'
rm tests/lib/slo.js
/usr/bin/git status --short infra/k6/tests/lib/   # must show nothing
```

Expected `preAllocatedVUs`: `ceil(100 × (0.70×0.1 + 0.25×0.2 + 0.05×1.0)) = ceil(100 × 0.17) = 17`.
If it is not 17, the mix-weighting is wrong — fix it here rather than discovering it at the knee.

- [x] **Step 3: Stop the feed ids aliasing (Task 11 Step 9's content)**

Apply Task 11 Step 9 exactly as written, then confirm every seeded feed is reached:

```bash
node -e "
  let turn = 0; const next = (feeds) => (turn++ % feeds) + 1;
  const seen = new Set(); for (let i = 0; i < 100; i++) seen.add(next(16));
  console.log('feeds reached:', [...seen].sort((a,b)=>a-b).join(','));"
```

Expected: 1 through 16, with none missing.

- [x] **Step 4: Cross-check `vcpu_per_task` (Task 11 Step 10's content)**

Apply Task 11 Step 10 exactly as written: the generator rule and the test that reads `task_cpu` out
of `dev.tfvars`. Prove the test can fail — temporarily change `vcpu_per_task` to `0.5`, watch the
test go red, and put it back.

- [x] **Step 5: Write the README's runbook section (Task 11 Step 11's content)**

Apply Task 11 Step 11 as written. The rules to describe already exist in code, so nothing here waits
on a measurement:

```bash
grep -n 'name *=' infra/grafana/saturation.tf infra/grafana/canary.tf | head -20
grep -n 'RUNBOOK_URL' service/scripts/generate-slo.js
```

The heading text must produce the anchor `#6-is-it-about-to-break` — GitHub lowercases, drops
punctuation and hyphenates spaces, so the heading is `## 6. Is it about to break?`. State for each
rule what fires it and what it means, with **no thresholds that have not been measured**: the burn
rules' numbers derive from the objectives (95%, 99%, 99.9%) and are arithmetic, while any latency
figure is not, and does not go in yet.

- [x] **Step 6: Test, format, commit**

```bash
cd ecs-rds-postgres-pool/service && npm test
cd .. && terraform fmt -check -recursive infra/
```

```bash
git add ecs-rds-postgres-pool
git commit -m "feat(ecs-rds-postgres-pool): vu sizing, feed coverage and the runbook"
```

---

## Task 20: The README as a runbook
> **Complete 2026-09-24** — commits `913029b` and `b5bc147`, task review clean. Two deferred
> minors: the cost table drops the sibling's "2 Fargate tasks" qualifier, and three reference-link
> definitions are unused. Fold both into Task 16, which rewrites this file with measured results.
**Files:**
- Modify: `ecs-rds-postgres-pool/README.md`

**Interfaces:**
- Consumes: everything Tasks 3–6, 13, 18 and 19 built.
- Produces: a README someone can work the project from without reading a spec or a plan — what to
  open, how to tell what is happening, and how to move the infrastructure when the SLO says to.

**Why now, before the environment exists.** Asked for on 2026-09-24: the first live session should be
measurement and `dev.tfvars` edits, and a reader should not have to reconstruct the procedure from
four plans while an instance bills by the hour. Everything below is procedure and design, not
measurement, so none of it waits.

**The model is `ecs-dynamodb-rps/README.md`** — read it first, and keep its shape: a *Where to look*
table, numbered diagnostic sections, then a Runbook of numbered phases, then Cost and Known gaps.
Keep what this project's README already has; this task restructures and extends rather than
rewrites. **Section 6 is Task 19's runbook section and its heading must not change** — every alert's
`runbook_url` points at `#6-is-it-about-to-break`.

- [x] **Step 1: Read the sibling, and list what transfers**

```bash
sed -n '1,130p' ../ecs-dynamodb-rps/README.md
grep -n '^## \|^# ' ../ecs-dynamodb-rps/README.md
```

Its diagnostic sections are DynamoDB-shaped — "was the table throttling?" is this project's "was the
pool queueing, or was the database busy?". Transfer the *shape* and write this project's content.

- [x] **Step 2: Add "Where to look"**

A table of the four places, with this project's names: the Grafana folder `high-load-test /
ecs-rds-postgres-pool` and its dashboard, the alert rules in the same folder, the SLO app, and the
Grafana Cloud k6 project (created and destroyed with the environment, so it is absent between runs).
Take the dashboard's row numbers and titles from the file rather than from memory:

```bash
grep -n '"title"' infra/grafana/dashboard.json.tftpl | grep -i 'row\|^.*[0-9]\.' | head -20
```

- [x] **Step 3: Write the numbered diagnostic sections**

Four sections, each answering one question from the panels. **Section 6 already exists** (Task 19);
number the rest so it keeps its anchor.

| # | question | what it reads |
|---|---|---|
| 1 | Is the service up? | ECS running task count, ALB healthy hosts, request count and status codes |
| 2 | Are we meeting the SLO? | the SLI ratio panel and the SLO app's error budget; that a 5xx is a miss however fast, a 4xx is not; that the authoritative figure is run-scoped, and the continuous line is informational because between runs the only traffic is the one-a-minute heartbeat |
| 3 | **What is the bottleneck?** | the project's whole point: pool wait p99 by class, the wait split by `pool_opened`, the waiting/idle/total gauges, `DBLoadCPU` against the instance's vCPUs, and `DatabaseConnections` against the ceiling |
| 6 | Is it about to break? | Task 19's section, unchanged |

Section 3 carries the three reading rules that are easy to get backwards, and they are the most
valuable paragraphs in the file:

- **Pool wait high, `DBLoadCPU` low** → the pool is the constraint. That is the baseline's
  intended state and what knob 1 releases.
- **Pool wait high and `DBLoadCPU` at or above the vCPU count** → both are saturated and no request
  can be attributed to either. Say plainly that a comparison measured in that state is not a result.
- **A wait spike that coincides with `db_pool_total` rising is connection setup, not queueing** —
  TCP, TLS and Postgres authentication land in the same series as "queued behind four other
  requests", and only the gauge separates them.
- And the one that will confuse the next reader most: **`DBLoadRelativeToNumVCPUs` is not the
  headroom metric here.** The heavy route waits as well as works (decision D1), and a `pg_sleep`
  session is `active` in `pg_stat_activity` with wait event `Timeout: PgSleep`, so Performance
  Insights counts it. Expect that metric to read roughly `pool_size ÷ vCPUs` at the knee and read
  `DBLoadCPU ÷ vCPUs` instead. Write it as an expectation until a run confirms it.

- [x] **Step 4: Write the Runbook's phases**

Numbered phases, in the order someone actually performs them. Phase 0 is setup (`.env`, `direnv
allow`, `terraform -chdir=platform apply` from the repo root, `npm ci` in `service/`, `init`); then:

| phase | what |
|---|---|
| 1 | Provision: `/env up`, then `./scripts/deploy-service.sh`. Note that Terraform never rebuilds the image, so every `service/src/` change needs the script again — the service looks healthy while running old code |
| 2 | Seed: `./scripts/run-oneoff.sh node prisma/seed.js`. One shot, not idempotent, and nothing truncates |
| 3 | Calibrate: the `CAPACITY_MIX` command from Task 9, what its three outcomes mean, and that its two numbers go into `dev.tfvars` with the date and instance class beside them |
| 4 | Freeze the thresholds: the probe, 3× the unloaded server-side p99, `npm run slo:generate`, and that `npm run slo:check` is red until then **on purpose** |
| 5 | Load test: upload, then discovery → constant → stress, and how to read a discovery run (the knee is the **lowest** step whose threshold reads `true`, because k6's boolean means *breached*) |
| 6 | Read the result: both attainment columns, where each comes from, and why they differ |
| 7 | Record: one row per run in `results.md`, with the `posts` count taken before the run |
| 8 | Tear down: `/env down`, then the tagged-resource sweep, and the survivors to look for by name |

- [x] **Step 5: Write "How to move the infrastructure for the SLO"**

This is the section the project exists to make possible, and it is what a reader will come for after
a failing run. Two distinct moves, and they must not be confused:

**Changing the infrastructure** — one `dev.tfvars` line, one apply, then the *identical* profiles
re-run. Give the knob table with its connection arithmetic, and the two preconditions that are not
optional: `SHOW max_connections` before knob 2, with `max_connections_alert` re-derived from the real
figure; and the CloudWatch confirmation of `DatabaseConnectionsBorrowLatency`'s unit before knob 3,
which the module already refuses to plan without.

**Changing the SLO itself** — `slo.yaml` is the only source. Say what regenerating touches
(`locals.tf`, `alerts.tf`, `infra/k6/tests/lib/slo.js`, `classmap.json`, `queries.json`), that both
the Grafana rules and the k6 thresholds move together and a hand-edit of either is drift, and that an
objective change needs an apply to reach Grafana. Carry the floor the tests already enforce: at a
14.4× fast-burn multiplier the primary objective cannot go below **93.06%**, or the rule needs a miss
rate above 100% and can never fire (`service/test/generate-slo.test.js`). Say which knob to reach for
first when a class misses its threshold — the pool, the task count, or the class threshold itself —
and that changing the threshold to pass a run is moving the goalposts, so it needs a recorded reason.

- [x] **Step 6: Cost and Known gaps**

Cost as **estimates, labelled as estimates**, from the spec's table — no queried price exists yet, and
the repo's rule is that a published figure comes with the query that produced it. Name the proxy as
the line to check first (~40% of the idle bill) and the forgotten environment as the real risk.

Known gaps, each already true: Terraform does not rebuild the image; the k6 upload is manual and
silent when skipped, and the k6 project is recreated by every `/env up`; the k6 settings page cannot
be automated; the SLO window is fixed at 7 days; there is no local Postgres, so TLS and migrations
fail first in AWS; and `results.md` is empty until the first run.

- [x] **Step 7: Check the links and the one forbidden thing**

```bash
grep -n 'is-it-about-to-break' README.md ../ecs-rds-postgres-pool/service/scripts/generate-slo.js
grep -nE '[0-9]+ ?(ms|rps|%)' README.md | grep -v 'objective\|burn\|93.06\|threshold_ms\|null'
```

The first must show the README's heading and the generator's `RUNBOOK_URL` agreeing. The second is
the guard against a measured-looking number: every hit must be arithmetic (an objective, a burn
multiplier, a connection count) and not a latency or a throughput figure, because none has been
measured yet.

- [x] **Step 8: Commit**

```bash
git add ecs-rds-postgres-pool/README.md
git commit -m "docs(ecs-rds-postgres-pool): readme as a runbook"
```

---

## Done when

- [ ] The `ecs-rds-postgres-pool` workspace exists and `infra/main` has been applied, deployed and
      seeded.
- [ ] `scripts/calibrate.js` has run **on the instance** and its output is quoted in the commit that
      set `report_scan_rows` and `report_sleep_ms`.
- [ ] At the discovered knee, pool wait rises while `DBLoadCPU ÷ vCPUs` sits near 0.5 — or the run
      that showed otherwise is reported, and the plan stopped there.
- [ ] `slo.yaml` carries three real `threshold_ms` values and a `target_rps`, and `npm run slo:check`
      exits **0**.
- [ ] `infra/grafana/locals.tf`, `alerts.tf`, `slo.tf` and `infra/k6/tests/lib/slo.js` exist, and the
      dashboard's panel 19 shows the SLI rather than a text placeholder.
- [ ] A `stress` run exited **99** with `slo_met` breached, before any knob was moved.
- [ ] `results.md` holds at least the discovery row and the two baseline rows, each with both
      attainment columns, the infra change, and the `posts` row count.
- [ ] The README states the measured results, each with the run that produced it.
- [ ] The spec and plan 1 carry forward-pointers at the three decisions this plan changed.
- [ ] Either the environment is destroyed and the tagged-resource sweep is empty, or `results.md`
      says it is being kept for plan 4.

## What this plan deliberately does not do

- **No knob is released.** `pool_size` stays 5, `desired_count` stays 1, `proxy_enabled` stays false.
  All three are plan 4, one apply each.
- **No `service/pricing.json` and no published cost figure**, beyond quoting the spec's estimates as
  estimates. A price needs a recorded query, and that belongs with plan 4's final write-up.
- **No autoscaling and no admission control.** Both are excluded by the spec (§4.3) and their absence
  is what keeps every run one deterministic configuration.
- **No proxy work.** Plan 2's inherited item (i) — the proxy's log group path and the target reaching
  `AVAILABLE` — can only be confirmed against a real proxy, which is knob 3.

## What plan 4 inherits

- **(i) from plan 2:** at the first knob-3 apply, confirm the proxy's log group path
  (`/aws/rds/proxy/ecs-rds-postgres-pool`) and that the proxy target turns `AVAILABLE`.
- **The borrow-latency unit.** `proxy_borrow_latency_threshold` is still unset, and the module
  refuses to plan knob 3 without it. Confirm the unit of `DatabaseConnectionsBorrowLatency` in the
  CloudWatch console on the real proxy first: a 1000× error is silent and looks like a spectacular
  result (spec §6.3).
- **`max_connections_alert`** is derived from the real ceiling Task 8 measured. Knob 2 runs
  `pool 25 × 4 tasks = 100` against it.
- **The calibration is instance-specific.** If plan 4 recreates the environment on a different
  instance class, `report_scan_rows` and `report_sleep_ms` must be re-derived (Task 9), and the class
  thresholds with them.
- **`DBLoadRelativeToNumVCPUs` is not the headroom metric on this project** — `DBLoadCPU ÷ vCPUs` is
  (D1). Every plan 4 row reads the second one.
