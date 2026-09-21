# ecs-rds-postgres-pool — Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

- **Status:** **complete** (2026-09-22). Tasks 2–16 were executed and reviewed on 2026-09-21. The
  user's review on 2026-09-22 (<https://claude.ai/artifact/MNVg7JiQip7fj5gAYRAjvp>) added rulings
  R17–R20 in the section "Amended during execution and plan-3 handoff" at the end of this plan.
  **Two steps were not run here and move to plan 3's opening, by the user's decision to close this
  plan:** Task 1 Steps 3–4 (the `platform/` apply, whose reviewed plan on 2026-09-22 showed exactly
  three additions: the `ecs-rds-postgres-pool` workspace, its settings, and the sensitive
  `db_password` variable) and Task 17 (the reviewed `plan` of `infra/main`, which needs that
  workspace). Until plan 3 runs them, `platform/` is committed ahead of its applied state and nothing
  of this project exists in HCP or AWS.
- **Plan 2 of 4** (the spec's "Execution shape", §12). This is spec phase 2: the TFC workspace, the
  root module with every knob pre-wired, the Grafana and k6 modules, and the project scripts.
- **Spec:** `docs/superpowers/specs/2026-09-19-ecs-rds-postgres-pool-design.md`
- **Predecessor:** `docs/superpowers/plans/2026-09-20-ecs-rds-postgres-pool-service.md` (plan 1,
  complete and merged to `master` as `36735a4`). Its service code is what this infrastructure runs.

**Goal:** A `terraform plan` of `ecs-rds-postgres-pool/infra/main` that a human has reviewed and
that would create a working environment — ECS service, ALB, RDS PostgreSQL, the collector, the
heartbeat, the Grafana folder and dashboard, the k6 project — with all three knobs of the spec's
knob sequence already wired as variables, and the proxy `count`-gated so it costs nothing until
flipped.

**Architecture:** The root module is a near-copy of `ecs-dynamodb-rps/infra/main`, with DynamoDB
replaced by RDS PostgreSQL and the two control loops (autoscaling, admission shedding) deliberately
absent. `../grafana` and `../k6` are called as modules, which resolves only because the workspace's
working directory is `infra/main` and the run's upload root is therefore the project directory.

**Tech Stack:** Terraform ~> 1.14.0, `hashicorp/aws` ~> 6.0, `hashicorp/random` ~> 3.0,
`grafana/grafana` ~> 3.0, `hashicorp/archive` ~> 2.0, `hashicorp/tfe` (in `platform/` only), HCP
Terraform remote execution, Grafana Alloy, k6 1.4, Node 22.

**This plan applies nothing to AWS.** It ends at a reviewed plan. The one `terraform apply` it
contains creates a Terraform Cloud workspace, which is free and holds no infrastructure — and it
still stops for approval, because this repository gates on the *command*, not on the bill.

---

## Global Constraints

Copied from the spec and from `CLAUDE.md`; every task's requirements implicitly include these.

- **Terraform is the only way infrastructure exists.** No click-ops, no `aws` CLI mutations.
  Read-only `aws … describe-*` calls are allowed and are sometimes required below.
- **No project script may run `terraform apply` or `destroy`.** The `permissions.ask` rules match on
  command text, so an apply buried in a script is an apply that never reaches the approval gate.
- **Every apply and destroy is its own task and stops for approval.** A subagent may write and
  `plan` HCL freely; it may not `apply` it unprompted.
- **Every resource carries `Project = ecs-rds-postgres-pool`**, set once via `default_tags` on the
  AWS provider so it cannot be forgotten per-resource. The teardown sweep finds orphans by that tag;
  an untagged resource is invisible to it and bills forever.
- **`terraform destroy` must leave nothing billable.** This stack's survivors — final snapshot,
  automated backups, the RDS log group, the subnet and parameter groups, the Secrets Manager secret,
  the proxy — are each guarded in Tasks 5 and 6.
- **Secrets never live in a project folder.** AWS, TFC and Grafana credentials come from the root
  `.env` through the shared HCP variable set. Per-project `.tfvars` hold only non-secret sizing
  knobs.
- **The class thresholds in `slo.yaml` stay `null`.** They are frozen in plan 3 after calibration on
  the real instance, because they are what the k6 VU sizing is derived from. `npm run slo:check`
  exits non-zero until then, on purpose. **Do not invent a threshold anywhere in this plan** — not in
  `dev.tfvars`, not in a Grafana rule, not in a k6 profile.
- **No measured number in any document.** No SLO, latency, throughput or cost figure without the run
  or price query that produced it, in the same session.
- **Every file copied from `ecs-dynamodb-rps` carries a two-line header** naming the sibling file and
  the fork date 2026-09-21, because a bug fixed in one copy stays broken in the other. Plan 1 used
  `// Forked from <path> on <date>.` then `// A bug fixed here does not reach the sibling copy; fix
  both.` — use the same wording, in `#` for HCL.
- **Every `terraform` and `aws` command runs as `direnv exec . <command>`.** The repo's `.envrc`
  loads `.env` and exports the TFC token (`TF_TOKEN_app_terraform_io`, aliased to `TFE_TOKEN` for
  the `tfe` provider), `TF_CLOUD_ORGANIZATION`, `TF_CLOUD_PROJECT`, the AWS credentials and the
  `TF_VAR_*` values — but **direnv fires only in interactive shells**. Claude Code's Bash tool,
  subagents and scripts receive none of it, and the failure looks like a missing workspace or an
  auth error rather than a missing environment. `direnv exec .` walks up to the repo-root `.envrc`
  from any subdirectory. The commands below are written without the prefix for readability; add it
  to every one that reaches HCP or AWS. `terraform fmt` needs no credentials and is the exception.
- **Per-task verification for anything touching HCL is `terraform fmt -check`, then `validate`.**
  The reviewed `plan` is Task 17, once the whole module exists. There is no unit-test analogue for
  configuration; the two service-code tasks (3 and 15) take the red-green loop.

### The environment-variable contract

Plan 1 fixed these names and they are the interface this plan implements. Task 16 moves this table
into the project README, where it belongs; until then the authoritative copy is plan 1's.

| variable | source in this plan |
|---|---|
| `PORT` | `var.container_port` |
| `AWS_REGION` | `data.aws_region.current.region` |
| `DATABASE_URL` | `local.database_url` (Task 6) — host switches between instance and proxy |
| `DB_SSL` | literal `"require"` |
| `DB_CA_BUNDLE` | **new in this plan** (Task 15) — not set by Terraform; the image default stands |
| `POOL_MAX` | `var.pool_size` — **knob 1** |
| `POOL_CONNECTION_TIMEOUT_MS` | `var.pool_connection_timeout_ms` |
| `MIGRATE_ON_BOOT` | `var.migrate_on_boot` → `"1"` or `""` |
| `SEED_ON_BOOT` | `var.seed_on_boot` → `"1"` or `""` |
| `SEED_ROWS` / `SEED_FEEDS` | `var.seed_rows` / `var.seed_feeds` |
| `FEED_PAGE_SIZE` | `var.feed_page_size` |
| `REPORT_SCAN_ROWS` | `var.report_scan_rows` — the calibrated knob, `0` until plan 3 |
| `OTLP_ENDPOINT` | the collector's Cloud Map DNS name |
| `METRICS_NAMESPACE` / `OTEL_SERVICE_NAME` | `local.metrics_namespace` / `local.metrics_service_name` |
| `OTEL_SERVICE_INSTANCE_ID` | **deliberately not set** — see Task 8 |
| `OTEL_EXPORT_INTERVAL_MS` / `METRICS_INTERVAL_MS` | not set; the service defaults stand |

---

## Design decisions made in this plan

The spec settles the architecture. Four things it did not anticipate came out of surveying the
sibling stack and plan 1's handoffs, and they are decided here. **This section is the thing to read
first in review.**

### D1. `canary.tf` is forked after all — the spec's reason for dropping it was wrong

The spec's "deliberately not forked" table (§4.3) lists `infra/grafana/canary.tf` with the reason
*"a synthetic check, orthogonal to this project's question"*.

**That description does not match the file.** Grafana Synthetic Monitoring appears in it only as a
historical comment explaining what the file *replaced*. The live resource is
`grafana_rule_group.sli_absent`: an alert on
`absent_over_time(http_server_request_duration_seconds{job="…", class=~"fast|standard|heavy"}[10m])`
that fires when the SLI series stops existing — when the chain from heartbeat through the service's
OTLP export, through the collector, into Grafana Cloud ingest has gone silent.

That is not orthogonal to this project; it guards the failure this whole repository is built to
avoid. An empty panel and a healthy system look identical, and this project's deliverable is a
before/after table read off those panels.

**Decision: fork it** (Task 12), and give the spec a forward-pointer at that row (Task 16).

### D2. The threshold-dependent generated files cannot exist yet; the resources reading them move to plan 3

`service/scripts/generate-slo.js` writes five files from `slo.yaml`. `slo.yaml` ships with every
class `threshold_ms` set to `null`, and plan 1 built `validateSlo` to throw on exactly that — the
guard that stops uncalibrated thresholds reaching infrastructure. So today `slo:generate` writes
nothing.

Three of the five genuinely need thresholds: `infra/grafana/locals.tf` bakes them into the SLI
PromQL, `infra/grafana/alerts.tf` into every burn-rate rule, `infra/k6/tests/lib/slo.js` into the k6
assertions. Two do not: `classmap.json` is only route-template → class, and `queries.json`'s
attribution keys are built on metric names — only its `sli_ratio` key carries thresholds.

**Decision:**

1. **Task 3 makes the generator emit the two threshold-free outputs now**, with `queries.json`
   including `sli_ratio` only once thresholds are set. This is also where the Postgres-form
   attribution renderer plan 1 recorded as owed gets built.
2. **`locals.tf`, `alerts.tf`, `slo.tf` and `k6/tests/lib/slo.js` are not written in this plan.**
   They are plan 3's first act after thresholds are frozen. The Grafana module here declares the
   folder, the dashboard, the saturation rules and the SLI-absent rule — all of which stand without
   a threshold.
3. **The dashboard's SLI row is written now, with its panel id preserved, holding a text panel
   instead of its query.** Plan 3's generated burn-rate rules carry a `__panelId__` pointing at that
   panel; omitting the row now and inserting it later would renumber it and break every alert's link
   back to the graph that explains it.

This does not move the spec's phase boundaries. Plan 2 still ends at a reviewed plan; plan 3 still
calibrates, freezes and regenerates. It makes explicit which files plan 3's regeneration *creates*
rather than overwrites.

### D3. Dropping the collector's CloudWatch pipeline removes more than the spec says

The spec (§4.4) drops Alloy's `prometheus.exporter.cloudwatch` pipeline, because it existed to
subtract DynamoDB's server-side latency and Postgres publishes no equivalent. Four more things go
with it; leaving any of them ships dead configuration:

- **`collector.tf`'s CloudWatch-read IAM policy** (`cloudwatch:GetMetricData`,
  `cloudwatch:ListMetrics`, `tag:GetResources`). Nothing in the collector reads CloudWatch any more.
- **Alloy's `prometheus.remote_write` and `prometheus.scrape "cloudwatch"` blocks.** Pipeline 1
  exports over OTLP, not remote-write.
- **The three `grafana_prom_*` variables** and their SSM parameters, secret injection and
  execution-role grant.
- **`queries.json`'s `cloudwatch_srl_by_operation` and `queueing_ms_by_route`**, and the dashboard
  panels reading them.

### D4. The image carries the RDS CA bundle and verifies the server certificate

Plan 1's `src/pool.js` sets `ssl: { rejectUnauthorized: false }` with the comment *"carrying the RDS
CA bundle in the image is plan 2's problem"*, and the spec (§7.4) says *"the image must carry the RDS
CA bundle"*. So this plan owes it.

The subtlety is that knob 3 changes **which certificate the service sees**. Connecting to the
instance, it sees a certificate signed by the RDS CA, which is not in Node's default trust store.
Connecting through RDS Proxy, it sees an ACM-issued certificate chaining to Amazon's public roots,
which *is* in Node's default store and *is not* in the RDS bundle. Passing `ca` to TLS **replaces**
the default store rather than adding to it — so a naive fix verifies the instance and breaks the
proxy, and it would only surface at knob 3.

**Decision:** trust `[...tls.rootCertificates, rdsBundle]` with `rejectUnauthorized: true`. Both
paths verify, and knob 3 remains a one-line `dev.tfvars` change as the spec requires. Task 15.

---

## File Structure

