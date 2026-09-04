# ecs-dynamodb-rps Rename, Restructure and Platform-as-Code — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename `ecs-dynamodb-rps-ceiling` to `ecs-dynamodb-rps`, split the project into
`infra/`, `service/` and `heartbeat/`, put the Terraform Cloud project, workspaces, credentials,
the shared Grafana folder and the k6 project under a root `platform/` Terraform stack, add the
eight Tier 1 guardrails, and leave the repository ready for the scale-and-measure plan's first
apply under the new name — with **nothing applied to AWS**.

**Architecture:** Two Terraform roots. `platform/` (local execution, state in HCP) owns what must
exist before a project workspace can run: the TFC project `high-load-test`, one `tfe_workspace`
per repo project with its working directory and Terraform version, a project-scoped variable set
carrying the credentials, the Grafana folder `high-load-test`, and the Grafana Cloud k6 project
with its limits. `ecs-dynamodb-rps/infra/main` (remote execution, working directory `infra/main`)
owns everything billable, calls `../grafana` and `../k6` as modules, and finds the shared folder
and the k6 project by fixed name — never by reading the platform state.

**Tech Stack:** Terraform 1.14.0 (local, and pinned on the workspace), HCP Terraform CLI-driven
workflow, providers `hashicorp/aws ~> 6.0`, `grafana/grafana ~> 3.0` (3.25.9 resolved),
`hashicorp/tfe` (latest 0.x), `hashicorp/archive ~> 2.0`; Node 22 for the service and the SLO
generator; Grafana Cloud (nested folders, SLO app, k6 app); AWS CLI for the throttle readings.

**Spec:** `docs/superpowers/specs/2026-09-02-ecs-dynamodb-rps-restructure-design.md` (approved
2026-09-03). Section numbers below refer to it. It reverses the "k6 project is created, never
imported, new id on every apply" decision of commit `901b97d`
(spec 7.2), and the "`ThrottledRequests` is not dropped" half of decision D2 in the 2026-09-01
datasource-fidelity spec (spec Tier 1.8) — Task 6 writes both forward-pointers.

**Ledger:** `.superpowers/sdd/2026-09-03-ecs-dynamodb-rps-restructure/` (gitignored, like the
others).

---

## Status — **complete**, 2026-09-04.

Preconditions verified 2026-09-02/03 and assumed by every task: the TFC workspace
`ecs-dynamodb-rps-ceiling` (`ws-pPiZ7mfesjrzZ8sx`) holds **0 resources**; the AWS account has
nothing tagged `Project=ecs-dynamodb-rps-ceiling` except inactive ECS records; Grafana has no
`high-load-test` folder and no SLO. **If any of that is no longer true when a task starts, stop:**
a non-empty workspace state turns Task 7's rename and Task 8's plan into a migration, which this
plan does not cover.

### Ledger summary (Task 9)

All nine tasks (0–8) executed on branch `restructure/ecs-dynamodb-rps`, base `e19b140`. Full
ruling-by-ruling detail is in `.superpowers/sdd/2026-09-03-ecs-dynamodb-rps-restructure/progress.md`.

Commits above `e19b140` (oldest first):

| sha | subject |
|---|---|
| `2402c8a` | docs(repo): add the restructure spec, plan and burn-alerting note |
| `74fc6b8` | feat(platform): manage tfc, credentials, grafana folder and k6 as code |
| `771f0fb` | refactor(ecs-dynamodb-rps)!: split into infra, service and heartbeat |
| `692de45` | refactor(ecs-dynamodb-rps): rename from ecs-dynamodb-rps-ceiling |
| `efa434b` | feat(ecs-dynamodb-rps/infra): nested folder, k6 by name, guardrails |
| `8507c6a` | fix(ecs-dynamodb-rps/infra): one throttle rule per metric |
| `d9bbfdd` | docs(repo): follow the ecs-dynamodb-rps rename and the infra split |
| `a3e50d8` | docs(ecs-dynamodb-rps): fix the runbook count and throttle source |
| `3988ae2` | build(platform): commit the provider lock file from the first init |
| `507abfc` | docs(ecs-dynamodb-rps): close the restructure plan |
| *(not yet known)* | docs(repo): final review fixes for the restructure branch — the closing fix commit, whose SHA postdates this table |

**These SHAs were rewritten on 2026-09-04** and are not the ones the per-task reports and
`progress.md` cite. The final whole-branch review found five subjects over CLAUDE.md's 72-character
limit and two scopes still naming the retired `terraform` layer, so `git filter-branch --msg-filter`
reworded seven first lines across the unpushed branch (bodies, `BREAKING CHANGE:` footers and
trailers untouched). Old → new, oldest first: `07b00a5`→`2402c8a`, `0fc1bd0`→`74fc6b8`,
`242cb4f`→`771f0fb`, `008ffd7`→`692de45`, `f5009dd`→`efa434b`, `24a673d`→`8507c6a`,
`cb7f269`→`d9bbfdd`, `4ac8ee2`→`a3e50d8`, `531b9ac`→`3988ae2`, `89e3ecc`→`507abfc`.

`platform/` applied 2026-09-04: **19 added, 2 changed, 0 destroyed** (`task-7-apply.log`).
`ecs-dynamodb-rps/infra/main`'s remote plan against the renamed workspace: **52 to add, 0 to
change, 0 to destroy** (`task-8-plan.log`), matching the predicted 53 − 2 (k6 project + limits
now in `platform/`) + 1 (throttle rule group). **Not applied** — the first apply is Task 1 of
`docs/superpowers/plans/2026-09-02-ecs-dynamodb-rps-scale-and-measure.md`.

Rulings that changed this plan's text during execution (see the spec's amendments for the two
written at the sentence there too):

- **Ruling P1** — every `platform/` command runs with `env -u TF_WORKSPACE`, because the root
  `.env` exports `TF_WORKSPACE` for the project workspace and `platform/`'s `cloud {}` block names
  its own workspace explicitly. Applied throughout Task 7 and Task 1's `.envrc`/README text.
- **Ruling P3 / Task 1** — the `tfe` provider (0.80, resolved) deprecates `execution_mode` on
  `tfe_workspace`; local/remote mode for both workspaces lives in `tfe_workspace_settings`
  instead, one resource per workspace, imported by workspace id.
- **Ruling T5-1 (Task 5 Step 2)** — `data "grafana_folder"` in provider 3.25.9 looks up by
  `title`, not `uid` (uid is computed-only); `infra/grafana/folder.tf` looks the parent up by
  `title = "high-load-test"` — platform sets uid and title to the same literal, so the lookup
  still names the one folder.
