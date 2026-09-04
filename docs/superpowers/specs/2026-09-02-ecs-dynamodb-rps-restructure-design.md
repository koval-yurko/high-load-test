# ecs-dynamodb-rps — rename, restructure, and platform-as-code

- **Status:** **complete** (2026-09-04). Approved 2026-09-03, "all good" in the terminal after the
  final read on https://claude.ai/code/artifact/73d0f5cd-6bd0-45ec-899a-6d0778549439. Brainstormed
  on the design review page https://claude.ai/code/artifact/0a676106-842f-4901-bed3-fea0e4248666,
  where the six decisions in section 9 were answered and the follow-up messages folded in; the
  final name was confirmed in the terminal; Tier 1.8, the Tier 1.1 correction and Tier 2.11 came
  from the spec review page. Executed by
  `docs/superpowers/plans/2026-09-03-ecs-dynamodb-rps-restructure.md` (rename, restructure,
  `platform/` stack, Tier 1); Tier 2 items get their own plans after that one lands. The `platform/`
  stack was applied 2026-09-04 (19 added, 2 changed, 0 destroyed): the TFC project, both
  workspaces (renamed in place, working directory `terraform` → `infra/main`), the shared
  variable set, the Grafana folder `high-load-test`, and the k6 project. `ecs-dynamodb-rps/infra/main`'s
  remote plan against the renamed workspace read **52 to add, 0 to change, 0 to destroy** and was
  **not applied** — that apply is the first task of the scale-and-measure plan. See the plan's own
  Status section for the full ledger (commits, rulings, both counts).
- **Project:** `ecs-dynamodb-rps` (today `ecs-dynamodb-rps-ceiling`).
- **Amends:**
  - `CLAUDE.md`, layout section: the project tree (`infra/`, `service/`, `heartbeat/` instead of
    `terraform/ src/ k6/ grafana/`), the sentence "global holds only shared credentials/config"
    (a `platform/` stack is added), and "one workspace per project" (plus one `platform`
    workspace). Forward-pointers go at each sentence, not only in a header.
  - `.claude/skills/env`, `loadtest`, `slo`, `piib`: every hardcoded `<project>/terraform`,
    `<project>/k6`, `<project>/grafana` path.
  - Commit `901b97d`: the decision that the k6 project is
    "created, never imported, new id on every apply" is **reversed** by section 7.2 before it is
    ever applied. The standalone note that recorded it was deleted on 2026-09-04 instead of being
    given a forward-pointer — everything in it was duplicated in the README and the Terraform
    comments — so the commit is the remaining record.
  - `docs/superpowers/plans/2026-09-02-ecs-dynamodb-rps-ceiling-scale-and-measure.md` (draft,
    unexecuted): paths and name updated in place, file renamed.
  - `docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-datasource-fidelity-design.md`,
    decision **D2** ("the forwarded copy stays … `ThrottledRequests` is not dropped"): the
    DynamoDB block is trimmed to `SuccessfulRequestLatency` by Tier 1.8 below; the join argument
    D2 made for that one metric is exactly what survives. Forward-pointer at D2.
- **Does not amend:** any measurement, SLO or attribution decision. The SLI, the burn-rate rules,
  the capacity model and the load profiles are moved, not changed.

## 1. Why now

The environment was destroyed on 2026-09-02. Verified the same day: the Terraform Cloud workspace
holds **0 resources**; the Grafana folder, dashboard, SLO and rule groups are gone with it; the AWS
tag sweep for `Project=ecs-dynamodb-rps-ceiling` finds only INACTIVE ECS records that AWS keeps
for a while after deletion (cluster, two services, task-definition revisions) and one VPC-endpoint
ARN that no longer resolves. Nothing billable survives.

That makes this the one moment the rename is free. `CLAUDE.md` warns that renaming a project
orphans tagged resources from the sweep — true while resources exist, false right now. Module
addresses can change without `moved` blocks, the workspace can be renamed with an empty state, and
the Grafana objects will be created under the new name on the next apply.

The next apply is the first task of the scale-and-measure plan. This restructure lands **before**
it, so that apply creates everything under the new layout and nothing is migrated later.

## 2. What was asked

1. Rename `ecs-dynamodb-rps-ceiling` → `ecs-dynamodb-rps`.
2. Keep infrastructure separate from service code, with nested folders for the main (AWS)
   infrastructure, Grafana, and k6.
3. Every Terraform Cloud workspace under the `high-load-test` project (`TF_CLOUD_PROJECT`), one
   workspace per repo project.