```
platform/
  tfc.tf                    MODIFY: one line adding this project's workspace

ecs-rds-postgres-pool/
  .terraformignore          NEW  keeps the service tree out of every remote run's upload
  README.md                 NEW  what it provisions, how to run it, the env-var contract
  infra/
    main/                   ROOT MODULE (workspace ecs-rds-postgres-pool, working dir infra/main)
      versions.tf           forked: cloud block, providers, default_tags, data sources
      variables.tf          forked and pruned: no RCU/WCU, pbkdf2, autoscaling or shedding
      network.tf            forked minus the DynamoDB endpoint, plus the database SG
      rds.tf                NEW  instance, subnet group, parameter group, log group, password
      proxy.tf              NEW  aws_db_proxy + secret + role, all count-gated; the host switch
      ecr.tf alb.tf         forked verbatim
      ecs.tf collector.tf   forked: environment rewritten; CloudWatch pipeline removed (D3)
      heartbeat.tf          forked verbatim
      grafana.tf            forked: calls ../grafana and ../k6
      outputs.tf            forked: table_name and provisioned_capacity replaced
      dev.tfvars            NEW  the knob positions and measurement parameters
    grafana/
      versions.tf variables.tf folder.tf   forked
      dashboard.json.tftpl  forked: DynamoDB rows replaced, pool row added, SLI row pending (D2)
      saturation.tf         NEW  replaces throttles.tf
      canary.tf             forked (D1)
      alloy.alloy.tftpl     forked minus pipeline 2 (D3)
      classmap.json         GENERATED (Task 3)
      queries.json          GENERATED (Task 3), Postgres form
    k6/
      main.tf outputs.tf variables.tf versions.tf   forked verbatim
      tests/                discovery.js constant.js stress.js, lib/{request,env,mix}.js
  heartbeat/index.mjs       forked: the four routes change
  scripts/
    deploy-service.sh       forked minus the seed step
    upload-k6.sh            forked verbatim
  service/
    scripts/generate-slo.js MODIFY (Task 3)
    src/pool.js             MODIFY (Task 15): verify the server certificate
    Dockerfile              MODIFY (Task 15): carry the RDS CA bundle

NOT IN THIS PLAN, generated in plan 3 (D2):
  infra/grafana/locals.tf  infra/grafana/alerts.tf  infra/grafana/slo.tf  infra/k6/tests/lib/slo.js
```

**Task order is dictated by references, not by topic.** `collector.tf` reads `classmap.json` at plan
time via `file()`, so the generator (Task 3) comes first. `ecs.tf` and `collector.tf` reference each
other — the service's `OTLP_ENDPOINT` names the collector's Cloud Map namespace, and the collector
runs on the cluster and execution role `ecs.tf` declares — so they land together in Task 8. Every
task validates only what exists by the end of it.

---

## Task 1: The Terraform Cloud workspace

> **Amended in review (2026-09-22):** Task 1 also carries the database password into the shared HCP
> variable set — `platform/variables.tf` declares `db_password`, `platform/tfc.tf`'s `local.tf_vars`
> forwards it (sensitive), `.envrc` exports `TF_VAR_db_password` from `DB_PASSWORD` in the root
> `.env`, and `.env.example` documents it. Step 2's expected plan is therefore **three** additions:
> the two workspace resources and `tfe_variable.terraform["db_password"]`. Ruling R19 in the section
> "Amended during execution and plan-3 handoff" at the end of this plan.

**Files:**
- Modify: `platform/tfc.tf` — the `local.projects` map

**Interfaces:**
- Consumes: nothing.
- Produces: a TFC workspace named `ecs-rds-postgres-pool`, execution mode `remote`, working
  directory `infra/main`, with the shared `high-load-test` variable set already attached because
  it is attached at the *project* level. Every later task depends on this: the root module's
  `cloud { workspaces { name = "ecs-rds-postgres-pool" } }` block cannot `init` without it, so
  nothing can `validate`.

- [ ] **Step 1: Add the project to the map**

`platform/tfc.tf` currently reads:

```hcl
  projects = {
    "ecs-dynamodb-rps" = { working_directory = "infra/main" }
  }
```

Add one line, leaving the surrounding comment untouched:

```hcl
  projects = {
    "ecs-dynamodb-rps"      = { working_directory = "infra/main" }
    "ecs-rds-postgres-pool" = { working_directory = "infra/main" }
  }
```

`working_directory` is not cosmetic. A CLI-driven remote run uploads the directory the working
directory is relative *to*. Set to `infra/main`, the upload root becomes `ecs-rds-postgres-pool/`,
which is what makes `../grafana`, `../k6` and the `../../heartbeat` archive resolve inside the run.
Unset, every one of those fails with "no file exists at ./../grafana/…".

- [ ] **Step 2: Format and plan**

```bash
cd /Users/koval/dev/test/high-load-test
terraform -chdir=platform fmt -check
direnv exec . terraform -chdir=platform init
direnv exec . terraform -chdir=platform plan
```

This is the first command in the plan that needs credentials, so it is where a missing
`direnv exec .` shows up — as an authentication error or "workspace not found", not as a message
about the environment. See the Global Constraints.

Expected: exactly two resources to add — `tfe_workspace.project["ecs-rds-postgres-pool"]` and
`tfe_workspace_settings.project["ecs-rds-postgres-pool"]`. **Nothing else may appear.** A plan
proposing changes to the variable set, the existing workspace or the project itself means something
drifted — report it; do not apply through it.

- [ ] **Step 3: ⛔ STOP — apply requires approval**

Do not run this yourself. Report that the plan is ready, paste it, and wait.

```bash
direnv exec . terraform -chdir=platform apply
```

**The instruction above is the real gate, not the permission prompt.** `CLAUDE.md` records that the
`permissions.ask` rules match on command text, and that the stronger hook which catches `-chdir=`
and env-prefixed spellings is not registered. A `direnv exec . terraform -chdir=platform apply` may
therefore not prompt at all. Do not rely on being stopped.

- [ ] **Step 4: Confirm the settings took**

```bash
terraform -chdir=platform state show 'tfe_workspace.project["ecs-rds-postgres-pool"]' | grep -E 'working_directory|auto_apply|terraform_version'
terraform -chdir=platform state show 'tfe_workspace_settings.project["ecs-rds-postgres-pool"]' | grep execution_mode
```

Expected: `working_directory = "infra/main"`, `auto_apply = false`, `terraform_version = "~> 1.14.0"`,
`execution_mode = "remote"`.

- [ ] **Step 5: Commit**

```bash
git add platform/tfc.tf
git commit -m "feat(ecs-rds-postgres-pool/terraform): add the project workspace"
```

---

## Task 2: Root module scaffolding

**Files:**
- Create: `ecs-rds-postgres-pool/infra/main/versions.tf`
- Create: `ecs-rds-postgres-pool/infra/main/variables.tf`
- Create: `ecs-rds-postgres-pool/.terraformignore`

**Interfaces:**
- Consumes: the workspace from Task 1.
- Produces: every `var.*` the root module reads. Kept from the sibling: `project` (default now
  `"ecs-rds-postgres-pool"`), `aws_account_id`, `vpc_cidr`, `container_port`, `task_cpu`,
  `task_memory`, `desired_count`, `image_tag`, `log_retention_days`, `stop_timeout_seconds`,
  `collector_cpu`, `collector_memory`, `alloy_image`, `heartbeat_enabled`, `heartbeat_rate`,
  `feed_page_size`, `prometheus_datasource_uid`, `cloudwatch_datasource_uid`,
  `grafana_otlp_endpoint`, `grafana_otlp_username`, `grafana_otlp_password`. New to this project:
  `instance_class`, `allocated_storage`, `db_name`, `db_username`, `operator_cidr`, `pool_size`,
  `pool_connection_timeout_ms`, `proxy_enabled`, `seed_rows`, `seed_feeds`, `report_scan_rows`,
  `migrate_on_boot`, `seed_on_boot`. Also `data.aws_region.current`,
  `data.aws_caller_identity.current`, `data.aws_availability_zones.available`.

- [ ] **Step 1: Copy `versions.tf` and change exactly three things**

```bash
cd /Users/koval/dev/test/high-load-test
mkdir -p ecs-rds-postgres-pool/infra/main
cp ecs-dynamodb-rps/infra/main/versions.tf ecs-rds-postgres-pool/infra/main/versions.tf
```

1. The `cloud` block's workspace `name` becomes `"ecs-rds-postgres-pool"`.
2. Every `ecs-dynamodb-rps` in the comments becomes `ecs-rds-postgres-pool` — those comments describe
   *this* project's upload root and would otherwise be false.
3. Add the `random` provider to `required_providers`, which Task 5's password needs:

```hcl
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
```

Add the fork header under the first line. **Keep the `default_tags` block exactly as it is** — it is
the only thing tagging every resource with `Project`, and the teardown sweep queries that tag.

- [ ] **Step 2: Copy `.terraformignore`**

```bash
cp ecs-dynamodb-rps/.terraformignore ecs-rds-postgres-pool/.terraformignore
```

It sits at the *project* root, not in `infra/main`, because the upload root is the project
directory. Read it and confirm it excludes `service/node_modules`; if it names anything
DynamoDB-specific, adjust it and report what changed. Without this file every remote plan uploads the
entire service tree.

- [ ] **Step 3: Write `variables.tf`**

Start from the sibling's and **delete** these, which have no analogue here: `read_capacity`,
`write_capacity`, `pbkdf2_iterations`, `autoscaling_enabled`, `autoscaling_max`,
`autoscaling_cpu_target`, `requests_scaling_enabled`, `autoscaling_rps_target`,
`elu_scaling_enabled`, `shedding_enabled`, `shed_elu_threshold`, `grafana_prom_url`,
`grafana_prom_username`, `grafana_prom_password`.

Keep the rest verbatim, changing only `project`'s default. Then add this project's own:

```hcl
variable "instance_class" {
  description = "RDS instance class. db.t4g.micro is deliberate: its ~112 connection ceiling is what knob 2 aims at, and a larger class raises that ceiling along with memory, which takes the proxy phase's point away."
  type        = string
  default     = "db.t4g.micro"
}

variable "allocated_storage" {
  description = "gp3 storage in GiB. This sizes the disk, not the measurement -- seed_rows governs the working set."
  type        = number
  default     = 20
}

variable "db_name" {
  type    = string
  default = "app"
}

variable "db_username" {
  type    = string
  default = "app"
}

variable "operator_cidr" { # REMOVED 2026-09-22 (R19): replaced by db_password; 5432 is open to any address
  description = "The one CIDR allowed to reach the database directly, for psql during a session. A /32 of your own address, set in dev.tfvars -- never a range, and never committed with a real value."
  type        = string
}

variable "pool_size" {
  description = "KNOB 1. Pool.max in the service. The baseline is 5, which is what makes the pool bind before the database does; knob 1 releases it to 25."
  type        = number
  default     = 5
}

variable "pool_connection_timeout_ms" {
  description = "How long a request waits for a connection before failing. Set just above the heavy class threshold, so a saturated pool produces 5xx the availability objective catches rather than an unbounded queue visible only as latency. Revisited in plan 3 once the heavy threshold is frozen."
  type        = number
  default     = 900 # AMENDED 2026-09-22 (R17): no default; dev.tfvars sets a labelled placeholder
}

variable "proxy_enabled" {
  description = "KNOB 3. Creates the RDS Proxy, its Secrets Manager secret and its IAM role, and switches the service's database host to the proxy endpoint. Roughly 40% of the idle bill while on -- run it last and destroy it promptly."
  type        = bool
  default     = false
}

variable "seed_rows" {
  description = "A MEASUREMENT PARAMETER. seed_rows x ~1 KB must stay inside shared_buffers (about a quarter of the instance's 1 GiB), or a fast query becomes random reads from gp3 and the first run of a session differs from the second by an order of magnitude."
  type        = number
  default     = 50000
}

variable "seed_feeds" {
  type    = number
  default = 16
}

variable "report_scan_rows" {
  description = "THE CALIBRATED COST KNOB: how many rows the heavy route aggregates over. 0 means the aggregate returns immediately, so an uncalibrated environment never runs a workload nobody chose. Plan 3's calibration sets it."
  type        = number
  default     = 0
}

variable "migrate_on_boot" {
  description = "Runs prisma migrate deploy at container start. Safe on every task: Prisma Migrate takes a Postgres advisory lock, so a rolling deploy does not race itself."
  type        = bool
  default     = true
}

variable "seed_on_boot" {
  description = "Runs the seed at container start. NOT idempotent and NOT lock-guarded: posts has no unique constraint beyond its primary key, so two tasks booting with this set insert twice the rows and a redeploy doubles them again. One task, one shot, then back to false."
  type        = bool
  default     = false
}
```

- [ ] **Step 4: Format and validate**

```bash
cd ecs-rds-postgres-pool
terraform -chdir=infra/main fmt -check
terraform -chdir=infra/main init
terraform -chdir=infra/main validate
```

`init` reaches HCP and needs Task 1's workspace. Expected: `Success! The configuration is valid.`
Variables with no value — `aws_account_id`, `operator_cidr`, the Grafana credentials — do not fail
`validate`; they fail `plan`, which is Task 17's business.

- [ ] **Step 5: Commit**

```bash
git add ecs-rds-postgres-pool/infra/main/versions.tf \
        ecs-rds-postgres-pool/infra/main/variables.tf \
        ecs-rds-postgres-pool/.terraformignore
git commit -m "feat(ecs-rds-postgres-pool/terraform): root module scaffolding"
```

---

## Task 3: The generator's Postgres outputs

**Files:**
- Modify: `ecs-rds-postgres-pool/service/scripts/generate-slo.js`
- Modify: `ecs-rds-postgres-pool/service/test/generate-slo.test.js`
- Create (generated): `ecs-rds-postgres-pool/infra/grafana/classmap.json`
- Create (generated): `ecs-rds-postgres-pool/infra/grafana/queries.json`

**Interfaces:**
- Consumes: `slo.yaml`; `ROUTE_CLASS` from `src/handlers.js`; `POOL_WAIT_DURATION`,
  `POOL_WAITING`, `POOL_IDLE`, `POOL_TOTAL` from `src/otel.js`.
- Produces: `classmap.json` (read by `collector.tf`, Task 8) and `queries.json` (read by the
  dashboard, Task 10). This is decision D2 in practice, and it repays the attribution renderer plan 1
  recorded as owed.

This is service code, so it takes the red-green loop.

- [ ] **Step 1: Read the generator's current CLI and output list**