- **Ruling T5-4 (Task 5 Step 7, review round 1)** — the Tier 1.6 throttle rule is two rules (read,
  write) in one `grafana_rule_group`, not one summed rule: `$A + $B` returns no data when either
  CloudWatch series is empty, and CloudWatch publishes throttle events sparsely, so a summed rule
  would go silent during one-sided throttling.
- **Ruling T5-3** — the plan owner's own uncommitted edits (deleting
  `docs/k6-project-as-code.md`, its cross-references, and pre-committing several Task 6 doc
  changes) were treated as a deliberate amendment and folded into Task 6's brief rather than
  reverted.
- **Ruling T4-1 (Task 4 Step 3)** — the plan's literal commit subject was 76 characters;
  `CLAUDE.md`'s ≤72-character rule wins, so the committed subject reads
  `refactor(ecs-dynamodb-rps): rename from ecs-dynamodb-rps-ceiling`.

---

## Global Constraints

1. **No `terraform apply` against `ecs-dynamodb-rps/infra/main` in this plan.** Its first apply
   is Task 1 of the scale-and-measure plan. This plan only `plan`s it (Task 8), and that plan must
   read **N to add, 0 to change, 0 to destroy**.
2. **`terraform apply` on `platform/` is gated** (Task 7). It creates nothing in AWS and nothing
   billable — a TFC workspace rename, a variable set, a Grafana folder, a k6 project — but it is an
   apply, `CLAUDE.md` makes every apply a gate, and this one rewrites the credentials every future
   run will use. Stop for approval.
3. **Every path the tooling reads moves at once.** The SLO generator, its byte-check test, the
   three skills, the Dockerfile context, `.terraformignore`, `.gitignore` and the archive path for
   the heartbeat all encode the old layout. Task 3 lists them; `npm test` and `npm run slo:check`
   are the proof they all moved.
4. **Generated files are regenerated, never edited.** `alerts.tf`, `locals.tf`, `queries.json`,
   `classmap.json`, `tests/lib/slo.js` and `capacity.auto.tfvars` come from `slo.yaml` via
   `npm run slo:generate`; `npm run slo:check` must pass before every commit.
5. **Completed specs and plans are not rewritten.** They get one banner line each (Task 6); the
   SDD ledger and the commit history reference their text and task numbers.
6. **Secrets never enter a project folder or a committed file.** The platform stack reads them
   from the shell (`TF_VAR_*` aliases exported by `.envrc` from `.env`); `.env.example` gains
   names, not values.
7. **Work on a branch** (`restructure/ecs-dynamodb-rps`), one commit per task as listed,
   Conventional Commits with the new scope from the first commit that creates the new directory.

---

## Phase 0 — Branch and ledger

### Task 0: Branch, ledger, preconditions

**Files:** none in the repo.

- [x] **Step 1: Branch from master**

```bash
git checkout master && git pull --ff-only
git checkout -b restructure/ecs-dynamodb-rps
mkdir -p .superpowers/sdd/2026-09-03-ecs-dynamodb-rps-restructure
```

- [x] **Step 2: Re-verify the preconditions with command output, not memory**

```bash
set -a && source .env && set +a
terraform -chdir=ecs-dynamodb-rps-ceiling/terraform state list | wc -l          # must print 0
aws resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=ecs-dynamodb-rps-ceiling \
  --query 'ResourceTagMappingList[].ResourceARN' --output text | tr '\t' '\n' | grep -vE ':ecs:' # must be empty
curl -s -H "Authorization: Bearer $GRAFANA_AUTH" "$GRAFANA_URL/api/folders" | jq -r '.[].title' | grep -c '^high-load-test$'  # 0
```

Record the three outputs in `.superpowers/sdd/2026-09-03-ecs-dynamodb-rps-restructure/task-0-report.md`.
If the first is not 0, **stop** (Status section above).

---

## Phase 1 — The `platform/` stack (written, not applied)

### Task 1: Write `platform/`

**Files:**
- Create: `platform/versions.tf`, `platform/variables.tf`, `platform/tfc.tf`,
  `platform/grafana.tf`, `platform/k6.tf`, `platform/outputs.tf`, `platform/README.md`
- Modify: `.envrc` (export `TFE_TOKEN` and the `TF_VAR_*` aliases), `.env.example` (document
  them; `TF_WORKSPACE=ecs-dynamodb-rps`)

- [x] **Step 1: `versions.tf`** — the cloud block names the project and the workspace
  explicitly, because this stack is the exception to "workspace comes from `TF_WORKSPACE`": it must
  never be run against a project workspace by accident.

```hcl
terraform {
  required_version = "~> 1.14.0"

  cloud {
    workspaces {
      project = "high-load-test"
      name    = "platform"
    }
  }

  required_providers {
    tfe     = { source = "hashicorp/tfe", version = "~> 0.60" }
    grafana = { source = "grafana/grafana", version = "~> 3.0" }
  }
}

# TFE_TOKEN from the shell (.envrc aliases it from TF_TOKEN_app_terraform_io).
provider "tfe" {
  organization = var.tfc_organization
}

# GRAFANA_URL / GRAFANA_AUTH, plus GRAFANA_K6_ACCESS_TOKEN and GRAFANA_STACK_ID for the
# k6 resources — all from the shell. Local execution is the point: this stack creates
# the credentials the remote workspaces run with, so it cannot itself run remotely.
provider "grafana" {}
```

  The `platform` workspace must be **local** execution. HCP creates it in remote mode on `init`;
  Task 7 Step 1 switches it before the first plan, and `tfc.tf` manages it thereafter so it cannot
  drift back.

- [x] **Step 2: `variables.tf`** — one variable per value that leaves `.env` for HCP. All
  sensitive ones marked. No defaults for secrets.

```hcl
variable "tfc_organization" { type = string, default = "failwin" }
variable "tfc_project_name" { type = string, default = "high-load-test" }

# What every project workspace needs. Fed by TF_VAR_* from .envrc; never defaulted.
variable "aws_access_key_id"       { type = string, sensitive = true }
variable "aws_secret_access_key"   { type = string, sensitive = true }
variable "aws_region"              { type = string }
variable "aws_account_id"          { type = string }
variable "grafana_url"             { type = string }
variable "grafana_auth"            { type = string, sensitive = true }
variable "grafana_k6_access_token" { type = string, sensitive = true }
variable "grafana_stack_id"        { type = string }
variable "grafana_otlp_endpoint"   { type = string }
variable "grafana_otlp_username"   { type = string }
variable "grafana_otlp_password"   { type = string, sensitive = true }
variable "grafana_prom_url"        { type = string }
variable "grafana_prom_username"   { type = string }
variable "grafana_prom_password"   { type = string, sensitive = true }

# k6 project limits. These are the LIVE values read by importing the hand-made project on
# 2026-09-01; an unset attribute is sent as null and resets the live value, so all four
# stay explicit forever.
variable "k6_vu_max_per_test"         { type = number, default = 25000 }
variable "k6_vu_browser_max_per_test" { type = number, default = 1000 }
variable "k6_vuh_max_per_month"       { type = number, default = 50000 }
variable "k6_duration_max_per_test"   { type = number, default = 18000 }
```