4. Every Grafana dashboard and alert under a `high-load-test` folder.
5. Manage as much as possible in Terraform.
6. Improvement ideas for monitoring, alerting, SLO (AWS + Grafana), Terraform and IaC.

## 3. Current state, verified 2026-09-02

| what | state |
|---|---|
| TFC workspace `ecs-dynamodb-rps-ceiling` (`ws-pPiZ7mfesjrzZ8sx`) | **already in project `high-load-test`** (`prj-nMQTAXZhsqXfKWAo`); remote execution; working directory `terraform`; Terraform **1.16.0** (local and README verify 1.14); 0 resources |
| Workspace variables | 16, all hand-set in the UI: AWS keys, `GRAFANA_URL/AUTH`, `GRAFANA_K6_ACCESS_TOKEN`, `GRAFANA_STACK_ID`, `GRAFANA_SM_ACCESS_TOKEN` (unused since the heartbeat replaced Synthetic Monitoring), the six `grafana_otlp_*`/`grafana_prom_*` Terraform variables, and `read_capacity=25` / `write_capacity=25`, which **duplicate `dev.tfvars`** and outrank it in a remote run |
| Grafana folders | no `high-load-test` folder; the project folder was destroyed |
| Grafana contact point | `Slack - Kovalchuk & Co` exists, hand-made, shared with the `emails-flow` alerts; the root notification policy routes everything to it |
| Grafana SLOs | none |
| k6 project | the committed HCL would create one named `high-load-test` on next apply; the hand-made `8474786` may still exist in the k6 app |
| AWS | clean (section 1) |
| Repo | 40 files carry the old name, ~700 occurrences, ~600 of them inside completed specs and plans |

## 4. Target layout

```
ecs-dynamodb-rps/
  README.md                what it provisions, how to run it, measured results
  results.md               the run ledger (/loadtest appends here)
  slo.yaml                 SLO source of truth
  .terraformignore         upload root for HCP remote runs (4.2)
  infra/
    main/                  ROOT MODULE. cloud {} backend, aws + grafana providers; VPC, ALB,
                           ECS, DynamoDB, collector, heartbeat Lambda + schedule, autoscaling;
                           calls ../grafana and ../k6 as modules
      *.tf  dev.tfvars  capacity.auto.tfvars  .terraform.lock.hcl
    grafana/               MODULE: project subfolder, dashboard, SLO, burn-rate rules, canary,
                           alloy config template, classmap.json, queries.json, locals.tf
    k6/                    the load profiles (uploaded by hand) and a data source that reads
                           the k6 project id from platform/ by name
      tests/{discovery,constant,stress}.js   tests/lib/{env,mix,request,slo}.js
  heartbeat/               the idle-population Lambda (index.mjs), its own top-level piece;
                           archive_file in infra/main zips it
  service/
    package.json  package-lock.json  Dockerfile  .dockerignore  docker-compose.test.yml
    src/  test/  scripts/{seed,calibrate,bench-otel,generate-slo}.js
    pricing.json  capacity-model.html
```

Decided (Q1 = B): the AWS root is `infra/main`, as the request phrased it; the heartbeat Lambda
is a top-level piece next to `infra/` and `service/` because it is managed separately from both.
`infra/aws` was recommended on the grounds that "main" says nothing about its siblings; overruled.

### 4.1 What moves where, and what changes inside

| today | tomorrow | change inside |
|---|---|---|
| `terraform/*.tf` | `infra/main/*.tf` | `module "grafana" { source = "../grafana" }` unchanged; add `module "k6" { source = "../k6" }`; `file("${path.module}/../grafana/…")` unchanged |
| `terraform/dev.tfvars`, `capacity.auto.tfvars`, lock file | `infra/main/` | `.gitignore` un-ignore rule → `!ecs-dynamodb-rps/infra/main/capacity.auto.tfvars` |
| `heartbeat/index.mjs` | unchanged, project top level | `archive_file.source_dir = "${path.module}/../../heartbeat"` |
| `grafana/*` | `infra/grafana/*` | `grafana_k6_project` + limits leave (7.2); `parent_folder_uid` added to the folder (7.1) |
| `k6/*.js`, `k6/lib/*` | `infra/k6/tests/`, `infra/k6/tests/lib/` | none in the scripts; `infra/k6/` gains `data "grafana_k6_projects"` + an output |
| `src/ test/ scripts/ Dockerfile package*.json .dockerignore docker-compose.test.yml pricing.json capacity-model.html` | `service/` | `generate-slo.js` output paths → `../infra/k6/tests/lib/slo.js`, `../infra/main/capacity.auto.tfvars`, `../infra/grafana/{classmap.json,alerts.tf,locals.tf,queries.json}`; `generate-slo.test.js` reads the same paths; Docker build context is `service/` |
| `slo.yaml`, `README.md` | stay at project root | `service:` field renamed |
| `.terraformignore` | stays at project root | ignore `service/`, `infra/k6/tests/`, `*.md`, `*.html`, `infra/main/.terraform/`, `tfplan*`; **not** `heartbeat/` |