```bash
cd /Users/koval/dev/test/high-load-test/ecs-rds-postgres-pool/service
grep -n "OUTPUTS\|requireThresholds\|validateSlo\|--check\|--only" scripts/generate-slo.js
```

Note the shape of `OUTPUTS` and how the CLI calls `loadSlo` / `validateSlo`. Plan 1 made
`validateSlo` throw on a null `threshold_ms` and the CLI runs it **before** writing anything — which
is exactly why nothing can be generated today. Everything below works *with* that guard, not around
it.

- [ ] **Step 2: Write the failing tests**

Append to `test/generate-slo.test.js`. **Add the new names to the file's existing import lines** —
`renderClassMap`, `doc` and `POOL_WAIT_DURATION` are already in scope there, and importing a binding
twice in one module is a `SyntaxError`:

```js
test('the attribution queries are built on the pool wait metric, not on dynamodb operations', () => {
  const q = JSON.parse(renderQueries(doc()));
  const text = JSON.stringify(q);
  assert.match(text, new RegExp(POOL_WAIT_DURATION.replace(/\./g, '_')),
    'the pool wait histogram is what this project measures; its metric name must appear');
  assert.doesNotMatch(text, /dynamodb|SuccessfulRequestLatency|queueing_ms_by_route/i,
    'the sibling subtracted a server-side clock Postgres does not publish');
});

test('pool wait is queried per class, because a global histogram cannot say whose requests queued', () => {
  const q = JSON.parse(renderQueries(doc()));
  assert.match(q.pool_wait_p99_by_class ?? '', /by \(class\)/);
});

test('queries.json renders without thresholds, and omits the one key that needs them', () => {
  const q = JSON.parse(renderQueries(doc())); // doc() has every threshold_ms null
  assert.equal(q.sli_ratio, undefined,
    'sli_ratio bakes thresholds into PromQL; it must not appear until plan 3 freezes them');
});

test('queries.json gains sli_ratio once thresholds are set', () => {
  const d = doc();
  d.slos[0].classes.fast.threshold_ms = 1;
  d.slos[0].classes.standard.threshold_ms = 2;
  d.slos[0].classes.heavy.threshold_ms = 3;
  assert.ok(JSON.parse(renderQueries(d)).sli_ratio);
});

test('the class map covers every classified route and nothing else', () => {
  assert.deepEqual(JSON.parse(renderClassMap(doc())), {
    '/posts/:id': 'fast',
    '/posts': 'fast',
    '/feeds/:id/posts': 'standard',
    '/reports': 'heavy',
  });
});

test('validateSlo can skip the threshold guard without skipping any other rule', () => {
  const d = doc();
  assert.doesNotThrow(() => validateSlo(d, { requireThresholds: false }));
  d.slos[0].classes.heavy.endpoints.push('feed');
  assert.throws(() => validateSlo(d, { requireThresholds: false }), /feed/,
    'the endpoint-in-two-classes rule must still fire with the threshold guard off');
});
```

The two threshold-set cases use `1`, `2`, `3` — the same labelled placeholder values plan 1's test
file already uses for exactly this purpose. They are test fixtures, not thresholds.

- [ ] **Step 3: Run and watch them fail**

```bash
npm test -- test/generate-slo.test.js
```

Expected: FAIL — the new keys do not exist, `renderQueries` still emits DynamoDB keys or none, and
`validateSlo` does not accept `requireThresholds`.

- [ ] **Step 4: Implement**

Four changes:

1. **`validateSlo(doc, { requireCapacityMix = false, requireThresholds = true } = {})`.** The null
   `threshold_ms` check runs only when `requireThresholds` is true. **The default is `true`**, so
   every existing caller — including `slo:check` — keeps the guard exactly as plan 1 built it.
2. **`renderQueries(doc)`** emits the keys below, building PromQL from the constants in `src/otel.js`
   rather than retyping metric names — they drifted once already, and a test pins `slo.yaml`'s copy
   against `POOL_WAIT_DURATION`. It includes `sli_ratio` **only when every class threshold is set**.
   Do **not** emit `cloudwatch_srl_by_operation` or `queueing_ms_by_route`.

| key | answers |
|---|---|
| `pool_wait_p99_by_class` | how long each class waited for a connection — **the project's central series** |
| `pool_wait_p99_opened` | the same split by `pool.opened`, separating a real queue from a connection being established |
| `pool_waiting` / `pool_idle` / `pool_total` | the three gauges; `total` rising is what says a wait was setup rather than queueing |
| `db_wall_avg_by_route` | in-process database time per route, carried over from the sibling |
| `cpu_seconds_per_second` / `cpu_saturation_ratio` | CPU seconds per wall second, against `attribution.vcpu_per_task` |
| `eventloop_delay_p99` / `eventloop_delay_max` / `eventloop_utilization` | queue [1], unchanged from the sibling |
| `sli_ratio` | **only when thresholds are set** — the class-threshold ratio the SLO computes |

   The OTel-to-Prometheus name mapping for a histogram named `db.pool.wait.duration` with unit `s` is
   `db_pool_wait_duration_seconds`, with `_bucket` for native-histogram quantiles. Check the existing
   renderers for how the sibling spelled `http_server_request_duration_seconds` and follow the same
   pattern rather than guessing.

   > **Amended during execution (2026-09-21):** the `_bucket` suffix above is wrong. The service
   > exports native (exponential) histograms, which have no `_bucket`, `_sum` or `_count` series, so
   > the quantile queries use the bare metric name `db_pool_wait_duration_seconds` — as the existing
   > renderers do, and as the generator's `CLASSIC_SERIES` test requires by forbidding those
   > suffixes. Ruling R5 in the section "Amended during execution and plan-3 handoff" at the end of this plan.

3. **Mark each output with whether it needs thresholds:**

```js
// Two of the five outputs do not depend on a calibrated threshold, and plan 2
// needs them before calibration happens: classmap.json is route -> class, which
// handlers.js already fixes, and queries.json's attribution keys are built on
// metric names. queries.json gains sli_ratio once thresholds exist. The other
// three bake threshold values into PromQL and k6 assertions, so they stay behind
// the null guard until plan 3 freezes them.
const OUTPUTS = [
  { path: 'infra/grafana/classmap.json', render: renderClassMap, needsThresholds: false },
  { path: 'infra/grafana/queries.json', render: renderQueries, needsThresholds: false },
  { path: 'infra/grafana/locals.tf', render: renderLocals, needsThresholds: true },
  { path: 'infra/grafana/alerts.tf', render: renderAlerts, needsThresholds: true },
  { path: 'infra/k6/tests/lib/slo.js', render: renderK6, needsThresholds: true },
];
```

   Update the CLI's loop for the object shape.

4. **Add `--only-unblocked`.** With it, the CLI validates with `requireThresholds: false`, writes
   only the outputs whose `needsThresholds` is false, and **prints each one it skipped and why**.
   Without it, behaviour is unchanged: full validation, so null thresholds still throw before
   anything is written. `--check` must never accept `--only-unblocked` — it is the guard, and a
   flag that relaxes it would make it decorative.

- [ ] **Step 5: Run the tests**

```bash
npm test -- test/generate-slo.test.js
npm test
```

Both green. The suite was 134 before this task.

- [ ] **Step 6: Generate the two unblocked files, and prove the guard still holds**

```bash
npm run slo:generate -- --only-unblocked
npm run slo:check; echo "EXIT=$?"
```

Expected: the first writes `infra/grafana/classmap.json` and `infra/grafana/queries.json` and reports
the other three as skipped because class thresholds are unset. The second **still exits non-zero
naming `fast` and `threshold_ms`** — capture the exit code from the command itself, not through a
pipe. If `slo:check` now exits 0, the guard was weakened; stop and report it.

- [ ] **Step 7: Commit**

```bash
git add ecs-rds-postgres-pool/service/scripts/generate-slo.js \
        ecs-rds-postgres-pool/service/test/generate-slo.test.js \
        ecs-rds-postgres-pool/infra/grafana/classmap.json \
        ecs-rds-postgres-pool/infra/grafana/queries.json
git commit -m "feat(ecs-rds-postgres-pool): postgres attribution queries and the class map"
```

---

## Task 4: Network

**Files:**
- Create: `ecs-rds-postgres-pool/infra/main/network.tf`

**Interfaces:**
- Consumes: `var.vpc_cidr`, `var.project`, `var.container_port`, `var.aws_account_id`,
  `var.operator_cidr`, and the data sources in `versions.tf`.
- Produces: `aws_vpc.main`, `aws_subnet.public` (count 2), `aws_route_table.public`,
  `aws_security_group.alb`, `aws_security_group.task`, and — new — `aws_security_group.db`.

- [ ] **Step 1: Copy and strip**

```bash
cp ecs-dynamodb-rps/infra/main/network.tf ecs-rds-postgres-pool/infra/main/network.tf
```

Add the fork header. **Delete the `aws_vpc_endpoint "dynamodb"` resource in full.** RDS has no
gateway endpoint — it is an ENI in the VPC — so it is removed rather than translated. Keep
everything else, including the account precondition on `aws_vpc.main` and the comment explaining why
there is no NAT gateway.

- [ ] **Step 2: Add the database security group, matching the sibling's style**

First look at how the sibling declares its `alb` and `task` groups:

```bash
grep -n "ingress\|egress\|aws_vpc_security_group" ecs-dynamodb-rps/infra/main/network.tf
```

If it uses inline `ingress {}` / `egress {}` blocks, write the database group that way. If it uses
separate `aws_vpc_security_group_ingress_rule` resources, use those. **Match the file you copied** —
a file mixing both styles is harder to read, and consistency with the copy matters more than which
style wins. Report which you found.

The group admits exactly two sources on 5432 — the task security group, and `var.operator_cidr` —
with unrestricted egress. Put this comment above it:

```hcl
# The database is reachable from exactly two places: the tasks, and the
# operator's own address. Public accessibility plus a narrow group is a
# deliberate trade: psql during a load-testing session is worth a great deal for
# debugging, and the alternative is a NAT gateway -- both the largest line on the
# bill and the most common teardown survivor.
```

> **Amended during execution (2026-09-21):** "exactly two sources" is one too few. `proxy.tf` (Task 6)
> places RDS Proxy's ENIs in this same group, so without a rule admitting the group itself the proxy
> cannot reach the instance on 5432 and its target stays `UNAVAILABLE` — invisible to `plan`, fatal
> to knob 3. The 5432 ingress now carries `self = true`, and the comment names three sources: the
> tasks, the operator's `/32`, and the group itself (the proxy). Ruling R12 in the section "Amended during execution and plan-3 handoff" at the end of this plan.
>
> **Superseded in review (2026-09-22):** the group now has a single ingress, 5432 from `0.0.0.0/0`,
> which also admits the tasks and the proxy, so the task-group and self rules are gone. The comment
> above the group says both must come back if it is ever narrowed. Ruling R19.

- [ ] **Step 3: Format, validate, commit**

```bash
terraform -chdir=infra/main fmt -check && terraform -chdir=infra/main validate
git add ecs-rds-postgres-pool/infra/main/network.tf
git commit -m "feat(ecs-rds-postgres-pool/terraform): vpc, subnets and security groups"
```

---

## Task 5: The database

**Files:**
- Create: `ecs-rds-postgres-pool/infra/main/rds.tf`

**Interfaces:**
- Consumes: `aws_subnet.public`, `aws_security_group.db` (Task 4); `var.instance_class`,
  `var.allocated_storage`, `var.db_name`, `var.db_username`, `var.log_retention_days`.
- Produces: `aws_db_instance.main`, `random_password.db`, `aws_ssm_parameter.db_password`.

This is the task where `terraform destroy` either leaves the account clean or does not. Every
argument marked as a survivor guard is load-bearing.

- [ ] **Step 1: Find the engine version AWS actually offers**

```bash
aws rds describe-db-engine-versions --engine postgres \
  --query 'DBEngineVersions[?starts_with(EngineVersion, `16.`)].[EngineVersion,DBParameterGroupFamily]' \
  --output text | tail -3
```

Read-only and allowed. Use the major version and parameter-group family it reports; record both in
your report. A version pinned from a guess is a first-apply failure in plan 3.

- [ ] **Step 2: Write `rds.tf`**

Substitute the family from Step 1 if it differs from `postgres16`.