- [x] **Step 3: `tfc.tf`** — project (imported in Task 7), one workspace per repo project, the
  variable set attached to the project, and the variables in it.

```hcl
resource "tfe_project" "this" {
  name = var.tfc_project_name
}

# The platform workspace manages itself: local execution, so it never drifts back to remote.
resource "tfe_workspace" "platform" {
  name           = "platform"
  project_id     = tfe_project.this.id
  execution_mode = "local"
  description    = "Owns the TFC project, the project workspaces, the shared variable set, the shared Grafana folder and the k6 projects. See docs/superpowers/specs/2026-09-02-ecs-dynamodb-rps-restructure-design.md section 6."
  tag_names      = ["high-load-test", "platform"]
}

locals {
  # One entry per repo project directory. Adding a project is adding a line here.
  projects = {
    "ecs-dynamodb-rps" = { working_directory = "infra/main" }
  }
}

resource "tfe_workspace" "project" {
  for_each = local.projects

  name              = each.key
  project_id        = tfe_project.this.id
  execution_mode    = "remote"
  working_directory = each.value.working_directory
  terraform_version = "~> 1.14.0"   # Tier 1.3 — matches required_version and the README
  auto_apply        = false
  queue_all_runs    = false
  description       = "Scenario ${each.key}. Root module at ${each.key}/${each.value.working_directory}; the upload root is ${each.key}/ so ../grafana, ../k6 and ../../heartbeat resolve."
  tag_names         = ["high-load-test", each.key]
}

resource "tfe_variable_set" "shared" {
  name        = "high-load-test"
  description = "Credentials and endpoints every project workspace needs. Values come from the root .env via TF_VAR_*; this is the only copy in HCP."
}

resource "tfe_project_variable_set" "shared" {
  project_id      = tfe_project.this.id
  variable_set_id = tfe_variable_set.shared.id
}

locals {
  env_vars = {
    AWS_ACCESS_KEY_ID       = { value = var.aws_access_key_id, sensitive = true }
    AWS_SECRET_ACCESS_KEY   = { value = var.aws_secret_access_key, sensitive = true }
    AWS_REGION              = { value = var.aws_region, sensitive = false }
    GRAFANA_URL             = { value = var.grafana_url, sensitive = false }
    GRAFANA_AUTH            = { value = var.grafana_auth, sensitive = true }
    GRAFANA_K6_ACCESS_TOKEN = { value = var.grafana_k6_access_token, sensitive = true }
    GRAFANA_STACK_ID        = { value = var.grafana_stack_id, sensitive = false }
  }
  tf_vars = {
    aws_account_id        = { value = var.aws_account_id, sensitive = false }
    grafana_otlp_endpoint = { value = var.grafana_otlp_endpoint, sensitive = false }
    grafana_otlp_username = { value = var.grafana_otlp_username, sensitive = false }
    grafana_otlp_password = { value = var.grafana_otlp_password, sensitive = true }
    grafana_prom_url      = { value = var.grafana_prom_url, sensitive = false }
    grafana_prom_username = { value = var.grafana_prom_username, sensitive = false }
    grafana_prom_password = { value = var.grafana_prom_password, sensitive = true }
  }
}

resource "tfe_variable" "env" {
  for_each        = local.env_vars
  key             = each.key
  value           = each.value.value
  category        = "env"
  sensitive       = each.value.sensitive
  variable_set_id = tfe_variable_set.shared.id
}

resource "tfe_variable" "terraform" {
  for_each        = local.tf_vars
  key             = each.key
  value           = each.value.value
  category        = "terraform"
  sensitive       = each.value.sensitive
  variable_set_id = tfe_variable_set.shared.id
}
```

  Deliberately **absent**: `GRAFANA_SM_ACCESS_TOKEN` (unused since the heartbeat replaced
  Synthetic Monitoring) and `read_capacity` / `write_capacity` (they duplicate `dev.tfvars` and
  outrank it in a remote run) — Tier 1.7. Task 7 Step 4 deletes the workspace-level copies.

- [x] **Step 4: `grafana.tf`** — the parent folder, with a fixed uid so projects can find it
  without reading this state.

```hcl
resource "grafana_folder" "root" {
  uid   = "high-load-test"
  title = "high-load-test"
}
```

- [x] **Step 5: `k6.tf`** — the k6 project per repo project, named after it, and its limits.
  Moved here from `ecs-dynamodb-rps-ceiling/grafana/k6.tf` (spec 7.2); the long comment about
  the E2004 upload cap and the four explicit limits moves with it, verbatim.

```hcl
resource "grafana_k6_project" "project" {
  for_each = local.projects
  name     = each.key
}

resource "grafana_k6_project_limits" "project" {
  for_each   = local.projects
  project_id = grafana_k6_project.project[each.key].id

  vu_max_per_test         = var.k6_vu_max_per_test
  vu_browser_max_per_test = var.k6_vu_browser_max_per_test
  vuh_max_per_month       = var.k6_vuh_max_per_month
  duration_max_per_test   = var.k6_duration_max_per_test
}
```

- [x] **Step 6: `outputs.tf`** — `workspace_ids`, `variable_set_id`, `grafana_root_folder_uid`,
  and `k6_project_ids` (map). The k6 id is what `K6_CLOUD_PROJECT_ID` in `.env` is set from —
  once, now that it is stable.

- [x] **Step 7: `.envrc`** — alias, do not duplicate. Append:

```bash
# The tfe provider reads TFE_TOKEN; same token as the CLI's. Alias, never a second copy.
export TFE_TOKEN="${TF_TOKEN_app_terraform_io:-}"
# platform/ takes its inputs as Terraform variables; alias them from the .env names so
# .env stays the single definition point.
export TF_VAR_aws_access_key_id="${AWS_ACCESS_KEY_ID:-}"
export TF_VAR_aws_secret_access_key="${AWS_SECRET_ACCESS_KEY:-}"
export TF_VAR_aws_region="${AWS_REGION:-}"
export TF_VAR_aws_account_id="${AWS_ACCOUNT_ID:-}"
export TF_VAR_grafana_url="${GRAFANA_URL:-}"
export TF_VAR_grafana_auth="${GRAFANA_AUTH:-}"
export TF_VAR_grafana_k6_access_token="${GRAFANA_K6_ACCESS_TOKEN:-}"
export TF_VAR_grafana_stack_id="${GRAFANA_STACK_ID:-}"
export TF_VAR_grafana_otlp_endpoint="${GRAFANA_OTLP_ENDPOINT:-}"
export TF_VAR_grafana_otlp_username="${GRAFANA_OTLP_USERNAME:-}"
export TF_VAR_grafana_otlp_password="${GRAFANA_OTLP_PASSWORD:-}"
export TF_VAR_grafana_prom_url="${K6_PROMETHEUS_RW_SERVER_URL:-}"
export TF_VAR_grafana_prom_username="${K6_PROMETHEUS_RW_USERNAME:-}"
export TF_VAR_grafana_prom_password="${K6_PROMETHEUS_RW_PASSWORD:-}"
```

  `.env.example`: set `TF_WORKSPACE=ecs-dynamodb-rps` in the comment and value, and add a
  short block saying `platform/` reads the same file through the aliases in `.envrc`, so nothing
  new has to be filled in. `direnv allow` after editing.

- [x] **Step 8: `platform/README.md`** — what it owns, the bootstrap sequence (Task 7), how to
  add a project (one line in `local.projects`), and the one thing it cannot do (run remotely).

- [x] **Step 9: Verify**

```bash
terraform -chdir=platform fmt -check && terraform -chdir=platform fmt -diff
```

  `validate` needs `init`, which needs the cloud backend; that is Task 7. `fmt` is the check here.

- [x] **Step 10: Commit** — `feat(platform): manage the tfc project, workspaces, credentials, shared grafana folder and k6 project as code`

---

## Phase 2 — The project directory

### Task 2: Move the files

**Files:** everything under `ecs-dynamodb-rps-ceiling/` → `ecs-dynamodb-rps/` per spec 4.1.
`git mv` throughout so history follows.

- [x] **Step 1: Directory rename and the new tree**

```bash
git mv ecs-dynamodb-rps-ceiling ecs-dynamodb-rps
cd ecs-dynamodb-rps
mkdir -p infra service
git mv terraform infra/main
git mv grafana  infra/grafana
mkdir -p infra/k6 && git mv k6 infra/k6/tests
for f in src test scripts Dockerfile .dockerignore docker-compose.test.yml package.json package-lock.json pricing.json capacity-model.html; do git mv "$f" service/; done
# heartbeat/ stays where it is (project top level). slo.yaml, README.md, .terraformignore stay.
rm -f infra/main/tfplan-*          # untracked plan files from earlier sessions
cd ..
git status --short | head -40
```

- [x] **Step 2: `.gitignore`**

```
!ecs-dynamodb-rps/infra/main/capacity.auto.tfvars
```

  replaces the old `!ecs-dynamodb-rps-ceiling/terraform/capacity.auto.tfvars`. Check with
  `git check-ignore -v ecs-dynamodb-rps/infra/main/capacity.auto.tfvars` — it must print nothing.

- [x] **Step 3: `.terraformignore`** at `ecs-dynamodb-rps/.terraformignore`

```
# Upload root for HCP CLI-driven runs is this directory, because the workspace's
# working directory is infra/main. That is what makes ../grafana, ../k6 and
# ../../heartbeat resolve in a remote run. Nothing below is needed by a plan.
service/
infra/k6/tests/
*.md
*.html
infra/main/.terraform/
infra/main/tfplan*
```

  `heartbeat/` is deliberately not listed: `archive_file` zips it during the remote plan.

- [x] **Step 4: No commit yet** — the tree does not build until Task 3.

### Task 3: Make the tooling follow the moves

**Files:**
- Modify: `ecs-dynamodb-rps/service/scripts/generate-slo.js` (output paths),
  `ecs-dynamodb-rps/service/test/generate-slo.test.js` (read paths),
  `ecs-dynamodb-rps/service/.dockerignore` (drop `terraform`, `k6`, `grafana`; they are no longer
  under the context; the Dockerfile itself is unchanged, its context is now `service/`),
  `ecs-dynamodb-rps/infra/main/heartbeat.tf` (archive path)

- [x] **Step 1: Generator output paths** — the table at the bottom of `generate-slo.js`:

```js
const OUTPUTS = [
  ['infra/k6/tests/lib/slo.js', renderK6],
  ['infra/main/capacity.auto.tfvars', renderCapacityTfvars],
  ['infra/grafana/classmap.json', renderClassMap],
  ['infra/grafana/alerts.tf', renderAlerts],
  ['infra/grafana/locals.tf', renderLocals],
  ['infra/grafana/queries.json', renderQueries],
];
const root = new URL('../..', import.meta.url).pathname;   // service/scripts → project root
```

  and `loadSlo` is called with `${root}slo.yaml`. The test file's `HERE` becomes the project root
  the same way (`new URL('../../', import.meta.url)`), and every `readFileSync(\`${HERE}…\`)` path
  changes to the new location. `dev.tfvars` is read at `infra/main/dev.tfvars`.

- [x] **Step 2: Heartbeat archive path** in `infra/main/heartbeat.tf`:

```hcl
data "archive_file" "heartbeat" {
  type        = "zip"
  source_dir  = "${path.module}/../../heartbeat"
  output_path = "${path.module}/.terraform/heartbeat.zip"
}
```

- [x] **Step 3: Run the tests from `service/`**

```bash
cd ecs-dynamodb-rps/service && npm ci && npm test && npm run slo:check && cd ../..
```

  `slo:check` must report no drift **before** the rename in Task 4 — this step proves only that
  the paths moved. If it reports drift now, a path is wrong, not the content.

- [x] **Step 4: Commit** — `refactor(ecs-dynamodb-rps)!: split the project into infra, service and heartbeat`
  with body naming the new tree and footer:

```
BREAKING CHANGE: the Terraform root moved from terraform/ to infra/main and the HCP
workspace working directory must follow it (platform/ sets it). No AWS resource is
affected; the environment was destroyed on 2026-09-02 and the state is empty.
```

### Task 4: The rename inside the files

**Files:**
- Modify: `ecs-dynamodb-rps/slo.yaml` (`service:`), `infra/main/variables.tf` (`var.project`
  default), `service/src/config.js`, `service/src/otel.js`, `service/src/cpu.js`,
  `infra/k6/tests/{constant,discovery,stress}.js` (test names), `infra/grafana/dashboard.json.tftpl`
  (title and the `project` template variable default), `service/test/{config,otel,generate-slo}.test.js`,
  `service/package.json` (`name`), `service/package-lock.json` (`name`, two places)