### 4.2 Why the upload root matters

The workspace runs remotely. For a CLI-driven remote run Terraform uploads the **parent** of the
workspace's working directory, which is how `../grafana` resolves in the run today. With working
directory `infra/main`, the upload root is the project directory: `../grafana`, `../k6` and
`../../heartbeat` all resolve, and the project-root `.terraformignore` keeps `service/` and
`node_modules` out of the upload. The working directory is set on the workspace, not in HCL —
one of the reasons the workspace is made code in section 6.

### 4.3 The rename, mechanically

- **Code:** `var.project` default; `slo.yaml: service`; `config.js` `serviceName`; `otel.js`
  `METER_NAME`; `cpu.js` PBKDF2 `SALT` (changes the hash output, not its cost — calibration
  unaffected); the three k6 test `name`s; the dashboard title; the tests asserting those strings.
- **Generated files** (`alerts.tf` rule-group names, `queries.json`, `locals.tf`) regenerate via
  `npm run slo:generate`; `npm run slo:check` proves them byte-identical.
- **`.env` / `.env.example`:** `TF_WORKSPACE=ecs-dynamodb-rps`, plus `TFE_TOKEN` (6).
- **Skills:** `/env`, `/loadtest`, `/slo`, `/piib` paths. **`CLAUDE.md`**, root and project
  `README.md`, `docs/slo-burn-alerting.md` footer.
- **The draft plan** `2026-09-02-…-scale-and-measure.md`: paths and name updated in place, file
  renamed to `2026-09-02-ecs-dynamodb-rps-scale-and-measure.md`.
- **Completed specs and plans** (six and seven) keep filenames and text — the SDD ledger under
  `.superpowers/sdd/` and the commit history reference them. Each gets one line under its status:
  *"Project renamed to `ecs-dynamodb-rps` on 2026-09-03; paths and names below are pre-rename.
  See `2026-09-02-ecs-dynamodb-rps-restructure-design.md`."*
- **TFC workspace:** renamed in place by the platform stack (state is empty), working directory
  `infra/main`, Terraform version pinned.
- **AWS `Project` tag** changes with `var.project`; nothing tagged exists to migrate.
- **k6 project `8474786`:** delete in the k6 app if it still exists. *(checked 2026-09-04 via the
  k6 API: already gone; the stable project is 8476029.)*

## 5. Improvement backlog, as decided

Tier 1 rides with the restructure. Tier 2 is a plan each, after the restructure lands. Tier 3 was
considered and is not done, with the reason recorded so it is not re-litigated.

### Tier 1 — guardrails, one file each (in the first plan)

| # | change | why |
|---|---|---|
| 1.1 | account guard inside Terraform: `data.aws_caller_identity.current.account_id == var.aws_account_id` as a `lifecycle { precondition }` on `aws_vpc.main`, the resource everything else depends on. A `check` block was considered and rejected because it only **warns**; a precondition fails the plan | the account guard lives only in the `/env` skill; a remote run never sees it |
| 1.2 | `default_tags` gain `ManagedBy = "terraform"` and `Workspace = var.project` | a resource missing `ManagedBy` in the console is the click-ops detector |
| 1.3 | `terraform_version` on the workspace pinned to the `required_version` the README verifies | the workspace drifted to 1.16.0 against 1.14 locally |
| 1.4 | alert annotations `runbook_url` (README section) and `__dashboardUid__` / `__panelId__` | a Slack alert deep-links the panel it is about; generator change, six rules |
| 1.5 | `deployment_circuit_breaker { enable = true, rollback = true }` on both ECS services | a bad image loops forever and looks healthy from the ALB |
| 1.6 | Grafana rule on the CloudWatch datasource: `ReadThrottleEvents + WriteThrottleEvents > 0` for 2 min, severity `ticket` | the database SLI `CLAUDE.md` calls first-class has no alert of its own. *Built as two rules (read, write) in one group on 2026-09-04: Grafana's `$A + $B` math yields no data when either CloudWatch query has no series, and CloudWatch publishes throttle events sparsely, so a summed rule is silent during one-sided throttling.* |
| 1.7 | drop `GRAFANA_SM_ACCESS_TOKEN` and the two duplicated capacity variables from the workspace | dead credential and shadowed inputs |
| 1.8 | trim the Alloy CloudWatch block to the one metric with a Prometheus reader, `SuccessfulRequestLatency` (Average, Maximum); drop `ThrottledRequests`, `ReadThrottleEvents`, `WriteThrottleEvents`, `ConsumedRead/WriteCapacityUnits` from it and the two `*_throttle_events` queries from `queries.json`; `/loadtest` reads the throttle peaks **directly from CloudWatch** (`aws cloudwatch get-metric-data`, Sum per 60s over the run window) | decided on the spec review page 2026-09-03 ("remove metrics from Alloy we do not use and use them directly from AWS"). Five of the six forwarded metric-statistics had no reader; the dashboard and the Tier 1.6 rule already read CloudWatch live. Reverses the "`ThrottledRequests` is not dropped" half of decision D2 in the 2026-09-01 datasource-fidelity spec; the join argument for `SuccessfulRequestLatency` stands. Cost drops from ~7 to 2 metric-statistics/min |