```hcl
# rds.tf
# The instance the whole project is sized around. db.t4g.micro is deliberate:
# its ~112 connection ceiling is what knob 2 aims at, and a larger class would
# raise that ceiling along with memory and take the proxy phase's point away.

resource "random_password" "db" { # REMOVED 2026-09-22 (R19), with the SSM parameter below
  length  = 32
  special = false # URL-safe: it goes into DATABASE_URL verbatim
}

# SecureString rather than Secrets Manager: free, and it deletes immediately.
# Secrets Manager's recovery window is what makes a destroy/re-apply cycle
# collide with "a secret with this name is scheduled for deletion" -- proxy.tf
# has to handle that, because RDS Proxy accepts nothing else.
resource "aws_ssm_parameter" "db_password" {
  name  = "/${var.project}/db/password"
  type  = "SecureString"
  value = random_password.db.result
}

resource "aws_db_subnet_group" "main" {
  name       = var.project
  subnet_ids = aws_subnet.public[*].id
}

# Owned explicitly so terraform destroy takes it. An unmanaged custom parameter
# group is not billable, but it blocks a clean re-apply.
resource "aws_db_parameter_group" "main" {
  name   = var.project # AMENDED 2026-09-22 (R18): name_prefix, or create_before_destroy collides
  family = "postgres16"

  # rds.force_ssl is already 1 in PostgreSQL 15+'s default group. It is restated
  # so the requirement is visible in code rather than inherited silently: the
  # service sets DB_SSL=require and verifies the certificate (src/pool.js).
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Declared explicitly with retention so Terraform owns it. An RDS-created log
# group survives terraform destroy and bills quietly forever.
resource "aws_cloudwatch_log_group" "db_postgresql" {
  name              = "/aws/rds/instance/${var.project}/postgresql"
  retention_in_days = var.log_retention_days
}

resource "aws_db_instance" "main" {
  identifier     = var.project
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.instance_class

  db_name  = var.db_name
  username = var.db_username
  password = random_password.db.result

  allocated_storage = var.allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.main.name

  # Public plus a narrow security group (network.tf). The alternative is a NAT
  # gateway.
  publicly_accessible = true
  multi_az            = false

  # Performance Insights is how the database announces it is the constraint, via
  # DBLoadRelativeToNumVCPUs. It IS available on db.t4g.micro for PostgreSQL --
  # the widely repeated exclusion is a MySQL and MariaDB restriction, because the
  # feature leans on PERFORMANCE_SCHEMA there. If the first apply refuses it
  # anyway, the named fallback is db.t4g.medium, and the connection arithmetic
  # the knob sequence depends on has to be redone against the new ceiling.
  performance_insights_enabled          = true
  performance_insights_retention_period = 7 # the free tier

  enabled_cloudwatch_logs_exports = ["postgresql"]

  # --- teardown survivor guards: every one is load-bearing ---
  skip_final_snapshot      = true
  backup_retention_period  = 0
  delete_automated_backups = true
  deletion_protection      = false
  apply_immediately        = true

  depends_on = [aws_cloudwatch_log_group.db_postgresql]
}
```

- [ ] **Step 3: Format, validate, commit**

```bash
terraform -chdir=infra/main fmt -check && terraform -chdir=infra/main validate
git add ecs-rds-postgres-pool/infra/main/rds.tf
git commit -m "feat(ecs-rds-postgres-pool/terraform): rds instance with teardown guards"
```

---

## Task 6: The proxy, count-gated, and the host switch

**Files:**
- Create: `ecs-rds-postgres-pool/infra/main/proxy.tf`

**Interfaces:**
- Consumes: `aws_db_instance.main`, `random_password.db` (Task 5); `aws_subnet.public`,
  `aws_security_group.db` (Task 4); `var.proxy_enabled`, `var.db_username`, `var.db_name`.
- Produces: **`local.db_host` and `local.database_url`**, which Task 8 puts in the container
  environment. This is the whole point of the task: flipping `proxy_enabled` must change where the
  service connects with no code change, image rebuild or redeploy.

- [ ] **Step 1: Write `proxy.tf`**

```hcl
# proxy.tf
# KNOB 3. Everything here is count-gated, so it exists in code and costs nothing
# until var.proxy_enabled flips -- which is what keeps plan 4 free of
# implementation work.
#
# The pre-registered expectation, written before any run so a null result is a
# published result rather than a disappointment: against four long-lived ECS
# tasks holding warm pools, connection count at the instance falls well below
# knob 2's level and session pinning stays near zero; p95 rises by a millisecond
# or two from the extra hop; SLO attainment is unchanged or marginally worse
# UNLESS knob 2 actually breached the connection ceiling, in which case
# availability recovers -- and that is the whole finding.

# RDS Proxy accepts only Secrets Manager, not SSM. recovery_window_in_days = 0 is
# MANDATORY in a lab destroyed daily: the default 7-30 day window makes the next
# apply fail with "a secret with this name is scheduled for deletion".
resource "aws_secretsmanager_secret" "db" {
  count                   = var.proxy_enabled ? 1 : 0
  name                    = "${var.project}-db"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "db" {
  count     = var.proxy_enabled ? 1 : 0
  secret_id = aws_secretsmanager_secret.db[0].id
  secret_string = jsonencode({
    username = var.db_username
    password = random_password.db.result
  })
}

data "aws_iam_policy_document" "proxy_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "proxy" {
  count              = var.proxy_enabled ? 1 : 0
  name               = "${var.project}-proxy"
  assume_role_policy = data.aws_iam_policy_document.proxy_assume.json
}

resource "aws_iam_role_policy" "proxy" {
  count = var.proxy_enabled ? 1 : 0
  role  = aws_iam_role.proxy[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = aws_secretsmanager_secret.db[0].arn
    }]
  })
}

resource "aws_db_proxy" "main" {
  count                  = var.proxy_enabled ? 1 : 0
  name                   = var.project
  engine_family          = "POSTGRESQL"
  role_arn               = aws_iam_role.proxy[0].arn
  vpc_subnet_ids         = aws_subnet.public[*].id
  vpc_security_group_ids = [aws_security_group.db.id]
  require_tls            = true

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = aws_secretsmanager_secret.db[0].arn
  }
}

resource "aws_db_proxy_default_target_group" "main" {
  count         = var.proxy_enabled ? 1 : 0
  db_proxy_name = aws_db_proxy.main[0].name
}

resource "aws_db_proxy_target" "main" {
  count                  = var.proxy_enabled ? 1 : 0
  db_proxy_name          = aws_db_proxy.main[0].name
  target_group_name      = aws_db_proxy_default_target_group.main[0].name
  db_instance_identifier = aws_db_instance.main.identifier
}

locals {
  # THE SWITCH. Releasing knob 3 is an edit to dev.tfvars and an apply -- no code
  # change, no image rebuild, no redeploy. src/pool.js trusts both certificate
  # chains this can lead to (the RDS CA for the instance, Amazon's public roots
  # for the proxy), so flipping it cannot fail TLS.
  db_host = var.proxy_enabled ? aws_db_proxy.main[0].endpoint : aws_db_instance.main.address

  # The password is interpolated here rather than injected as a container secret
  # because the service takes one DATABASE_URL and nothing else. It therefore
  # lands in the task definition, readable by anyone with
  # ecs:DescribeTaskDefinition. Acceptable in a lab whose database holds
  # generated rows and is destroyed daily; not acceptable anywhere else, which is
  # why this comment exists rather than being absent.
  database_url = "postgresql://${var.db_username}:${random_password.db.result}@${local.db_host}:5432/${var.db_name}"
}
```

> **Amended during execution (2026-09-21):** `proxy.tf` also declares
> `aws_cloudwatch_log_group.proxy` — `count = var.proxy_enabled ? 1 : 0`, name
> `/aws/rds/proxy/${var.project}`, `retention_in_days = var.log_retention_days` — and
> `aws_db_proxy.main` depends on it. Left alone, RDS creates the proxy's log group itself, untagged
> (so the `Project` tag sweep cannot find it) and never-expiring (so it survives teardown): the same
> survivor `rds.tf` guards against for the instance. The path is confirmed at the first knob-3 apply.
> Ruling R13 in the section "Amended during execution and plan-3 handoff" at the end of this plan.

- [ ] **Step 2: Format, validate, commit**

The two-state check — that flipping the knob adds the proxy and changes `DATABASE_URL` — needs
`dev.tfvars` and a real plan, so it is Task 17 Step 4. Here, validate only.

```bash
terraform -chdir=infra/main fmt -check && terraform -chdir=infra/main validate
git add ecs-rds-postgres-pool/infra/main/proxy.tf
git commit -m "feat(ecs-rds-postgres-pool/terraform): count-gated rds proxy and the host switch"
```

---

## Task 7: ECR and the load balancer

**Files:**
- Create: `ecs-rds-postgres-pool/infra/main/ecr.tf`, `alb.tf`

**Interfaces:**
- Consumes: `aws_subnet.public`, `aws_security_group.alb` (Task 4).
- Produces: `aws_ecr_repository.app`, `aws_lb.main`, `aws_lb_target_group.app`,
  `aws_lb_listener.http`.

- [ ] **Step 1: Copy both verbatim**

```bash
cp ecs-dynamodb-rps/infra/main/ecr.tf ecs-rds-postgres-pool/infra/main/ecr.tf
cp ecs-dynamodb-rps/infra/main/alb.tf ecs-rds-postgres-pool/infra/main/alb.tf
```

Add the fork header to each and change nothing else. Both are parameterised on `var.project` and
`var.container_port`.

**Verify one number rather than assuming it.** `alb.tf` should set `idle_timeout = 60`, and plan 1's
`src/server.js` sets `keepAliveTimeout = 65_000` and `headersTimeout = 66_000` specifically to exceed
it. Confirm the value and record it. If the two ever drift apart the ALB can dispatch a request onto
a connection Node is closing — a 502 the service never caused, burning availability budget it never
spent.

- [ ] **Step 2: Format, validate, commit**

```bash
terraform -chdir=infra/main fmt -check && terraform -chdir=infra/main validate
git add ecs-rds-postgres-pool/infra/main/ecr.tf ecs-rds-postgres-pool/infra/main/alb.tf
git commit -m "feat(ecs-rds-postgres-pool/terraform): ecr repository and load balancer"
```

---

## Task 8: The ECS service and the collector

**Files:**
- Create: `ecs-rds-postgres-pool/infra/main/ecs.tf`
- Create: `ecs-rds-postgres-pool/infra/main/collector.tf`
- Create: `ecs-rds-postgres-pool/infra/grafana/alloy.alloy.tftpl`

**Interfaces:**
- Consumes: Tasks 3–7, especially `local.database_url` (Task 6) and `classmap.json` (Task 3).
- Produces: `aws_ecs_cluster.main`, `aws_ecs_service.app`, `aws_ecs_task_definition.app`,
  `aws_iam_role.task`, `aws_iam_role.execution`,
  `aws_service_discovery_private_dns_namespace.internal`, the collector service,
  `local.metrics_namespace`, `local.metrics_service_name`.

**These three files land together because they reference each other.** The service's
`OTLP_ENDPOINT` names the collector's Cloud Map namespace; the collector runs on the cluster and
execution role `ecs.tf` declares. Split across two tasks, neither validates.

- [ ] **Step 1: Copy all three**

```bash
mkdir -p ecs-rds-postgres-pool/infra/grafana
cp ecs-dynamodb-rps/infra/main/ecs.tf ecs-rds-postgres-pool/infra/main/ecs.tf
cp ecs-dynamodb-rps/infra/main/collector.tf ecs-rds-postgres-pool/infra/main/collector.tf
cp ecs-dynamodb-rps/infra/grafana/alloy.alloy.tftpl ecs-rds-postgres-pool/infra/grafana/alloy.alloy.tftpl
```

Add the fork header to each — `#` for the `.tf` files, `//` for the Alloy template.

- [ ] **Step 2: Replace the container environment block in `ecs.tf`**

The sibling's block is a `concat([...], var.shedding_enabled ? [...] : [])` carrying `TABLE_NAME`,
`PBKDF2_ITERATIONS` and a conditional `SHED_ELU_THRESHOLD`. Replace the whole expression with:

```hcl
# Every name here is fixed by plan 1's environment-variable contract
# (service/src/config.js). A typo is not a validate error -- it is a default
# silently standing in for the value Terraform meant to set.
environment = [
  { name = "PORT", value = tostring(var.container_port) },
  { name = "AWS_REGION", value = data.aws_region.current.region },

  # The whole connection, password included. local.db_host is what knob 3
  # switches between the instance and the proxy (proxy.tf).
  { name = "DATABASE_URL", value = local.database_url },
  { name = "DB_SSL", value = "require" },

  # KNOB 1.
  { name = "POOL_MAX", value = tostring(var.pool_size) },
  { name = "POOL_CONNECTION_TIMEOUT_MS", value = tostring(var.pool_connection_timeout_ms) },

  # config.js's flag() is `env[key] === '1'`, and its num() treats '' as absent.
  # "0" would read as truthy to anyone skimming this and is not what the service
  # checks, so false is the empty string.
  { name = "MIGRATE_ON_BOOT", value = var.migrate_on_boot ? "1" : "" },
  { name = "SEED_ON_BOOT", value = var.seed_on_boot ? "1" : "" },
  { name = "SEED_ROWS", value = tostring(var.seed_rows) },
  { name = "SEED_FEEDS", value = tostring(var.seed_feeds) },

  { name = "FEED_PAGE_SIZE", value = tostring(var.feed_page_size) },

  # THE CALIBRATED COST KNOB. 0 until plan 3 measures it.
  { name = "REPORT_SCAN_ROWS", value = tostring(var.report_scan_rows) },

  { name = "OTLP_ENDPOINT", value = "http://collector.${aws_service_discovery_private_dns_namespace.internal.name}:4318" },
  { name = "METRICS_NAMESPACE", value = local.metrics_namespace },
  { name = "OTEL_SERVICE_NAME", value = local.metrics_service_name },

  # OTEL_SERVICE_INSTANCE_ID is DELIBERATELY ABSENT. The service resolves it from
  # the ECS task metadata endpoint; its last-resort fallback is
  # local-${process.pid}, and Node is pid 1 in every container. Setting a
  # constant here would collapse every task onto one series -- the exact failure
  # the attribute exists to prevent. It is an escape hatch, not something to wire.
]
```

- [ ] **Step 3: Replace the task-role policy in `ecs.tf`**

The sibling's `data "aws_iam_policy_document" "table_access"` has two statements. **Delete the
DynamoDB statement** — Postgres authenticates with the password in `DATABASE_URL`, not with IAM, so
there is nothing to translate it into. **Keep the `cloudwatch:PutMetricData` statement
byte-for-byte**, including its namespace condition: `src/cloudwatch.js` is a verbatim fork and
publishes the same `EventLoopUtilization` metric.