- Regenerate: `infra/grafana/{alerts.tf,locals.tf,queries.json,classmap.json}`,
  `infra/k6/tests/lib/slo.js`, `infra/main/capacity.auto.tfvars`

- [x] **Step 1: Replace the literal in code and tests**

```bash
cd ecs-dynamodb-rps
grep -rl 'ecs-dynamodb-rps-ceiling' slo.yaml infra/main/variables.tf service/src service/test service/package.json service/package-lock.json infra/k6/tests infra/grafana/dashboard.json.tftpl \
  | xargs sed -i '' 's/ecs-dynamodb-rps-ceiling/ecs-dynamodb-rps/g'
grep -rn 'ecs-dynamodb-rps-ceiling' --exclude-dir=node_modules . || echo "clean (generated files next)"
```

  The one hit that must remain after this step is in the generated files, which Step 2 rewrites.
  `tests/lib/request.js` cites a spec filename in a comment — leave it; it names a real file.

- [x] **Step 2: Regenerate and re-test**

```bash
cd service && npm run slo:generate && npm test && npm run slo:check && cd ..
git diff --stat
```

  Expected diff in the generated files: the `job="…"` selector and the six rule-group names only.
  Anything else in that diff is a generator change that does not belong to this task.

- [x] **Step 3: Commit** — `refactor(ecs-dynamodb-rps): rename the project from ecs-dynamodb-rps-ceiling`

### Task 5: Terraform changes in `infra/` — modules, folder, k6, Tier 1

**Files:**
- Modify: `infra/main/versions.tf`, `infra/main/grafana.tf`, `infra/main/outputs.tf`,
  `infra/main/variables.tf`, `infra/main/ecs.tf`, `infra/main/collector.tf`,
  `infra/main/network.tf` (precondition host), `infra/grafana/folder.tf`,
  `infra/grafana/variables.tf`, `infra/grafana/outputs.tf`, `infra/grafana/alloy.alloy.tftpl`
- Delete: `infra/grafana/k6.tf`
- Create: `infra/k6/versions.tf`, `infra/k6/main.tf`, `infra/k6/variables.tf`,
  `infra/k6/outputs.tf`, `infra/grafana/throttles.tf`
- Modify (generator): `service/scripts/generate-slo.js` + test, for the annotations (Tier 1.4)
  and the dropped throttle queries (Tier 1.8)

- [x] **Step 1: Comments that describe the old layout** — `versions.tf` (the long comment about
  `working-directory = "terraform"` and `../grafana`), `grafana.tf` (the `moved` blocks: the state
  is empty, so they no longer move anything — delete them, and say so in the commit body),
  `collector.tf` (`../grafana/…` paths are unchanged and correct). Rewrite the `versions.tf`
  comment to name `infra/main`, `../grafana`, `../k6`, `../../heartbeat` and the upload root.

- [x] **Step 2: Nested folder (spec 7.1)** in `infra/grafana/folder.tf`:

```hcl
# The parent is owned by platform/ and found by its FIXED uid — a string, not a state read,
# so this project stays independent of the platform state.
data "grafana_folder" "root" {
  uid = "high-load-test"
}

resource "grafana_folder" "project" {
  title             = var.project
  parent_folder_uid = data.grafana_folder.root.uid
}
```

- [x] **Step 3: k6 module (spec 7.2)** — delete `infra/grafana/k6.tf`, its four `k6_*`
  variables from `infra/grafana/variables.tf` and the `k6_project_id` output from
  `infra/grafana/outputs.tf`. Create `infra/k6/`:

```hcl
# versions.tf
terraform {
  required_providers {
    grafana = { source = "grafana/grafana", version = "~> 3.0" }
  }
}

# main.tf — the project lives in platform/ and survives /env down; this module only finds it.
# The three load profiles in tests/ are uploaded to it BY HAND (spec 7.3); BASE_URL and RATE
# are set once on the k6 settings page, not once per apply, because the id no longer changes.
data "grafana_k6_projects" "this" {
  name = var.project
}

# variables.tf
variable "project" { type = string }

# outputs.tf
output "k6_project_id" {
  description = "Stable id of the Grafana Cloud k6 project owned by platform/. K6_CLOUD_PROJECT_ID in .env and the README links are set from it once."
  value       = one(data.grafana_k6_projects.this.projects).id
}
```

  Verify the data source's attribute name against provider 3.25.9 docs at execution time
  (`projects` list with `id`); adjust `one(...)` accordingly. In `infra/main/grafana.tf` add
  `module "k6" { source = "../k6"  project = var.project }` and point
  `output "k6_project_id"` at `module.k6.k6_project_id`.

- [x] **Step 4: Tier 1.1 — account precondition.** In `infra/main/variables.tf` add
  `variable "aws_account_id" { type = string }` (value comes from the variable set). In
  `versions.tf` add `data "aws_caller_identity" "current" {}`. In `network.tf`, on
  `aws_vpc.main` — the resource everything depends on, so a wrong account fails the plan before
  anything is proposed:

```hcl
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.aws_account_id
      error_message = "Refusing to plan against account ${data.aws_caller_identity.current.account_id}; this project belongs to ${var.aws_account_id}. Check which credentials the run carries."
    }
  }
```

- [x] **Step 5: Tier 1.2 — tags.** `default_tags` in `versions.tf`:

```hcl
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
      Workspace = var.project
    }
```

- [x] **Step 6: Tier 1.5 — circuit breaker** on `aws_ecs_service.app` and
  `aws_ecs_service.collector`:

```hcl
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
```

- [x] **Step 7: Tier 1.6 — throttle rule** in `infra/grafana/throttles.tf`: one
  `grafana_rule_group "dynamodb_throttles"`, folder `grafana_folder.project.uid`, interval 60s,
  rule "DynamoDB throttling", `for = "2m"`. Data: **A** CloudWatch datasource
  (`var.cloudwatch_datasource_uid`), model `{ region = "eu-central-1", namespace = "AWS/DynamoDB",
  metricName = "ReadThrottleEvents", statistic = "Sum", period = "60", dimensions = { TableName =
  var.project }, metricQueryType = 0, metricEditorMode = 0 }`; **B** the same for
  `WriteThrottleEvents`; **C** math `$A + $B`; **D** reduce last of C; **E** threshold gt 0.
  `no_data_state = "OK"`, `exec_err_state = "Error"`, `notification_settings` as the other
  rules, labels `severity = "ticket"`, `slo = "database"`, annotations: summary "DynamoDB rejected
  requests for 2 minutes; every service-side signal is red for a database-side cause until this
  clears — read this before the latency panels.", plus `runbook_url`, `__dashboardUid__ =
  grafana_dashboard.attribution.uid` and `__panelId__ = "2"` (the throttle panel). Model the
  `relative_time_range` on `canary.tf`. The CloudWatch datasource's default region is us-east-1,
  hence the explicit region.

- [x] **Step 8: Tier 1.4 — annotations, in the generator.** In `renderAlerts`, every rule's
  `annotations` block gains:

```hcl
      runbook_url      = "https://github.com/<org>/high-load-test/blob/master/ecs-dynamodb-rps/README.md#6-is-it-about-to-break"
      __dashboardUid__ = grafana_dashboard.attribution.uid
      __panelId__      = "19"