### Tier 2 — structural, a plan each (after the first plan)

| # | change | why |
|---|---|---|
| 2.1 | the `platform/` stack (6), including the k6 project (7.2) — **in the first plan**, because the workspace rename and working-directory change cannot be done without it except by click-ops | every TFC and shared-Grafana setting becomes code |
| 2.2 | notification policy as code: `grafana_notification_policy` routing **everything to the Slack contact point** ("all goes to Slack"), `severity=page|ticket` kept on the labels so the message says which; a `grafana_mute_timing` for the SLI-absent canary while `heartbeat_enabled = false`; import the existing contact point | rules name the contact point directly today; the policy tree is the one hand-made object every alert flows through |
| 2.4 | AWS Budget: `aws_ce_cost_allocation_tag "Project"` + `aws_budgets_budget` per project filtered on that tag, alert at $50/month to email | the README says the forgotten environment is the cost risk; nothing pages on it |
| 2.6 | recording rule (`grafana_rule_group` with `record`) for the per-class good/total rates | the class-ratio PromQL is evaluated by six rules, the SLO, the dashboard and `/loadtest`; one evaluation, one definition |
| 2.7 | two-window burn confirmation: each burn rule pairs its long window with a short one at 1/12 (14m + 70s, 84m + 7m) as an AND, replacing `for` | the SRE-book form; the alert clears within the short window instead of `for`+long |
| 2.9 | GitHub Actions on pull requests: `npm test`, `npm run slo:check`, `terraform fmt -check` + `validate`, `tflint`; never plan or apply | `CLAUDE.md` rejects CI for commit messages, not for the drift check that already exists as `slo:check` |
| 2.10 | Container Insights on the ECS cluster (`setting { name = "containerInsights", value = "enhanced" }`) + per-task CPU/memory panels | moved up from Tier 3 on 2026-09-03; per-task CPU and memory is what makes the 1→4 scale-out decision visible; ~$1–3/month |
| 2.11 | Grafana SLO's built-in burn-rate alerting: add the `alerting { fastburn {…} slowburn {…} }` block to `grafana_slo.latency_classes` (and an SLO object each for tail and availability, so all three objectives are SLO-app native), labels and annotations carried through, routed like the rest. Run it **side by side** with the generated rules through one full load run, compare fire and clear times against the measured 4m01s / 16m, then keep exactly one set — two burn-rate rule sets must not coexist past that run. The 7-day window is the SLO's own and stays | moved up from Tier 3 on 2026-09-03 ("move it to Tier 2"). What it buys: the SLO app owns the burn rules, the error-budget page and the alerts from one object, and the generator stops emitting ~650 lines of `alerts.tf`. The risk it carries, to be measured rather than assumed: Grafana derives the burn windows itself and they are documented against a 30-day objective; if on a 7-day window they still mean 2%/5% of budget, the generated rules retire; if they mean 8.6%/21%, the generated rules stay and this item closes as "measured, rejected" |

Numbers 2.3, 2.5 and 2.8 were moved to Tier 3 by the review, and 2.10 and 2.11 were moved up
from it; numbers are kept so the page's log still reads correctly.

### Tier 3 — considered, not now

- **2.3 Dynamic provider credentials (OIDC)** — declined ("nope"). The IAM user keys stay in
  `.env` and in the variable set.