Rename the document and its `aws_iam_role_policy` from `table_access` to `task_metrics`, since it
no longer grants table access to anything.

- [ ] **Step 4: Confirm `desired_count` is Terraform's alone**

```bash
grep -n "ignore_changes\|desired_count" ecs-rds-postgres-pool/infra/main/ecs.tf
```

If the service carries `lifecycle { ignore_changes = [desired_count] }` — the usual accommodation
for an autoscaler — **remove it**. This project's measurement depends on `desired_count` being a
fixed number Terraform owns, so every run is one deterministic configuration. Report what you found.

- [ ] **Step 5: Strip pipeline 2 from the Alloy template**

Delete these three blocks in full, together with the `// === Pipeline 2` banner above them:

```
prometheus.exporter.cloudwatch "aws" { … }
prometheus.scrape "cloudwatch" { … }
prometheus.remote_write "grafana_cloud" { … }
```

Keep everything under `// === Pipeline 1`: the OTLP receiver, the `transform "classify"` processor
stamping `class` from `${class_statements}`, the batch processor, `otelcol.auth.basic` and
`otelcol.exporter.otlphttp`. Then add, below pipeline 1, so the next reader does not go looking:

```
// Pipeline 2 -- a prometheus.exporter.cloudwatch scraping DynamoDB's
// SuccessfulRequestLatency -- is deliberately absent. It existed to subtract the
// datastore's own server-side clock from the service's db histogram. Postgres
// publishes no per-operation server-side latency, so there is nothing to
// subtract; queue depth is measured directly instead, as db.pool.wait.duration
// per class. Dropping it also removes the tag:GetResources grant and the
// per-minute GetMetricData charge.
```

- [ ] **Step 6: Strip the CloudWatch reader from `collector.tf`**

Delete, in full:

- the CloudWatch-read IAM policy document and the `aws_iam_role_policy` attaching it;
- the two SSM `SecureString` parameters for the Grafana **Prom** username and password, the
  execution role's `ssm:GetParameters` statement covering them, and their `secrets` entries in the
  collector container definition;
- any `PROM_URL` / `PROM_USERNAME` / `PROM_PASSWORD` in the collector's `environment` or `secrets`.

**Keep the OTLP pair** — pipeline 1 authenticates with those. Keep `locals.alloy_class_statements`
and `locals.alloy_config` exactly as they are; they read `../grafana/classmap.json`, which Task 3
generated.

- [ ] **Step 7: Format, validate, commit**

```bash
terraform -chdir=infra/main fmt -check && terraform -chdir=infra/main validate
git add ecs-rds-postgres-pool/infra/main/ecs.tf \
        ecs-rds-postgres-pool/infra/main/collector.tf \
        ecs-rds-postgres-pool/infra/grafana/alloy.alloy.tftpl
git commit -m "feat(ecs-rds-postgres-pool/terraform): ecs service and otlp collector"
```

---

## Task 9: The heartbeat

**Files:**
- Create: `ecs-rds-postgres-pool/infra/main/heartbeat.tf`
- Create: `ecs-rds-postgres-pool/heartbeat/index.mjs`

**Interfaces:**
- Consumes: `aws_lb.main` (Task 7), `var.heartbeat_enabled`, `var.heartbeat_rate`.
- Produces: `aws_lambda_function.heartbeat` — the traffic that keeps every class's SLI series alive
  between load tests, which Task 12's rule watches.

- [ ] **Step 1: Copy both**

```bash
mkdir -p ecs-rds-postgres-pool/heartbeat
cp ecs-dynamodb-rps/infra/main/heartbeat.tf ecs-rds-postgres-pool/infra/main/heartbeat.tf
cp ecs-dynamodb-rps/heartbeat/index.mjs ecs-rds-postgres-pool/heartbeat/index.mjs
```

Add fork headers. `heartbeat.tf` needs no other change — it zips `../../heartbeat` at plan time and
passes `BASE_URL` from the ALB.

- [ ] **Step 2: Confirm the ids the seed produces**

Read `ecs-rds-postgres-pool/service/prisma/seed.js`. Confirm that feed id 1 exists and that a post
with id 1 is inserted. A heartbeat that 404s on every beat keeps the *request* series alive but
records a permanent miss against the availability objective — poisoning the baseline this project is
built to measure.

- [ ] **Step 3: Replace the route list**

The sibling's four routes are DynamoDB's (`/items/…`, `/feeds/feed-00`). Replace them to match
`service/src/handlers.js`'s `ROUTE_CLASS`, using the ids Step 2 confirmed:

```js
// One route per latency class, so the SLI series for every class stays alive
// between load tests -- infra/grafana/canary.tf alerts when one goes absent.
// Feed 1 and post 1 exist because prisma/seed.js numbers feeds from 1 and inserts
// posts with an autoincrement primary key starting at 1.
const ROUTES = [
  { route: '/posts/1', method: 'GET' }, // fast     -> getPost
  { route: '/feeds/1/posts', method: 'GET' }, // standard -> feed
  { route: '/posts', method: 'POST', body: '{}' }, // fast     -> createPost
  { route: '/reports', method: 'POST', body: '{"feedId":1}' }, // heavy    -> report
];
```

Leave `USER_AGENT = 'heartbeat/1.0'` alone. `src/otel.js`'s `trafficSource()` maps that prefix to
`heartbeat`, and changing it would reclassify this traffic in the SLO population.

- [ ] **Step 4: Format, validate, commit**

```bash
terraform -chdir=infra/main fmt -check && terraform -chdir=infra/main validate
git add ecs-rds-postgres-pool/infra/main/heartbeat.tf ecs-rds-postgres-pool/heartbeat/
git commit -m "feat(ecs-rds-postgres-pool): heartbeat lambda against the four routes"
```

---

## Task 10: The Grafana module and the dashboard

**Files:**
- Create: `ecs-rds-postgres-pool/infra/grafana/versions.tf`, `variables.tf`, `folder.tf`
- Create: `ecs-rds-postgres-pool/infra/grafana/dashboard.json.tftpl`
- Create: `ecs-rds-postgres-pool/infra/main/grafana.tf`

**Interfaces:**
- Consumes: `queries.json` (Task 3); `aws_lb.main`, `aws_lb_target_group.app` (Task 7).
- Produces: `module.grafana`, `grafana_folder.project`, `grafana_dashboard.attribution`. Task 11
  and plan 3's generated `alerts.tf` reference `grafana_dashboard.attribution.uid`.

- [ ] **Step 1: Copy the three small files**

```bash
for f in versions.tf variables.tf folder.tf; do
  cp ecs-dynamodb-rps/infra/grafana/$f ecs-rds-postgres-pool/infra/grafana/$f
done
```

Add fork headers. `folder.tf` looks up the shared root folder by a literal title. **Open the sibling
and copy that literal character for character — do not retype it.** The folder is created by
`platform/` and found by a fixed string, never by reading `platform`'s state; a typo produces a plan
proposing a second root folder.

- [ ] **Step 2: Write `infra/main/grafana.tf`, calling only the Grafana module for now**

```bash
cp ecs-dynamodb-rps/infra/main/grafana.tf ecs-rds-postgres-pool/infra/main/grafana.tf
```

Add the fork header, then **remove the `module "k6"` block** — `../k6` does not exist until Task 13,
which adds it back. Keep `provider "grafana" {}` and the `module "grafana"` block, including the
comment explaining why the ALB suffixes are passed from live resources rather than hardcoded.

- [ ] **Step 3: Copy the dashboard template and rework its rows**

```bash
cp ecs-dynamodb-rps/infra/grafana/dashboard.json.tftpl ecs-rds-postgres-pool/infra/grafana/dashboard.json.tftpl
```

The sibling has seven rows. What happens to each:

| # | sibling row | action |
|---|---|---|
| 1 | `1. Latency and DynamoDB throttling` | retitle `1. Latency and database load`; replace its throttle panel with `DBLoad relative to vCPUs` |
| 2 | `2. DynamoDB server-side latency (the uncontaminated clock)` | **delete the row** — pipeline 2 is gone; there is nothing to plot |
| 3 | `3. Capacity headroom …` (RCU/WCU panels) | replace both panels: `Connections vs the connection ceiling`, and `CPU credits: balance and surplus charged` |
| — | *(new, after row 3)* | **insert `3b. The pool — what this project exists to measure`**: pool wait p99 by class; pool wait split by `pool.opened`; the waiting / idle / total gauges |
| 4 | `4. Service (ECS) …` | copy unchanged |
| 5 | `5. Edge (ALB) …` | copy unchanged |
| 6 | `6. Service SLI …` | keep the row and **keep the SLI panel's `id`**, but replace its query with a text panel reading *"The SLI query arrives when plan 3 freezes the class thresholds (slo.yaml)."* (D2) |
| 7 | `7. Derived panels …` | keep `CPU saturation` and `Event-loop delay p99`; **delete** `DB wall-clock vs DynamoDB's own clock` and `Queueing delay by route` |

Two rules that make this work rather than merely look right:

- **Every `${…}` in the template must be a key `folder.tf` passes to `templatefile()`** — the keys of
  `queries.json` merged with the datasource UIDs, ALB suffixes and `project`. A reference to a
  deleted key like `queueing_ms_by_route`, or to `sli_ratio` before thresholds exist, is a plan-time
  error. The new pool panels use the keys Task 3 emitted; do not inline PromQL.
- **Record the SLI panel's id in your report.** Plan 3's generated burn-rate rules will carry a
  `__panelId__` pointing at it.

- [ ] **Step 4: Format, validate, commit**

```bash
terraform -chdir=infra/main fmt -check && terraform -chdir=infra/main validate
git add ecs-rds-postgres-pool/infra/grafana/ ecs-rds-postgres-pool/infra/main/grafana.tf
git commit -m "feat(ecs-rds-postgres-pool/grafana): folder and dashboard with the pool row"
```

---

## Task 11: Saturation rules

**Files:**
- Create: `ecs-rds-postgres-pool/infra/grafana/saturation.tf`
- Modify: `ecs-rds-postgres-pool/infra/grafana/variables.tf`
- Modify: `ecs-rds-postgres-pool/infra/main/variables.tf`, `infra/main/grafana.tf`

**Interfaces:**
- Consumes: `var.project`, `var.cloudwatch_datasource_uid`, `grafana_dashboard.attribution.uid`.
- Produces: `grafana_rule_group.saturation`, replacing the sibling's `throttles.tf`; and three new
  module inputs — `proxy_enabled`, `max_connections_alert`, `proxy_borrow_latency_threshold` —
  declared in both modules and passed through `grafana.tf`.

- [ ] **Step 1: Read the sibling's `throttles.tf` and keep its structure**

```bash
cat ecs-dynamodb-rps/infra/grafana/throttles.tf
```

What you are porting is its structure, not its metrics. Three properties are load-bearing, and
every rule below keeps them:

- **One rule per metric, never a math expression across two queries.** CloudWatch publishes these
  sparsely — a quiet minute produces *no datapoint*, not a zero — so a combined `$A + $B` goes
  `NO DATA` the moment either side is empty, which is exactly during the incident you wanted to
  catch.
- **`no_data_state = "OK"`.** No datapoint means no load, which is healthy.
- **A 300-second lookback against a 60-second period, and `reduce(last)`** rather than an average,
  to absorb CloudWatch's publishing lag.

> **Amended during execution (2026-09-21):** the credit rule is the exception — it uses a 300-second
> period and a 600-second lookback. T-class credit metrics publish every 5 minutes, so a 300-second
> window over them is usually empty, and `no_data_state = "OK"` would turn that into a rule that never
> fires. The other four rules keep 60 / 300. Ruling R9 in the section "Amended during execution and plan-3 handoff" at the end of this plan.

- [ ] **Step 2: Add the inputs**

In `infra/grafana/variables.tf`:

```hcl
variable "proxy_enabled" {
  description = "Mirrors the root module's knob 3. The two proxy rules exist only while the proxy does, so they do not sit in NO DATA permanently."
  type        = bool
}

variable "max_connections_alert" {
  description = "DatabaseConnections above this fires the ceiling rule. Derived, not measured: knob 2 runs 25 x 4 = 100 connections against an instance ceiling ESTIMATED at ~112 from Postgres's documented default formula. Confirm the real ceiling with SHOW max_connections on the instance before knob 2, and re-derive this from it."
  type        = number
}

variable "proxy_borrow_latency_threshold" {
  description = "Fires the borrow-latency rule above this value. NULL BY DEFAULT ON PURPOSE: the metric's unit is not reliably documented -- AWS gives a sibling proxy metric in microseconds while community reports discuss borrow latency in milliseconds, and a 1000x error is silent and looks like a spectacular result. Confirm the unit in the CloudWatch console on the real proxy, then set this. Knob 3 refuses to plan until it is set."
  type        = number
  default     = null
}
```

Declare the same three in `infra/main/variables.tf` — `max_connections_alert` with
`default = 100` and the same description, the other two as above — and pass all three through the
`module "grafana"` block in `infra/main/grafana.tf`, with `proxy_enabled = var.proxy_enabled`.

- [ ] **Step 3: Write `saturation.tf`**

Five rules in one `grafana_rule_group.saturation`, each following the sibling's
`A: cloudwatch query → B: reduce(last) → C: threshold` chain exactly, changing only `namespace`,
`metricName`, `dimensions`, `statistic` and the threshold. Keep the sibling's CloudWatch `region`
exactly as it is written there.