```

  with panel `19` (SLI ratio) for the six burn rules. `__dashboardUid__` is an HCL reference, not
  a string: the generator emits it unquoted. Take `<org>` from `git remote get-url origin`.
  Update `generate-slo.test.js` expectations.

- [x] **Step 9: Tier 1.8 — trim the Alloy CloudWatch block.** In
  `infra/grafana/alloy.alloy.tftpl`, the `discovery { type = "AWS/DynamoDB" … }` block keeps
  **only** the `SuccessfulRequestLatency` metric (`statistics = ["Average", "Maximum"]`); delete
  the `ThrottledRequests`, `ReadThrottleEvents`, `WriteThrottleEvents`,
  `ConsumedReadCapacityUnits` and `ConsumedWriteCapacityUnits` `metric {}` blocks. Rewrite the
  comment under the block: it no longer "keeps six per D2"; it keeps one, for the join, and
  everything else is read live from CloudWatch (dashboard, the throttle rule, `/loadtest`). In
  `generate-slo.js` `renderQueries`, delete the `read_throttle_events` and
  `write_throttle_events` entries (and the comment above them about `max by`); update
  `generate-slo.test.js` (the test around line 150 that asserts those two keys). The dashboard is
  unaffected (its throttle panel reads CloudWatch, D1).

- [x] **Step 10: Regenerate, format, validate what can be validated**

```bash
cd ecs-dynamodb-rps/service && npm run slo:generate && npm test && npm run slo:check && cd ../..
terraform -chdir=ecs-dynamodb-rps/infra/main fmt -recursive -check
terraform -chdir=ecs-dynamodb-rps/infra/grafana fmt -check
terraform -chdir=ecs-dynamodb-rps/infra/k6 fmt -check
grep -c 'aws_dynamodb_' ecs-dynamodb-rps/infra/grafana/queries.json   # only the SuccessfulRequestLatency queries remain
```

  `validate` on `infra/main` needs `init` against the renamed workspace — Task 8.

- [x] **Step 11: Commit** — `feat(ecs-dynamodb-rps/terraform): nested grafana folder, k6 project by name, account precondition, circuit breaker, throttle rule, alert deep links, alloy trimmed to one metric`
  Body: lists Tier 1.1, 1.2, 1.4, 1.5, 1.6, 1.8 by number, and notes the `moved` blocks were
  deleted because the state they moved is empty.

---

## Phase 3 — Documents, skills, configuration

### Task 6: Skills, `CLAUDE.md`, READMEs, notes, the draft plan, the banners

**Files:**
- Modify: `.claude/skills/env/SKILL.md`, `.claude/skills/loadtest/SKILL.md`,
  `.claude/skills/slo/SKILL.md`, `.claude/skills/piib/SKILL.md`, `CLAUDE.md`, `README.md`,
  `ecs-dynamodb-rps/README.md`, `docs/slo-burn-alerting.md`,
  `docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-datasource-fidelity-design.md` (D2
  forward-pointer)
- Rename + modify: `docs/superpowers/plans/2026-09-02-ecs-dynamodb-rps-ceiling-scale-and-measure.md`
  → `docs/superpowers/plans/2026-09-02-ecs-dynamodb-rps-scale-and-measure.md`
- Modify (one banner line each): the six specs and seven plans dated 2026-08-29 … 2026-09-02
  that carry the old name

- [x] **Step 1: Skills.** Every `<project>/terraform` → `<project>/infra/main`,
  `<project>/k6/<profile>.js` → `<project>/infra/k6/tests/<profile>.js`, `k6/lib/env.js` →
  `infra/k6/tests/lib/env.js`, `<project>/grafana/queries.json` → `<project>/infra/grafana/queries.json`,
  `<project>/terraform/capacity.auto.tfvars` → `<project>/infra/main/capacity.auto.tfvars`,
  `<project>/k6/lib/slo.js` → `<project>/infra/k6/tests/lib/slo.js`, `<project>/grafana/alerts.tf`
  → `<project>/infra/grafana/alerts.tf`. `npm` commands in the skills run from
  `<project>/service`. `/env` gains one sentence: the platform stack is brought up with
  `terraform -chdir=platform apply` and is not part of `/env up|down`.

  **`/loadtest`, Tier 1.8:** the "Read the server-side numbers from Grafana" loop keeps
  `sli_ratio` and `cpu_saturation_ratio` and drops the two throttle keys; the `throttles`
  column is read **directly from CloudWatch** over the run window, per-60s Sum, peak of each:

```bash
TABLE=$(terraform -chdir=<project>/infra/main output -raw table_name)
for m in ReadThrottleEvents WriteThrottleEvents; do
  printf '%-20s ' "$m"
  aws cloudwatch get-metric-statistics --namespace AWS/DynamoDB --metric-name "$m" \
    --dimensions Name=TableName,Value="$TABLE" --statistics Sum --period 60 \
    --start-time "$RUN_START" --end-time "$RUN_END" \
    --query 'max(Datapoints[].Sum) || `0`' --output text