- **2.5 Image pipeline** (git-SHA tags, `image_tag` in tfvars, digest pinned in the task
  definition) — moved here. The build / push / `--force-new-deployment` cycle stays manual and in
  the README's known gaps.
- **2.8 Load tests as code** — declined "for simplicity" (Q5 = B).
- **HCP Terraform health assessments (drift detection)** — Plus tier (paid); stays here for
  that reason alone.
- **Traces (Tempo)** — none exist today, by design: `src/otel.js` registers a metrics-only SDK
  (three histograms plus Node runtime metrics), no tracer provider, no traces pipeline in Alloy,
  the Tempo datasource receives nothing. Adding traces means the Node HTTP and AWS SDK
  instrumentations, an Alloy traces pipeline, and tail sampling for the free tier. The two-metric
  read was chosen on 2026-09-01 over an inference model; traces would reopen it.
- **VCS-driven workspaces** — "nice to have for later". Every push would plan; the CLI-driven flow
  with the apply gate stays the safety mechanism until the platform stack and the CI checks (2.9)
  exist, then this becomes a candidate.

## 6. Terraform Cloud as code — the `platform/` stack

Decided (Q2 = A). A second, long-lived root module at the repository root:

```
platform/
  versions.tf     cloud { workspaces { project = "high-load-test", name = "platform" } };
                  providers: tfe, grafana
  tfc.tf          tfe_project "high-load-test" (imported); tfe_workspace per repo project;
                  tfe_variable_set "high-load-test" scoped to the project; tfe_variable × N
  grafana.tf      grafana_folder "high-load-test" (uid "high-load-test")
  k6.tf           grafana_k6_project + grafana_k6_project_limits per repo project (7.2)
  variables.tf    the credential values, sensitive, fed from .env as TF_VAR_*
```

What it owns, and why each is code rather than a UI setting:

- **`tfe_workspace.ecs_dynamodb_rps`** — `name`, `project_id`, `execution_mode = "remote"`,
  `working_directory = "infra/main"`, `terraform_version` pinned (1.3), `auto_apply = false`,
  `tag_names`. The working directory is today the single invisible setting that makes remote runs
  work; a second project would have to rediscover it. *Amended 2026-09-04: tfe provider 0.80
  deprecates `execution_mode` on `tfe_workspace`; the mode lives in `tfe_workspace_settings` (one
  per workspace, imported with the workspace id).*
- **`tfe_variable_set` + `tfe_variable`** — the credential and endpoint values hand-typed into
  the workspace today (AWS keys and region, `GRAFANA_URL/AUTH`, `GRAFANA_K6_ACCESS_TOKEN`,
  `GRAFANA_STACK_ID`, the six OTLP/Prometheus Terraform variables, `aws_account_id`), scoped to
  the TFC project so every future workspace inherits them. Values come from `.env` through
  `TF_VAR_*`; **the variable set is the only copy in HCP** and `.env` the only copy on disk.
  `GRAFANA_SM_ACCESS_TOKEN` and the two capacity variables are dropped (1.7).
- **`grafana_folder.high_load_test`** — the parent folder (7.1). Projects find it with
  `data "grafana_folder" { uid = "high-load-test" }` — a fixed string, not a state read, so
  "projects must not import each other's state" holds. *Amended 2026-09-04 during execution: in
  grafana/grafana 3.25.9 the `grafana_folder` data source keys on `title` (uid is
  computed-only), so `infra/grafana/folder.tf` looks it up by `title = "high-load-test"`;
  platform sets uid and title to the same string, both fixed literals.*
- **Execution mode: local.** This is the stack that creates the credentials other workspaces run
  with, so it runs with the developer's `.env` and stores state in HCP. The `tfe` provider reads
  `TFE_TOKEN`; `.env` gains that one line, same value as `TF_TOKEN_app_terraform_io`.

Bootstrapping: `terraform init` in `platform/` creates the `platform` workspace inside
`high-load-test` (HCP creates a missing workspace, and a missing project, on init). Then
`terraform import tfe_project.this prj-nMQTAXZhsqXfKWAo` and
`terraform import tfe_workspace.ecs_dynamodb_rps ws-pPiZ7mfesjrzZ8sx`, then a plan that shows
the rename and the working-directory change as in-place updates. The `platform` workspace is the
one exception to "one workspace per project directory": it is not a project, it is what makes
projects possible. *Amended 2026-09-04: the imports also include the two `tfe_workspace_settings`
resources (one per workspace, imported with the workspace id — see the amendment above), and
every `platform/` command in this bootstrap runs with `env -u TF_WORKSPACE` because the root
`.env` exports the project workspace name, which the `platform` workspace's own `cloud {}` block
must never pick up by accident.*