| rule | metric | dimensions | fires when | why it matters |
|---|---|---|---|---|
| `Database CPU saturated` | `DBLoadRelativeToNumVCPUs` | `{ DBInstanceIdentifier = var.project }` | `> 1` | above 1, more sessions are runnable than the instance has vCPUs — the database saying it is the constraint |
| `Connections near the ceiling` | `DatabaseConnections` | `{ DBInstanceIdentifier = var.project }` | `> var.max_connections_alert` | `FATAL: sorry, too many clients already` is a 5xx and burns the availability budget; knob 2 drives straight at it |
| `Burst credits exhausted` | `CPUSurplusCreditsCharged` | `{ DBInstanceIdentifier = var.project }` | `> 0` | see below |
| `Proxy borrow latency high` | `DatabaseConnectionsBorrowLatency` | `{ ProxyName = var.project }` | `> var.proxy_borrow_latency_threshold` | knob 3 only |
| `Proxy sessions pinned` | `DatabaseConnectionsCurrentlySessionPinned` | `{ ProxyName = var.project }` | `> 0` | a proxy with everything pinned is a passthrough measuring nothing |

All metrics are namespace `AWS/RDS`.

**Why the credit rule watches surplus charges, not the balance.** RDS T-class instances run in
*unlimited* credit mode, and that cannot be changed from Terraform — the attribute does not exist on
`aws_db_instance` at all. In unlimited mode an empty balance does not throttle the CPU; it starts
charging surplus credits instead. So a threshold on `CPUCreditBalance` would be a number picked out
of the air, while `CPUSurplusCreditsCharged > 0` is exactly the event that disqualifies a run: the
instance ran past its burst budget, and its CPU during that run is not the CPU of the next one.

> **Amended during execution (2026-09-21):** the rule (and dashboard panel 27) watch
> `CPUSurplusCreditBalance > 0`, not `CPUSurplusCreditsCharged > 0` as the table above says. The
> intent stands — catch the instance running past its burst budget — but Charged becomes non-zero
> only once surplus credits outlive 24 hours of earning, or when the instance is terminated, so on a
> lab instance destroyed daily it stays 0 through the very event. The surplus balance rises the
> moment surplus is spent. The spec's run gate carries the same forward-pointer. Ruling R8 in
> the section "Amended during execution and plan-3 handoff" at the end of this plan.

**Gating the two proxy rules.** Grafana rules live inside the one rule-group resource, so they cannot
each take a `count`. Build the rule list with a `dynamic "rule"` block over a local that includes the
two proxy rules only when `var.proxy_enabled` is true. Then guard the threshold:

```hcl
  lifecycle {
    precondition {
      condition     = !var.proxy_enabled || var.proxy_borrow_latency_threshold != null
      error_message = "proxy_enabled is true but proxy_borrow_latency_threshold is unset. Confirm the unit of DatabaseConnectionsBorrowLatency in the CloudWatch console on the real proxy first -- a 1000x unit error is silent and looks like a spectacular result."
    }
  }
```

That is what makes knob 3 refuse to plan without the value, while the baseline plans cleanly.

- [ ] **Step 4: Format, validate, commit**

```bash
terraform -chdir=infra/main fmt -check && terraform -chdir=infra/main validate
git add ecs-rds-postgres-pool/infra/grafana/ ecs-rds-postgres-pool/infra/main/variables.tf \
        ecs-rds-postgres-pool/infra/main/grafana.tf
git commit -m "feat(ecs-rds-postgres-pool/grafana): database and proxy saturation rules"
```

---

## Task 12: The SLI-absent rule

**Files:**
- Create: `ecs-rds-postgres-pool/infra/grafana/canary.tf`

**Interfaces:**
- Consumes: `var.project`, `var.prometheus_datasource_uid`.
- Produces: `grafana_rule_group.sli_absent`.

This is decision D1.

- [ ] **Step 1: Copy and check it is parameterised**

```bash
cp ecs-dynamodb-rps/infra/grafana/canary.tf ecs-rds-postgres-pool/infra/grafana/canary.tf
grep -n 'job=\|ecs-dynamodb-rps' ecs-rds-postgres-pool/infra/grafana/canary.tf
```

Add the fork header. The query should read `job="${var.project}"`. If any `job=` label is the
literal `ecs-dynamodb-rps`, replace it with the interpolation and report it.

Keep `no_data_state = "OK"`. It reads backwards until you see why: `absent_over_time` *returning a
value* is the alarm, so no data from this query means the series exists and all is well.

- [ ] **Step 2: Rewrite the comment for this project's chain**

The sibling's comment names the chain the rule watches. Rewrite it so it is true here — heartbeat
Lambda → the service's OTLP export → the Alloy collector → Grafana Cloud ingest — and add:

```hcl
# An empty panel and a healthy system look identical, and this project's entire
# deliverable is a before/after table read off these panels. A run that produced
# no data, mistaken for a run that produced good numbers, is the worst outcome
# available -- worse than a failed run, which at least announces itself.
```

- [ ] **Step 3: Format, validate, commit**

```bash
terraform -chdir=infra/main fmt -check && terraform -chdir=infra/main validate
git add ecs-rds-postgres-pool/infra/grafana/canary.tf
git commit -m "feat(ecs-rds-postgres-pool/grafana): alert when the sli series goes absent"
```

---

## Task 13: The k6 module and the load profiles

**Files:**
- Create: `ecs-rds-postgres-pool/infra/k6/{main,outputs,variables,versions}.tf`
- Create: `ecs-rds-postgres-pool/infra/k6/tests/{discovery,constant,stress}.js`
- Create: `ecs-rds-postgres-pool/infra/k6/tests/lib/{request,env,mix}.js`
- Create: `ecs-rds-postgres-pool/scripts/upload-k6.sh`
- Modify: `ecs-rds-postgres-pool/infra/main/grafana.tf` — add the `module "k6"` block back

**Interfaces:**
- Consumes: `var.project`.
- Produces: `module.k6`, `grafana_k6_project.this`, the `k6_project_id` output. **The three profiles
  will not run until plan 3**, because `tests/lib/slo.js` is generated from thresholds (D2) — state
  that in your report rather than working around it.

- [ ] **Step 1: Copy the Terraform files and the upload script**

```bash
mkdir -p ecs-rds-postgres-pool/infra/k6/tests/lib ecs-rds-postgres-pool/scripts
for f in main.tf outputs.tf variables.tf versions.tf; do
  cp ecs-dynamodb-rps/infra/k6/$f ecs-rds-postgres-pool/infra/k6/$f
done
cp ecs-dynamodb-rps/scripts/upload-k6.sh ecs-rds-postgres-pool/scripts/upload-k6.sh
```

Add fork headers. `upload-k6.sh` derives the project name from its own directory — find that line
and quote it in your report as evidence it needs no edit.

`main.tf` warns that the real upload cap is 100 VUs per test, enforced at the subscription level and
not raisable from Terraform. Keep that comment; this project inherits the cap.

- [ ] **Step 2: Wire the module**

In `infra/main/grafana.tf`, add back the block Task 10 removed:

```hcl
# Creates this project's k6 project, so /env down destroys it -- along with the
# load tests uploaded into it and its run history. Re-upload after every /env up.
module "k6" {
  source = "../k6"

  project = var.project
}
```

- [ ] **Step 3: Copy the profiles and change routes and names**

```bash
for f in discovery.js constant.js stress.js; do
  cp ecs-dynamodb-rps/infra/k6/tests/$f ecs-rds-postgres-pool/infra/k6/tests/$f
done
for f in request.js env.js mix.js; do
  cp ecs-dynamodb-rps/infra/k6/tests/lib/$f ecs-rds-postgres-pool/infra/k6/tests/lib/$f
done
```

In each profile, change `cloud.name` from `'ecs-dynamodb-rps <shape>'` to
`'ecs-rds-postgres-pool <shape>'`.

In `tests/lib/request.js`, keep the kind → class map and change the four calls. They become
`GET /posts/${id}`, `POST /posts` with body `'{}'`, `GET /feeds/${feed}/posts`, and `POST /reports`
with body `{"feedId": <feed>}`. Choose ids inside the seeded range — feeds numbered from 1 up to
`seed_feeds`, posts from 1 — and put this above the map:

```js
// Kind -> class. This MUST agree with src/handlers.js's ROUTE_CLASS and with
// infra/grafana/classmap.json: all three are one mapping written down three
// times, and test/generate-slo.test.js asserts two of them against each other.
// An id outside the seeded range returns 404, which the availability objective
// counts as good -- and which measures nothing.
```

- [ ] **Step 4: Make the VU-sizing input explicit instead of inherited**

All three profiles size `preAllocatedVUs` with a constant derived from the sibling's mean latency at
the SLO boundary — computed from *its* thresholds and *its* mix. This project's thresholds are null
until plan 3, so that constant cannot be derived yet. **Do not carry the sibling's number across.**
Replace it in each profile:

```js
// Little's law: VUs = rate x mean latency. The mean derives from the class
// thresholds and the mix, and this project's thresholds are unset until plan 3
// calibrates them (slo.yaml). The sibling's constant would size every run
// against a workload with different costs, so until then this is explicit: pass
// -e MEAN_SECONDS=... or the profile refuses to start.
const MEAN_SECONDS = Number(__ENV.MEAN_SECONDS);
if (!Number.isFinite(MEAN_SECONDS) || MEAN_SECONDS <= 0) {
  throw new Error('MEAN_SECONDS is required until plan 3 freezes the class thresholds; see slo.yaml');
}
```

- [ ] **Step 5: Keep `mix.js`'s shape and mark its content provisional**

The sibling's deterministic 20-slot cycle encodes 55/15/25/5, and `slo.yaml` declares the same
ratios — but the spec says the mix is re-derived for the SQL workload, so the match is a starting
point, not a confirmation. Keep the file and add:

```js
// These ratios match slo.yaml's capacity.mix today, but that is a starting point
// rather than a decision: the mix is to be re-derived for the SQL workload rather
// than inherited from DynamoDB's cost model. Plan 3 confirms or changes it once
// hold times are measured. Deterministic rather than random, so two runs issue
// the same request sequence.
```

- [ ] **Step 6: Format, validate, commit**

```bash
terraform -chdir=infra/main fmt -check && terraform -chdir=infra/main validate
git add ecs-rds-postgres-pool/infra/k6/ ecs-rds-postgres-pool/scripts/upload-k6.sh \
        ecs-rds-postgres-pool/infra/main/grafana.tf
git commit -m "test(ecs-rds-postgres-pool/k6): project, profiles and the four sql routes"
```

---

## Task 14: The deploy script

**Files:**
- Create: `ecs-rds-postgres-pool/scripts/deploy-service.sh`

**Interfaces:**
- Consumes: the `ecr_repository_url`, `cluster_name`, `service_name` and `base_url` outputs (Task 16).
- Produces: an executable that builds, pushes, forces a new deployment and waits for stability.

- [ ] **Step 1: Copy and remove the seed step**

```bash
cp ecs-dynamodb-rps/scripts/deploy-service.sh ecs-rds-postgres-pool/scripts/deploy-service.sh
chmod +x ecs-rds-postgres-pool/scripts/deploy-service.sh
```

Add the fork header. Then:

- **Delete step 4, the seed block, in full**, together with `--skip-seed` and the `TABLE` /
  `TABLE_NAME` variables. There is no script-driven seed here: the service seeds itself at boot when
  `SEED_ON_BOOT` is set.
- **Remove `table_name` from the outputs read in step 1.** This project has no such output.
- Add to the closing summary: a fresh database needs one apply with `seed_on_boot = true` at
  `desired_count = 1`, and the flag must go back to `false` before scaling out — the seed is not
  idempotent, and four tasks would insert four times the rows.

Keep steps 2, 3 and 5 as they are. The explicit `docker build --platform linux/amd64` is what
prevents the arm64/amd64 mismatch the sibling's README records surfacing as a
`CannotPullContainerError` at task start rather than at build.

- [ ] **Step 2: Confirm it contains no apply, and that it parses**

```bash
grep -n "terraform apply\|terraform destroy" ecs-rds-postgres-pool/scripts/deploy-service.sh || echo "no apply: ok"
bash -n ecs-rds-postgres-pool/scripts/deploy-service.sh && echo "syntax ok"
```

- [ ] **Step 3: Commit**

```bash
git add ecs-rds-postgres-pool/scripts/deploy-service.sh
git commit -m "feat(ecs-rds-postgres-pool): deploy script without the seed step"
```

---

## Task 15: Verify the database certificate

**Files:**
- Modify: `ecs-rds-postgres-pool/service/src/pool.js`
- Modify: `ecs-rds-postgres-pool/service/src/config.js`
- Modify: `ecs-rds-postgres-pool/service/Dockerfile`
- Modify: `ecs-rds-postgres-pool/service/test/pool.test.js`, `test/config.test.js`

**Interfaces:**
- Consumes: plan 1's `createPool({ config, onWait })` and `loadConfig()`.
- Produces: `buildSsl(config, readFile)`, exported for the test; a new config key `dbCaBundle` from
  `DB_CA_BUNDLE`, defaulting to the path the image writes. This is decision D4, and it pays off
  what plan 1's `pool.js` comment named as owed to this plan.

Service code: the red-green loop applies.

- [ ] **Step 1: Write the failing tests**

In `test/pool.test.js`, **add `buildSsl` to the file's existing import** from `../src/pool.js`:

```js
import tls from 'node:tls';

const readFake = (path) => `-----BEGIN CERTIFICATE-----\nFAKE-RDS-CA ${path}\n-----END CERTIFICATE-----\n`;

test('require verifies the server certificate', () => {
  const ssl = buildSsl({ dbSsl: 'require', dbCaBundle: '/x/rds.pem' }, readFake);
  assert.equal(ssl.rejectUnauthorized, true,
    'a lab still verifies: an unverified TLS connection is encryption without identity');
});

test('the trust store holds the RDS CA AND the public roots, because knob 3 needs both', () => {
  const ssl = buildSsl({ dbSsl: 'require', dbCaBundle: '/x/rds.pem' }, readFake);
  assert.ok(ssl.ca.some((c) => c.includes('FAKE-RDS-CA')),
    'the instance presents a certificate signed by the RDS CA');
  assert.ok(ssl.ca.length > tls.rootCertificates.length,
    'RDS Proxy presents an ACM certificate chaining to public roots. Passing ca REPLACES the ' +
    'default store, so dropping the roots would verify the instance and break the proxy at knob 3');
});

test('off disables TLS entirely', () => {
  assert.equal(buildSsl({ dbSsl: 'off', dbCaBundle: '/x/rds.pem' }, readFake), undefined);
});

test('a missing bundle fails loudly at boot rather than silently downgrading', () => {
  const missing = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  assert.throws(() => buildSsl({ dbSsl: 'require', dbCaBundle: '/nope.pem' }, missing), /\/nope\.pem/);
});
```

In `test/config.test.js`, extend the defaults test with
`assert.equal(c.dbCaBundle, '/app/certs/rds-global-bundle.pem');` and add a case that
`DB_CA_BUNDLE` overrides it.

- [ ] **Step 2: Run and watch them fail**

```bash
cd ecs-rds-postgres-pool/service && npm test -- test/pool.test.js test/config.test.js
```

Expected: FAIL — `buildSsl` is not exported and `dbCaBundle` is undefined.

- [ ] **Step 3: Implement**

In `config.js`, add next to `dbSsl`:

```js
    // The RDS CA bundle, which the image writes at build time (Dockerfile).
    // Overridable for a local run against a database with a different chain.
    dbCaBundle: env.DB_CA_BUNDLE || '/app/certs/rds-global-bundle.pem',
```

In `pool.js`, add and export:

```js
import tls from 'node:tls';
import { readFileSync } from 'node:fs';

/**
 * The TLS options for the pool, or undefined when TLS is off.
 *
 * Trusts the RDS CA bundle AND Node's public roots, and the second half matters.
 * Knob 3 switches the service from the instance to RDS Proxy (infra/main/proxy.tf),
 * and the two present different chains: the instance a certificate signed by the
 * RDS CA, the proxy an ACM certificate chaining to Amazon's public roots. Passing
 * `ca` to TLS REPLACES Node's default store rather than adding to it -- so trusting
 * the bundle alone would verify the instance and break the proxy, and it would
 * surface only when knob 3 ran.
 *
 * A missing bundle throws, naming the path. Falling back to an unverified
 * connection would turn a packaging mistake into a silent loss of identity.
 */
export function buildSsl(config, readFile = readFileSync) {
  if (config.dbSsl !== 'require') return undefined;
  let bundle;
  try {
    bundle = readFile(config.dbCaBundle, 'utf8');
  } catch (err) {
    throw new Error(`DB_SSL=require but the CA bundle at ${config.dbCaBundle} could not be read (${err.code ?? err.message})`);
  }
  return { ca: [...tls.rootCertificates, bundle], rejectUnauthorized: true };
}
```

Then in `createPool`, replace the `ssl:` line and its comment with:

```js
    ssl: buildSsl(config),
```

Remove the comment that said carrying the bundle was plan 2's problem — it is no longer true.

- [ ] **Step 4: Put the bundle in the image**

First fetch it once and pin its checksum, rather than trusting whatever the URL serves at build time:

```bash
curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem | sha256sum
```

Record the digest in your report. In the Dockerfile's final stage, before `USER node`:

```dockerfile
# The RDS CA bundle, verified by checksum so a changed file fails the build
# instead of silently changing what the service trusts. AWS rotates these CAs on
# a published schedule; when it does, this line fails loudly and the digest is
# updated deliberately. src/pool.js reads it (DB_CA_BUNDLE).
ADD --checksum=sha256:<the digest you recorded> \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    /app/certs/rds-global-bundle.pem
```

`ADD --checksum` needs the `docker/dockerfile:1` syntax line the Dockerfile already carries.

- [ ] **Step 5: Run the tests, and rebuild the image**

```bash
npm test
docker build -t ecs-rds-postgres-pool:dev .
docker run --rm ecs-rds-postgres-pool:dev ls -la /app/certs/
docker run --rm ecs-rds-postgres-pool:dev node -e "
  import('./src/pool.js').then(m => {
    const s = m.buildSsl({ dbSsl: 'require', dbCaBundle: '/app/certs/rds-global-bundle.pem' });
    console.log('trust anchors:', s.ca.length, 'verify:', s.rejectUnauthorized);
  })"
```

Expected: the suite green; the bundle present in the image and readable as the `node` user; and the
last command reporting more trust anchors than Node's default count, with `verify: true`.

- [ ] **Step 6: Commit**

```bash
git add ecs-rds-postgres-pool/service/
git commit -m "fix(ecs-rds-postgres-pool/service): verify the database certificate on both paths"
```

---

## Task 16: The README, outputs, tfvars and the spec amendment

**Files:**
- Create: `ecs-rds-postgres-pool/README.md`
- Create: `ecs-rds-postgres-pool/infra/main/outputs.tf`
- Create: `ecs-rds-postgres-pool/infra/main/dev.tfvars`
- Modify: `docs/superpowers/specs/2026-09-19-ecs-rds-postgres-pool-design.md`

**Interfaces:**
- Produces: the `base_url`, `ecr_repository_url`, `cluster_name`, `service_name`, `k6_project_id`,
  `db_endpoint`, `collector_endpoint`, `collector_service_name`, `heartbeat_function_name` and
  `knobs` outputs. Task 14's script and the `/loadtest` skill read them.

- [ ] **Step 1: Write `outputs.tf`**

Copy the sibling's, add the fork header, and make two replacements:

- **`table_name` → `db_endpoint = aws_db_instance.main.endpoint`.** Do **not** output
  `local.database_url`: it contains the password, and outputs are stored in state and printed by
  `terraform output`.
- **`provisioned_capacity` → `knobs`**, the positions the ledger records:

```hcl
output "knobs" {
  description = "The knob positions and measurement parameters, recorded on every results.md row so a number can always be traced to the configuration that produced it."
  value = {
    pool_size        = var.pool_size
    desired_count    = var.desired_count
    proxy_enabled    = var.proxy_enabled
    instance_class   = var.instance_class
    report_scan_rows = var.report_scan_rows
    seed_rows        = var.seed_rows
  }
}
```

- [ ] **Step 2: Write `dev.tfvars`**

```hcl
# The authoritative sizing knobs. slo.yaml's capacity block is ADVISORY and only
# computes; this file is what Terraform reads -- the arrangement the sibling
# adopted on 2026-09-18, after a generated file made overrides silent rather than
# preventing them.

# --- the knob sequence. One line changes per phase. ---
pool_size     = 5     # knob 1 releases this to 25
desired_count = 1     # knob 2 raises this to 4
proxy_enabled = false # knob 3 flips this to true

# --- the instance under test ---
instance_class    = "db.t4g.micro"
allocated_storage = 20

# --- the measurement parameters ---
seed_rows        = 50000 # x ~1 KB must stay inside shared_buffers
seed_feeds       = 16
report_scan_rows = 0 # THE CALIBRATED KNOB. Plan 3 sets it; 0 means uncalibrated.
feed_page_size   = 20

# --- boot behaviour. seed_on_boot is one task, one shot: it is not idempotent. ---
migrate_on_boot = true
seed_on_boot    = false

# --- the task ---
task_cpu    = 256
task_memory = 512

# --- your own address, for psql during a session: a /32, never a range ---
# operator_cidr = "203.0.113.4/32"
```

`operator_cidr` is commented deliberately. It is personal to whoever runs this, and any committed
value would be either wrong or somebody's home address. Task 17's plan fails until it is set, which
is the intended prompt.

- [ ] **Step 3: Write the README**

At minimum:

- what the project provisions and the question it answers;
- **the environment-variable contract table**, moved from plan 1 — that document is executed and
  should stay frozen, and `CLAUDE.md`'s layout requires the README anyway. Include `DB_CA_BUNDLE`
  from Task 15;