done
```

  `RUN_START`/`RUN_END` are the run's own timestamps in UTC ISO-8601; `aws cloudwatch
  get-metric-statistics` is already on the permission allowlist. Update the "verified live"
  paragraph to say the two throttle readings now come from CloudWatch, and keep the `read/write`
  recording convention unchanged.

- [x] **Step 2: `CLAUDE.md`** — amendments, each with a pointer to the spec at the sentence:
  - the project tree under "Layout" becomes `infra/{main,grafana,k6}`, `heartbeat/`, `service/`,
    `slo.yaml`, `results.md`, `README.md`;
  - "Global (repo root) holds only shared credentials/config" gains: "…and `platform/`, the one
    Terraform root that is not a project: it owns the TFC project, the project workspaces, the
    shared variable set, the Grafana folder `high-load-test` and the k6 projects";
  - "State lives in Terraform Cloud, one workspace per project" gains "plus the `platform`
    workspace";
  - the "renaming later orphans tagged resources" sentence gains: "(done once, on 2026-09-03,
    while nothing was deployed — see the restructure spec)";
  - "Working commands" paths: `terraform -chdir=infra/main …`, `k6 run infra/k6/tests/<profile>.js`,
    Node commands from `service/`.

- [x] **Step 3: Project `README.md`.** Paths (`terraform -chdir=terraform` → `-chdir=infra/main`,
  `k6/` → `infra/k6/tests/`, `npm` from `service/`), the k6 project row and the "id changes on
  every apply" sentences (now stable; set `K6_CLOUD_PROJECT_ID` once from
  `terraform -chdir=platform output -json k6_project_ids`), the Phase 9 teardown paragraph about
  the k6 project (no longer destroyed with the environment), the "Known gaps" entries about the
  unstable id and the hand-made `8474786` (delete once Task 7 confirms it is gone), the Grafana
  folder (now `high-load-test / ecs-dynamodb-rps`), and section 5's mention of the forwarded
  throttle series (now read from CloudWatch). Root `README.md`: the layout block, the workspace
  sentence, the k6 id paragraph, and one line introducing `platform/`.

- [x] **Step 4: Forward-pointers.** The standalone note that recorded the "created, never
  imported, new id on every apply" k6 decision was **deleted on 2026-09-04** — every fact in it
  was duplicated in the project README and the Terraform comments, and the decision itself is
  reversed by section 7.2 — so there is nothing left to forward-point at; commit `901b97d` is
  the record. Its "why the load tests stay uploaded by hand" reasoning survives in the comment
  header of the k6 Terraform file. The datasource-fidelity spec's D2 row gets appended:
  *"Amended again 2026-09-03: the block is trimmed to `SuccessfulRequestLatency` only;
  `ThrottledRequests` and the four other DynamoDB metric-statistics are dropped. The join argument
  stands; the 'a future alert would want PromQL over them' argument did not survive — the throttle
  alert reads CloudWatch directly. See the restructure spec, Tier 1.8."*
  `docs/slo-burn-alerting.md` footer: paths.

- [x] **Step 5: The draft plan** — `git mv` to the new filename; `sed` the project name and the
  paths (`terraform -chdir=terraform` → `-chdir=infra/main`, `k6/` → `infra/k6/tests/`,
  `src/otel.js` → `service/src/otel.js`, `k6/lib/request.js` → `infra/k6/tests/lib/request.js`);
  add under its Status: "Renamed and re-pathed 2026-09-03 by the restructure plan; Task 1 Step 1's
  note about deleting the workspace variables is **done** by that plan (Task 7 Step 4) — skip it."

- [x] **Step 6: Banners** on the thirteen completed documents, one line directly under the
  status line:

```
> Project renamed to `ecs-dynamodb-rps` on 2026-09-03; paths and names below are pre-rename. See `docs/superpowers/specs/2026-09-02-ecs-dynamodb-rps-restructure-design.md`.
```

```bash
ls docs/superpowers/specs/2026-08-*.md docs/superpowers/specs/2026-09-01-*.md \
   docs/superpowers/plans/2026-08-*.md docs/superpowers/plans/2026-09-01-*.md \
   docs/superpowers/plans/2026-09-02-ecs-dynamodb-rps-ceiling-review-fixes.md
```

  lists them; insert by hand after each `Status` line (they are not uniformly formatted).

- [x] **Step 7: Sweep**

```bash
grep -rn 'ecs-dynamodb-rps-ceiling' --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.superpowers . \
  | grep -vE 'docs/superpowers/(specs|plans)/2026-0(8|9-01|9-02-ecs-dynamodb-rps-ceiling-review)' \
  | grep -vE 'restructure-design|request.js'
```

  Expected: nothing except deliberate history references. Every remaining hit is either a banner
  target already done or a bug.

- [x] **Step 8: Commit** — `docs(repo): follow the ecs-dynamodb-rps rename and the infra/service split`

---

## Phase 4 — Bring the platform up, verify the project plans

### Task 7: APPROVAL GATE — bootstrap `platform/`, import, apply

**Files:** none new. Creates in HCP: workspace `platform`, variable set `high-load-test` with 14
variables; renames workspace `ws-pPiZ7mfesjrzZ8sx`; creates in Grafana: folder `high-load-test`,
k6 project `ecs-dynamodb-rps` with limits. **Nothing in AWS, nothing billable.** Still an apply;
still a gate.

- [x] **Step 1: Init and switch the platform workspace to local execution**

```bash
set -a && source .env && set +a && direnv allow 2>/dev/null; eval "$(direnv export zsh)" 2>/dev/null
terraform -chdir=platform init            # HCP creates workspace "platform" in project high-load-test, REMOTE mode
WS=$(curl -s -H "Authorization: Bearer $TF_TOKEN_app_terraform_io" \
  "https://app.terraform.io/api/v2/organizations/$TF_CLOUD_ORGANIZATION/workspaces/platform" | jq -r .data.id)
curl -s -X PATCH -H "Authorization: Bearer $TF_TOKEN_app_terraform_io" -H 'Content-Type: application/vnd.api+json' \
  "https://app.terraform.io/api/v2/workspaces/$WS" \
  -d '{"data":{"type":"workspaces","attributes":{"execution-mode":"local"}}}' | jq -r '.data.attributes["execution-mode"]'