## 7. Grafana folder, k6 project, k6 tests

### 7.1 Folder — nested (Q3 = A)

`platform/` owns `high-load-test`; each project's module creates
`grafana_folder.project { title = var.project, parent_folder_uid = data.grafana_folder.root.uid }`
and puts its dashboard, six burn-rate groups, canary group and SLO there. Grafana Cloud supports
nested folders; the provider exposes `parent_folder_uid`. A project destroy removes only its
subfolder. Fallback named by the user if the stack ever refuses nesting: one flat folder per
project titled `high-load-test / <project>`, same ownership. *Amended 2026-09-04 during
execution: in grafana/grafana 3.25.9 the `grafana_folder` data source keys on `title` (uid is
computed-only), so `data.grafana_folder.root` is looked up by `title = "high-load-test"`;
platform sets uid and title to the same string, both fixed literals.*

### 7.2 k6 project — in `platform/` (Q4 = A)

`grafana_k6_project` and `grafana_k6_project_limits` move to `platform/`, one per repo project,
named after it (`ecs-dynamodb-rps`, not `high-load-test`). The id becomes **stable across
teardowns**, so `K6_CLOUD_PROJECT_ID` and the README links stop rotting, and **run history
survives `/env down`** — the trade commit `901b97d` accepted only because no
long-lived state existed. The project module reads the id with
`data "grafana_k6_projects" { name = var.project }`. All four limit values stay set explicitly
(an unset one is sent as null and resets the live value).

### 7.3 Load tests — uploaded by hand (Q5 = B)

The three scripts stay uploaded by hand, "for simplicity". The esbuild bundle and Terraform-injected
`BASE_URL` were offered and declined. With the k6 project long-lived, the settings-page step
(`BASE_URL`, `RATE`) is done once per project rather than once per apply.

## 8. Reference: metrics, SLO arithmetic, alert rules (as of 2026-09-03)

Added at the reader's request. This is what exists today; the restructure moves these files and
renames the `job` label, nothing else. Sources: `src/otel.js`, `grafana/alloy.alloy.tftpl`,
`grafana/queries.json`, `grafana/dashboard.json.tftpl`, `grafana/alerts.tf`, `grafana/canary.tf`,
`scripts/generate-slo.js`, `k6/lib/slo.js`.

### 8.1 Metrics emitted by the service (OTLP → Alloy → Grafana Cloud Prometheus)

Exponential (native) histograms, ≤160 buckets, so class thresholds are applied at query time with
`histogram_fraction`. Attributes on every datapoint: `http_route`, `http_request_method`,
`http_response_status_code`, `traffic_source` (closed set: k6, heartbeat, synthetic, alb, other).
Alloy adds `class` from `classmap.json` (`/items/:pk/:sk`, `/items` → fast; `/feeds/:pk` →
standard; `/reports` → heavy). `job` is the project name.

| measures | OTel instrument | Grafana name | readers |
|---|---|---|---|
| request duration | `http.server.request.duration` (s), handler start → response finish | `http_server_request_duration_seconds` | SLI, six burn rules, SLI-absent rule, SLO object, dashboard, `/loadtest` |
| DB wall-clock | `http.server.db.duration` (s), summed over AWS SDK awaits; includes event-loop queueing; absent for `/healthz` | `http_server_db_duration_seconds` | "DB wall-clock vs DynamoDB's own clock", "Queueing delay by route" |
| CPU time | `http.server.cpu.duration` (s), synchronous work only | `http_server_cpu_duration_seconds` | "CPU saturation" = `rate(sum) / 0.25` |
| Node runtime | `@opentelemetry/instrumentation-runtime-node` | `nodejs_eventloop_delay_p99_seconds`, `nodejs_eventloop_delay_max_seconds`, `nodejs_eventloop_utilization_ratio` (per `instance`) | "Event-loop delay p99 by task", `/loadtest` |

### 8.2 CloudWatch metrics forwarded by Alloy

`prometheus.exporter.cloudwatch`, discovery by `Project` tag, **AWS/DynamoDB only**, period 60s,
length 300s (absorbs CloudWatch lag), scraped every 60s. ALB/ECS forwarding was removed 2026-09-01
(panels read them live; nothing read the copy).

**After Tier 1.8 (decided 2026-09-03) exactly one metric is forwarded:**