- the knob sequence as a table with the connection arithmetic (`pool_size × desired_count` against
  the instance's ceiling), and the instruction to confirm the ceiling with `SHOW max_connections`
  and re-derive `max_connections_alert` from it before knob 2 runs;
- how to run it: `/env up`, `scripts/deploy-service.sh`, `scripts/upload-k6.sh`, `/loadtest`;
- a **Measured results** section containing exactly the sentence *"No runs yet — plan 3 produces the
  first numbers."* Do not create an empty table with placeholder rows.

- [ ] **Step 4: Amend the spec at the two decisions this plan changes**

`CLAUDE.md` requires the older document to carry a forward-pointer **at the decision itself**, not
only in a header.

1. In §4.3's "Deliberately not forked" table, at the `infra/grafana/canary.tf` row, append:
   *"**Reversed 2026-09-21** in `docs/superpowers/plans/2026-09-21-ecs-rds-postgres-pool-infrastructure.md`
   (decision D1): the file is not a synthetic check. Its live resource alerts when the SLI series goes
   absent, which guards against a silent pipeline — the failure this project can least afford. It is
   forked."*
2. In §11's target tree, at the `infra/grafana/` block, append that `locals.tf`, `alerts.tf` and
   `slo.tf` are created in plan 3 rather than plan 2, because they are generated from thresholds
   that do not exist until calibration (decision D2).

- [ ] **Step 5: Commit, as two commits**

```bash
git add ecs-rds-postgres-pool/README.md \
        ecs-rds-postgres-pool/infra/main/outputs.tf \
        ecs-rds-postgres-pool/infra/main/dev.tfvars
git commit -m "docs(ecs-rds-postgres-pool): readme, outputs and the sizing knobs"

git add docs/superpowers/specs/2026-09-19-ecs-rds-postgres-pool-design.md
git commit -m "docs(ecs-rds-postgres-pool): point the spec at two decisions plan 2 changed"
```

---

## Task 17: The reviewed plan

**Files:** none created. This task produces the deliverable.

- [ ] **Step 1: Format and validate the whole module**

```bash
cd ecs-rds-postgres-pool
terraform fmt -check -recursive infra/
terraform -chdir=infra/main init
terraform -chdir=infra/main validate
```

All clean. If `fmt -check` complains, run `terraform fmt -recursive infra/`, commit it, and re-check.

- [ ] **Step 2: Set `operator_cidr` locally and plan**

Uncomment `operator_cidr` in `dev.tfvars` with your own `/32` — **do not commit that line**:

```bash
curl -s https://checkip.amazonaws.com
terraform -chdir=infra/main plan -var-file=dev.tfvars
```

> **Amended during execution (2026-09-21):** do not uncomment anything in `dev.tfvars` — it is
> committed, in a public repo. Put `operator_cidr = "<your ip>/32"` in
> `ecs-rds-postgres-pool/infra/main/operator.auto.tfvars`: the repo's `*.auto.tfvars` pattern
> gitignores it, Terraform loads it without a flag, and remote runs receive it because
> `.terraformignore` does not exclude it. `operator_cidr` now has a validation that rejects anything
> but a `/32`. Step 5's "revert the uncommitted line" therefore has nothing to revert. Expect
> "undeclared variable" warnings for `grafana_prom_url`, `grafana_prom_username` and
> `grafana_prom_password`: the shared HCP variable set still sends them, and this root module
> dropped the collector's CloudWatch pipeline that declared them (D3). They are not a defect.
> Ruling R16 in the section "Amended during execution and plan-3 handoff" at the end of this plan.

- [ ] **Step 3: Answer each question with the resource and value you saw**

Do not summarise; answer each one.

1. **How many resources to add?** Nothing to change or destroy, since nothing exists.
2. **No proxy resources appear**, because `proxy_enabled = false`.
3. **The RDS instance** has `skip_final_snapshot = true`, `backup_retention_period = 0`,
   `delete_automated_backups = true`, `deletion_protection = false`.
4. **The log group `/aws/rds/instance/ecs-rds-postgres-pool/postgresql` is in the plan**, so
   Terraform owns it and destroy takes it.
5. **No NAT gateway and no EIP** appear anywhere.
6. **`Project = ecs-rds-postgres-pool`** appears via `default_tags` — confirm on the VPC, the
   instance and the ALB.
7. **The container environment** carries every variable in the contract table, with `POOL_MAX = 5`
   and `REPORT_SCAN_ROWS = 0`, and **no** `OTEL_SERVICE_INSTANCE_ID`.
8. **`DATABASE_URL` points at the instance endpoint**, not a proxy.
9. **No autoscaling target, scaling policy or ELU alarm** appears.
10. **The k6 project, the Grafana folder, the dashboard, the saturation rule group and the
    SLI-absent rule group appear**; `grafana_slo` and the burn-rate rule groups do **not**.

> **Amended during execution (2026-09-21):** questions 7 and 8 cannot be answered from the task
> definition in plan output. `container_definitions` prints as `(sensitive value)`, because
> `DATABASE_URL` interpolates the generated password and Terraform marks the whole string sensitive;
> and the instance's address is `(known after apply)` on a first plan anyway. The environment now
> lives in `local.app_environment` (`ecs.tf`), and two non-sensitive outputs expose it:
> `app_environment` (every name and value except `DATABASE_URL`) answers question 7, and
> `database_target` (`"instance"` or `"proxy"`) answers question 8. Step 4's switch is read the same
> way: `database_target` changes to `"proxy"` and the proxy resources appear, rather than a
> `DATABASE_URL` line, which its `grep` will not find. Ruling R14 in the section "Amended during execution and plan-3 handoff" at the end of this plan.

- [ ] **Step 4: Prove knob 3 is wired, without applying it**

```bash
terraform -chdir=infra/main plan -var-file=dev.tfvars -var proxy_enabled=true 2>&1 | tail -20
```

Expected: **refused**, with the precondition message about `proxy_borrow_latency_threshold`. That is
the guard working. Then:

```bash
terraform -chdir=infra/main plan -var-file=dev.tfvars -var proxy_enabled=true \
  -var proxy_borrow_latency_threshold=1 2>&1 | grep -E 'aws_db_proxy|aws_secretsmanager|DATABASE_URL|recovery_window'
```

`1` here is a throwaway value to get past the guard for this one check, and is never committed.
Confirm the proxy, its secret with `recovery_window_in_days = 0`, its role and its target group
appear, and that `DATABASE_URL` switches to the proxy endpoint. Discard the plan.

- [ ] **Step 5: Stop**

This plan ends here. **Do not apply `infra/main`.** Plan 3 opens with that apply, behind its own
approval gate. Revert the uncommitted `operator_cidr` line if you are handing the tree over.

---

## Done when

- [ ] The workspace exists with `execution_mode = "remote"` and `working_directory = "infra/main"`.
- [ ] `terraform fmt -check -recursive infra/` and `terraform -chdir=infra/main validate` are clean.
- [ ] `terraform -chdir=infra/main plan -var-file=dev.tfvars` succeeds, and every one of Task 17
      Step 3's ten answers is recorded.
- [ ] Knob 3 without a borrow-latency threshold is **refused**; with one, it adds the proxy and
      switches `DATABASE_URL`.
- [ ] `npm test` is green, and `npm run slo:check` still exits non-zero naming `fast` and
      `threshold_ms`.
- [ ] The image carries the RDS bundle, and the pool verifies the server certificate on both paths.
- [ ] `grep -rn "terraform apply\|terraform destroy" ecs-rds-postgres-pool/scripts/` is empty.
- [ ] `grep -rniE "dynamodb|pbkdf2|shed_elu|autoscaling" ecs-rds-postgres-pool/infra/` returns only
      comments explaining what is deliberately absent.
- [ ] Every file copied from the sibling carries its fork header dated 2026-09-21.
- [ ] **Nothing is applied to AWS.**
      `aws resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=ecs-rds-postgres-pool`
      returns nothing.

## What this plan deliberately does not do

- **No `terraform apply` of `infra/main`, and no AWS resources.** Plan 3.
- **No `infra/grafana/locals.tf`, `alerts.tf` or `slo.tf`, and no `infra/k6/tests/lib/slo.js`.** All
  four derive from class thresholds that do not exist until plan 3 calibrates them (D2). The k6
  profiles therefore cannot run yet.
- **No class thresholds, no `target_rps`, no calibrated `report_scan_rows`, no confirmed
  `max_connections`, no borrow-latency threshold.** Each needs the real instance.
- **No `service/pricing.json`.** Published cost figures must come from a recorded price query, which
  belongs with the run that publishes numbers. Plan 4.
- **No `results.md`.** The first `/loadtest` run creates it, in plan 3.
- **No measured numbers anywhere**, including the README's Measured results section.

## Amended during execution and plan-3 handoff

Written 2026-09-21, at the end of Tasks 2–16. The execution ledger that first recorded these lives
in a gitignored directory and will not survive the worktree, so everything plan 3 needs from it is
here. Where a ruling changed a task's instructions, that task also carries an "Amended during
execution" note at the instruction itself.

### Rulings made during execution

- **R1 — Local validation until the workspace exists.** Tasks 2–16 verified with
  `terraform -chdir=infra/main init -backend=false` then `validate` (plus `fmt -check`), because the
  `ecs-rds-postgres-pool` HCP workspace does not exist until Task 1's platform apply, and that apply
  is the plan's one human approval gate — blocking fifteen local tasks behind it bought nothing. The
  cost: a bad `cloud {}` block is not caught until Task 17's real `init`.
- **R2 — Task 1's commit landed before its apply.** Follows from R1: the `platform/` change is
  committed but not applied until the approval. Nothing reads the workspace before Task 17.
- **R3 — The provider lock file is committed.** `infra/main/.terraform.lock.hcl` is committed
  whenever `init` creates or changes it, as the sibling does, because remote runs need pinned
  providers. `.terraform/` is never committed.
- **R4 — Commit trailers name the model that wrote the commit.** Task 2's commit carries a Sonnet
  trailer rather than the one the constraints listed; it was kept, because it is the truthful
  attribution.
- **R5 — No `_bucket` suffix on the pool-wait quantile queries.** The service exports native
  (exponential) histograms, which have no `_bucket`/`_sum`/`_count` series; the generator's
  `CLASSIC_SERIES` test forbids those suffixes, and the existing renderers use the bare metric name.
  Task 3's text was wrong. (Note at Task 3.)
- **R6 — `DATABASE_URL`, password included, stays a plain task-definition environment entry.** The
  service takes one connection URL and nothing else, so moving the password into ECS `secrets` needs
  a service change outside this plan. The trade is stated in `proxy.tf`: anyone with
  `ecs:DescribeTaskDefinition` in the lab account can read the password of a disposable database of
  generated rows.
- **R7 — Kept dashboard panels 10, 16, 17, 23 and 24 had their descriptions rewritten**, despite
  Task 10's "copy unchanged", because they carried the sibling's measured numbers and this plan
  forbids measured numbers in any document. Queries and panel ids are untouched.
- **R8 — The burst-credit rule and panel 27 watch `CPUSurplusCreditBalance > 0`, not
  `CPUSurplusCreditsCharged > 0`.** The point is to catch the instance spending past its burst
  budget, which is when the surplus balance rises; Charged only becomes non-zero once surplus
  outlives 24 hours of earning or at termination, so on an instance destroyed daily it would stay 0
  through the event. (Notes at Task 11 and at the spec's run gate.)
- **R9 — The credit rule reads with a 300 s period and a 600 s lookback**; the other four saturation
  rules keep 60 s / 300 s. T-class credit metrics publish every 5 minutes, so a 300 s window is
  usually empty, and `no_data_state = "OK"` would make the rule silent. (Note at Task 11.)
- **R10 — `saturation.tf`'s header reads "Structure forked from …throttles.tf"** instead of the exact
  fork-header wording, because the file ports the sibling's structure, not its content.
- **R11 — The "no apply/destroy in scripts" grep stays literal.** Comments in `deploy-service.sh`
  and, in the final fix pass, `upload-k6.sh` were reworded so neither contains the literal command
  text; weakening the grep to skip comments would let a commented-out apply pass.
- **R12 — The database security group admits itself on 5432** **(Superseded 2026-09-22 by R19: one `0.0.0.0/0` rule covers the proxy.)** (`self = true`), so RDS Proxy, whose
  ENIs sit in the same group, can reach the instance. Without it knob 3 fails every request, and
  neither `plan` nor `validate` can see it. Only the instance and the proxy are members of the group.
  (Note at Task 4.)
- **R13 — The proxy's log group is pre-declared**: `/aws/rds/proxy/${var.project}`, count-gated on
  `proxy_enabled`, with retention, and `aws_db_proxy.main` depends on it. Otherwise RDS creates it
  untagged and never-expiring, and it survives teardown invisible to the tag sweep. (Note at Task 6.)
- **R14 — The app environment is `local.app_environment`, exposed by two non-sensitive outputs.**
  `app_environment` (every entry but `DATABASE_URL`) and `database_target` (`"instance"` or
  `"proxy"`) answer Task 17's questions 7 and 8 and Step 4, because the task definition prints as
  `(sensitive value)` in a plan. (Note at Task 17.)
- **R15 — Every ruling that changed the plan or the spec got a forward-pointer at the decision
  itself**, plus this section, because the ledger that recorded them is gitignored.
- **R16 — `operator_cidr` must be a `/32`, and lives in a gitignored `operator.auto.tfvars`.** **Reversed 2026-09-22 by R19.** The
  database is publicly accessible, so `0.0.0.0/0` would leave password auth as its only guard; and
  uncommenting a line in the committed `dev.tfvars` invites committing a home address to a public
  repo. The `*.auto.tfvars` pattern already gitignores the file, and `.terraformignore` does not
  exclude it, so remote runs receive it. (Note at Task 17.)

### Review rulings, 2026-09-22

The user reviewed this plan on <https://claude.ai/artifact/MNVg7JiQip7fj5gAYRAjvp> in three rounds.
(The rounds were read against an older, pre-execution copy of this plan; the branch had already
fixed three of the findings — R12, R14 and the Task 15 `--chmod` — so only what follows was new.)

- **R17 — `pool_connection_timeout_ms` has no default.** The 900 ms default was described as "just
  above the heavy class threshold" while every class threshold is `null`, breaking this plan's own
  rule against invented thresholds. With no default it cannot be forgotten; `dev.tfvars` sets 900,
  commented as an unmeasured placeholder that plan 3 replaces with the heavy threshold plus a margin.
- **R18 — The parameter group uses `name_prefix`.** A fixed `name` with `create_before_destroy` makes
  any replacement (a family change, 16 → 17) create the new group under the old group's name, which
  AWS rejects.
- **R19 — The database is open to any address, guarded by a random password from the root `.env`.**
  Reverses R16 and supersedes R12. The security group admits 5432 from `0.0.0.0/0`; the password
  and TLS forced by `rds.force_ssl` are the guard, and internet scanners will reach the login
  prompt — accepted for a lab of generated rows, destroyed after each session. The password is
  `DB_PASSWORD` in the root `.env` (generated with `openssl rand -hex 24`), exported by `.envrc` as
  `TF_VAR_db_password` and forwarded by `platform/` into the shared HCP variable set as sensitive,
  exactly like the Grafana credentials; the root module declares `var.db_password`, sensitive, no
  default, validated as 20–128 URL-safe characters. Gone: `operator_cidr`, `operator.auto.tfvars`,
  the `random` provider, `random_password.db` and `aws_ssm_parameter.db_password`. New: a `psql`
  output (the connection command without the password). The user considered R16's reasoning —
  "0.0.0.0/0 would leave password auth as the sole guard" — and chose this anyway, for psql from
  any network with nothing personal to maintain, and to keep every secret at the root.
- **R20 — The `posts` table is not reset between runs; its size is recorded instead.** Amends
  inherited item (f). 20% of the mix inserts (`write` 15%, `report` 5%) and the heartbeat inserts
  every minute, so the table grows and each later knob meets a larger one. Plan 3 records
  `SELECT count(*) FROM posts`, taken just before each run, on every `results.md` row, rather than
  building a reset. The user confirmed this after being shown the heartbeat's contribution.

### What plan 3 inherits

- **(a) Uploads throw once `slo.js` exists.** `scripts/upload-k6.sh` passes only `BASE_URL` and
  `RATE` to `k6 archive`/`k6 cloud upload`, and the profiles refuse to start without
  `MEAN_SECONDS` — pass `-e MEAN_SECONDS` from the script, or replace the guard.
- **(b) `vcpu_per_task` is not cross-checked.** `slo.yaml`'s `attribution.vcpu_per_task` (0.25) must
  equal `task_cpu / 1024` from `dev.tfvars`, and dashboard panel 23 hardcodes the same 0.25. Automate
  the check.
- **(c) Metric names are unverified against live Prometheus.** Confirm on the first deploy that the
  label is spelled `pool_opened` and that the pool gauges carry no unit suffix.
- **(d) The credit panel's and rule's 300 s period (R9) are unverified.** Confirm on the first apply
  that the credit metrics return data at that period.
- **(e) Feed-id aliasing.** The 20-slot mix cycle taken modulo 16 feeds never lands the feed route on
  feeds 4, 8, 12 or 16. Fix it when the mix is re-derived for the SQL workload.
- **(f) No drop/re-seed mechanism exists.** **Amended 2026-09-22 by R20: none will be built; the growth is recorded instead.** The seed is not idempotent (re-running it adds rows on
  top), and the heartbeat inserts rows between runs (`POST /posts` and `POST /reports`, once a
  minute), so the table the heavy route scans grows between runs even with no load test. Plan 3
  must build the reset before its first measured run.
- **(g) `/loadtest` is DynamoDB-shaped.** It reads a `table_name` output and DynamoDB throttle
  metrics, neither of which exists here. Its throttles column needs a Postgres analogue: peak
  `DatabaseConnections`, and the surplus-credit gate (R8).
- **(h) Expect "undeclared variable" warnings in remote plans.** The shared HCP variable set still
  sends `grafana_prom_url`, `grafana_prom_username` and `grafana_prom_password`, which this root
  module no longer declares since the collector's CloudWatch pipeline was dropped (D3).
- **(i) Two knob-3 fixes are confirmed only by a real proxy.** At the first knob-3 apply, confirm
  the proxy's log group path (R13) and that the proxy target turns `AVAILABLE` through the
  self-ingress rule (R12).