```

  This one PATCH is the bootstrap's single hand-made change, and `tfe_workspace.platform` owns
  the setting from the first apply onward. Expected output: `local`.

- [x] **Step 2: Import what already exists**

```bash
terraform -chdir=platform import tfe_project.this prj-nMQTAXZhsqXfKWAo
terraform -chdir=platform import tfe_workspace.platform "$WS"
terraform -chdir=platform import 'tfe_workspace.project["ecs-dynamodb-rps"]' ws-pPiZ7mfesjrzZ8sx
```

  Executed 2026-09-04: the `tfe_workspace_settings` resources for both workspaces (Ruling P3) were
  imported here too (import id = workspace id), five imports total. Every command in this step —
  and Steps 1, 3 and 4 — ran with `env -u TF_WORKSPACE` (Ruling P1), because the root `.env`
  exports `TF_WORKSPACE=ecs-dynamodb-rps` for the project workspace and `platform/`'s own
  `cloud {}` block must not inherit it.

- [x] **Step 3: Plan and read it**

```bash
terraform -chdir=platform validate && terraform -chdir=platform plan -out=tfplan
```

  Expected: `tfe_workspace.project["ecs-dynamodb-rps"]` **updated in place** (name
  `ecs-dynamodb-rps-ceiling` → `ecs-dynamodb-rps`, working directory `terraform` → `infra/main`,
  terraform version → `~> 1.14.0`, tags, description); `tfe_workspace.platform` updated in place
  (description, tags); `tfe_project.this` no change or description only; **created**: the variable
  set, its project attachment, 14 `tfe_variable`, `grafana_folder.root`, one `grafana_k6_project`
  and its limits. **0 to destroy.** If the plan proposes to replace the project workspace, stop —
  a replace would delete its (empty) state and its run history; the name change must be in place.

- [x] **Step 4: STOP — get explicit approval, then apply**

```bash
terraform -chdir=platform apply tfplan
terraform -chdir=platform output
```

  Then the one-time cleanup of the hand-set workspace variables, which the variable set now
  supersedes (Tier 1.7). They are not in any state, so this is a scripted delete, run once:

```bash
for v in $(curl -s -H "Authorization: Bearer $TF_TOKEN_app_terraform_io" \
  "https://app.terraform.io/api/v2/workspaces/ws-pPiZ7mfesjrzZ8sx/vars" | jq -r '.data[].id'); do
  curl -s -o /dev/null -w "%{http_code} $v\n" -X DELETE -H "Authorization: Bearer $TF_TOKEN_app_terraform_io" \
    "https://app.terraform.io/api/v2/workspaces/ws-pPiZ7mfesjrzZ8sx/vars/$v"
done   # sixteen 204s
curl -s -H "Authorization: Bearer $TF_TOKEN_app_terraform_io" "https://app.terraform.io/api/v2/workspaces/ws-pPiZ7mfesjrzZ8sx/vars" | jq '.data | length'   # 0
```

- [x] **Step 5: Set the stable k6 id once, delete the old project**

```bash
terraform -chdir=platform output -json k6_project_ids | jq -r '."ecs-dynamodb-rps"'
```

  Put it in `.env` as `K6_CLOUD_PROJECT_ID`. In the k6 app, delete the hand-made project
  `8474786` if it still exists, then upload `infra/k6/tests/{discovery,constant,stress}.js` into
  the new project and set `BASE_URL` / `RATE` on its settings page **after** the next `/env up`
  (the ALB does not exist yet). Record in the ledger.

  Checked 2026-09-04 via the k6 API: `8474786` was already gone — nothing to delete. The two
  projects on the stack are `5607051` ("Default project") and `8476029` ("ecs-dynamodb-rps"), the
  latter now set as `K6_CLOUD_PROJECT_ID`. Uploading the test scripts and setting `BASE_URL`/`RATE`
  remain a hand step after the next `/env up`.

- [x] **Step 6: Verify Grafana**

```bash
curl -s -H "Authorization: Bearer $GRAFANA_AUTH" "$GRAFANA_URL/api/folders/high-load-test" | jq '{uid,title}'
```

### Task 8: Plan `infra/main` against the renamed workspace — no apply

**Files:** none.

- [x] **Step 1: Init on the renamed workspace**

```bash
export TF_WORKSPACE=ecs-dynamodb-rps     # and fix the line in .env
rm -rf ecs-dynamodb-rps/infra/main/.terraform
terraform -chdir=ecs-dynamodb-rps/infra/main init
terraform -chdir=ecs-dynamodb-rps/infra/main validate
```

- [x] **Step 2: Remote plan**

```bash
terraform -chdir=ecs-dynamodb-rps/infra/main plan -var-file=dev.tfvars
```

  Expected: **N to add, 0 to change, 0 to destroy**, where N = the 53 the last plan on the empty
  environment counted, **minus 2** (k6 project and limits left for `platform/`), **plus 1** (the
  throttle rule group). The run log must show the upload root as `ecs-dynamodb-rps/` (the
  `../grafana` and `../../heartbeat` reads succeed), the account precondition passing, the k6
  data source resolving to the id from Task 7 Step 5, the collector task definition's Alloy config
  carrying one CloudWatch metric, and every tag set carrying `ManagedBy`. Record the summary line
  and the resource count in the ledger. **Do not apply.**

  Recorded 2026-09-04: **52 to add, 0 to change, 0 to destroy** (Terraform v1.14.9 on HCP). Not
  applied.

- [x] **Step 3: Commit** — nothing new to commit unless Step 1 or 2 forced a fix; if so,
  `fix(ecs-dynamodb-rps/terraform): …` naming what the remote plan revealed.

---

## Phase 5 — Finish

### Task 9: Statuses, merge

**Files:**
- Modify: `docs/superpowers/specs/2026-09-02-ecs-dynamodb-rps-restructure-design.md` (status
  → `complete`, with the platform apply date and the Task 8 plan count), this plan (status →
  `complete`, ledger summary)
- Memory: update `restructure-decisions-pending` (plan executed; next is the scale-and-measure
  plan under the new name, then the Tier 2 plans)

- [x] **Step 1: Statuses and the ledger** — every task's report in
  `.superpowers/sdd/2026-09-03-ecs-dynamodb-rps-restructure/`, `progress.md` with the commit
  hashes.
- [x] **Step 2: `npm test`, `npm run slo:check`, `terraform fmt -check` on all three roots, the
  Task 6 Step 7 sweep — all clean.**
- [x] **Step 3: Commit** — `docs(ecs-dynamodb-rps): close the restructure plan`
- [x] **Step 4: Merge** — `superpowers:finishing-a-development-branch`: squash or merge
  `restructure/ecs-dynamodb-rps` into `master`. The branch `k6-project-as-code` (commit `901b97d`,
  never applied) is superseded by this one; delete it after the merge and say so in the merge
  commit body.

---

## What this plan deliberately leaves for the next ones

- **The first apply of `ecs-dynamodb-rps/infra/main`** — Task 1 of
  `docs/superpowers/plans/2026-09-02-ecs-dynamodb-rps-scale-and-measure.md`.
- **Tier 2, one plan each after the numbers exist:** 2.2 notification policy (all to Slack) +
  mute timing, 2.4 AWS Budget, 2.6 recording rule, 2.7 two-window burn confirmation, 2.9 GitHub
  Actions checks, 2.10 Container Insights, 2.11 the Grafana SLO built-in alerting trial (needs a
  load run to compare against, so it follows scale-and-measure).
- Dropping the last forwarded DynamoDB metric too (`SuccessfulRequestLatency`), which would
  mean deleting the two derived panels and the whole Alloy CloudWatch block plus the collector's
  CloudWatch IAM policy. Tier 1.8 keeps that one metric because the panels read it; not decided.