| CloudWatch | statistic | Grafana name | readers |
|---|---|---|---|
| `SuccessfulRequestLatency` | Average, Maximum | `aws_dynamodb_successful_request_latency_average` / `_maximum`, by `dimension_Operation` | the two derived panels ("DB wall-clock vs DynamoDB's own clock", "Queueing delay by route"): service DB wall-clock − this = queueing delay. PromQL cannot subtract a CloudWatch series from a Prometheus series unless both are in one store, which is the only reason the block exists |

Dropped from the block by 1.8, because nothing in Prometheus read them: `ThrottledRequests`,
`ReadThrottleEvents`, `WriteThrottleEvents`, `ConsumedReadCapacityUnits`,
`ConsumedWriteCapacityUnits`. Their consumers read CloudWatch directly instead: the dashboard's
throttle and capacity panels always did (8.3), the Tier 1.6 throttle rule queries the CloudWatch
datasource, and `/loadtest` takes the read/write throttle peaks over the run window with
`aws cloudwatch get-metric-statistics` (Sum, 60s periods). Forwarding cost drops from ~7 to 2
metric-statistics per minute.

### 8.3 CloudWatch metrics read live by the dashboard (not forwarded)

Region pinned to eu-central-1 per panel; ALB/target-group dimensions from live ARN suffixes.

| namespace | metric | statistics | panel |
|---|---|---|---|
| AWS/DynamoDB | `ReadThrottleEvents`, `WriteThrottleEvents` | Sum | throttle events (headline metric 2) |
| AWS/DynamoDB | `SuccessfulRequestLatency` by Operation | Average, p99, Maximum | server-side latency |
| AWS/DynamoDB | `Consumed/ProvisionedRead/WriteCapacityUnits` | Sum, Average | capacity headroom |
| AWS/ECS | `CPUUtilization`, `MemoryUtilization` | Average, Maximum | service |
| AWS/ECS | `LiveTaskCount` | Average | is it up |
| AWS/ApplicationELB | `RequestCount` | Sum | did load arrive |
| AWS/ApplicationELB | `TargetResponseTime` | p95, Average, Maximum | edge latency |
| AWS/ApplicationELB | `HTTPCode_Target_2XX/4XX/5XX_Count`, `HTTPCode_ELB_4XX_Count` | Sum | status codes |
| AWS/ApplicationELB | `HealthyHostCount` | Average | routing |

### 8.4 SLO arithmetic

Objectives (window 7d — forced: Grafana SLO accepts 7–32d, the free tier keeps 14d):

| objective | good = | target |
|---|---|---|
| latency-classes primary | non-5xx **and** within class threshold (fast 50 ms, standard 200 ms, heavy 800 ms) | 99% |
| latency-classes tail | non-5xx **and** within 3× threshold (150 / 600 / 2400 ms) | 99.9% |
| availability | non-5xx | 99.9% |

Population selector on every query: `job="<project>", http_route!~"/healthz",
class=~"fast|standard|heavy"`; the numerator adds `http_response_status_code!~"5.."`. The class
selector is load-bearing: public-ALB scanner 404s carry no class and, before it, sat in the
denominator as misses (measured miss rate 66%). A 4xx is not a miss.

```
good_c = histogram_fraction(0, T_c, sum(rate(H{class="c", non-5xx}[w]))) × histogram_count(sum(rate(H{class="c", non-5xx}[w])))
SLI    = (good_fast + good_standard + good_heavy) / histogram_count(sum(rate(H{all classes}[w])))
```

Sum before fraction (a per-series fraction goes NaN when one task has no observations); each class
term wrapped in `or vector(0)` (an empty vector would erase the numerator). Tail = same with
`T_c × 3`; availability = non-5xx count / total count.

Evaluated in four places: the `grafana_slo` object (`$__rate_interval`, 7d budget, informational
between runs); the six burn rules (14m / 84m); the dashboard and `/loadtest` (`queries.json`;
run-scoped = authoritative, recorded in `results.md`); k6 client-side (`slo_met rate>0.99`,
`slo_met_tail rate>0.999`, `http_req_failed rate<0.001`, `dropped_iterations count==0`).

Capacity from the same file: mix 55/15/25/5 × cost (read 0.5 RCU, feed 2.5 RCU, report 2.5 RCU +
1 WCU, write 1 WCU) = 1.025 RCU and 0.200 WCU per rps → 1025 / 200 at 1000 rps.

### 8.5 Alert rules

Burn rate: a rule fires when `1 − SLI(window) > multiplier × (1 − objective)`. Multipliers encode a
budget share, `share = multiplier × window ÷ period`: on 30 days 14.4×/1h = 2% and 6×/6h = 5%; on
our 7 days the windows scale by 7/30 → **14 min** and **84 min**, `for` 5m → 70s and 30m → 7m.
Check: 14.4 × 14 / 10080 = 2%, 6 × 84 / 10080 = 5%. Each rule carries this in a `computation`
annotation.

| rule | query A (miss rate) | fires when A > | window / for | severity |
|---|---|---|---|---|
| latency primary · fast | `1 − SLI` @ 50/200/800 ms | 14.4 × 1% = 14.4% | 14m / 70s | page |
| latency primary · slow | same | 6 × 1% = 6% | 84m / 7m | ticket |
| latency tail · fast | `1 − SLI` @ 150/600/2400 ms | 14.4 × 0.1% = 1.44% | 14m / 70s | page |
| latency tail · slow | same | 6 × 0.1% = 0.6% | 84m / 7m | ticket |
| availability · fast | `1 − non-5xx/total` | 1.44% | 14m / 70s | page |
| availability · slow | same | 0.6% | 84m / 7m | ticket |
| SLI absent | `absent_over_time(http_server_request_duration_seconds{job, class=~"fast|standard|heavy"}[10m])` | 0 | 10m / 0s | ticket |

All burn rules read one metric, `http_server_request_duration_seconds`; pipeline A (instant
PromQL) → B (reduce last) → C (threshold gt); `no_data_state = OK`; routed to the Slack contact
point, `group_by = [alertname, slo]`. SLI absent exists because `no_data = OK` makes a dead
pipeline look healthy; mute it, never delete it, when the heartbeat is off. Measured 2026-09-01:
fast burn fires 4m01s after load starts and clears 16m after it stops; slow burn ~6m / ~84m.

## 9. Decisions, as recorded

Recorded on the review page on 2026-09-03 (`decisions/<slug>`), read back the same day:

| slug | question | recommended | answered |
|---|---|---|---|
| `layout` | which project layout | A: `infra/{aws,grafana,k6}` + `service/` | **B: `infra/{main,grafana,k6}` + `service/`**, note "and heartbeat lambda at the root" |
| `tfc-management` | how Terraform Cloud is managed | A | **A**: `platform/` owns project, workspaces, variable set, shared folder |
| `grafana-folder` | how projects sit under `high-load-test` | A | **A**: nested subfolder per project |
| `k6-project-home` | where the k6 project lives | A | **A**: `platform/`, stable id |
| `k6-tests-as-code` | load tests as Terraform resources | A | **B**: keep uploading by hand |
| `scope` | what the first plan contains | A | **A** with note "Restructure plus Tier 1 plus Tier 2": all of it goes ahead; restructure + Tier 1 (+ 2.1, which the restructure needs) first, the remaining Tier 2 items as follow-up plans |

Page messages folded in: section 1 shortened; heartbeat at top level; nested-folder fallback;
the 7-day-window clarification; the traces inventory; VCS workspaces "later"; all alerts to Slack;
OIDC declined; image pipeline and load-tests-as-code to Tier 3; Container Insights to Tier 2; the
metrics/SLO/alerts reference (section 8); Alloy trimmed to one forwarded metric, everything else
read directly from AWS (Tier 1.8); Grafana SLO's built-in burn-rate alerting to be trialled side
by side with the generated rules (Tier 2.11). Final name confirmed in the terminal:
`ecs-dynamodb-rps`.
Correction made while drafting the (since withdrawn) plan: Tier 1.1 is a precondition, not a
`check` block.

### Rejected alternatives, for the record

- `infra/aws` (recommended) and "service code stays at project root" — for the layout.
- A platform stack without the variable set, or no platform stack with a one-off API rename.
- A flat `high-load-test` folder with project-prefixed names.
- The k6 project staying in the project workspace (new id every apply).
- esbuild-bundled load tests as `grafana_k6_load_test` with `BASE_URL` injected at apply time.
- Keeping all six forwarded DynamoDB metric-statistics in Alloy (the 2026-09-01 D2 position).
- Dropping the last forwarded metric too, which would delete the two derived panels and the
  whole Alloy CloudWatch block plus the collector's CloudWatch IAM policy — not decided either
  way; 1.8 keeps the one metric the panels read.

## 10. Out of scope

- Any apply. The next apply is the scale-and-measure plan's first task, under the new name.
- Any change to `slo.yaml` values, the load profiles' shapes, or the capacity model.
- The second project (`lambda-…`); this spec only makes room for it.
