# high-load-test

Reference environments demonstrating **high-load infrastructure and how it is observed** — monitoring,
alerting, and SLO/SLA definition and tracking on AWS.

Each project follows the same loop, and the last step is the deliverable:

1. Provision a service + database with Terraform
2. Define SLIs/SLOs and the alerts derived from them
3. Drive load with k6 until the SLO burns
4. Change one thing (autoscaling, capacity, pooling)
5. Re-run the *identical* load profile and compare before/after

A project that provisions cleanly but has no recorded before/after numbers is not finished.

## Projects

| directory | what it demonstrates | status |
|---|---|---|
| `ecs-dynamodb-rps/` | Node.js on ECS + DynamoDB, sustained RPS ceiling | restructured 2026-09-03, first apply pending |
| `ecs-document-db/` | Node.js on ECS + DocumentDB, autoscaling 1→4 tasks | not built yet |
| `lambda-concurrency-limit/` | Lambda + DB, concurrency limits under load | not built yet |

Project directories are named for **the scenario**, not the platform — `<platform>-<scenario>` in
kebab-case. There will be several scenarios per platform, so a bare `ecs/` or `lambda/` leaves the
next one nowhere to go. The name is also the AWS `Project` tag and the commit scope, so it must be
stable: renaming later orphans tagged resources from the teardown sweep meant to find them.

---

## Prerequisites

| tool | verified version | notes |
|---|---|---|
| Node.js | 22.13 | service code and tooling |
| Terraform | 1.14 | all infrastructure |
| AWS CLI | 2.23 | credentials and the teardown sweep |
| k6 | 1.4 | load generation |
| Docker | 27.4 | container builds for ECS |
| jq | 1.7 | used by tooling and the safety hook |
| direnv | 2.37 | **required** — nothing here runs without a loaded `.env` |

`./scripts/01-install-tools.sh` checks all seven and installs what is missing.

Accounts needed: **AWS**, **Terraform Cloud**, **Grafana Cloud** (includes Grafana Cloud k6).

---

## Configuration: what goes where

Two levels, by design. Secrets are global; everything else is per-project.

```
.env                     ← GLOBAL SECRETS. gitignored. never committed.
.env.example             ← committed template. copy this to .env.
<project>/.env           ← per-project NON-SECRET runtime values (base URL, sizes)
<project>/infra/main/<env>.tfvars
                         ← per-project Terraform inputs. committed. no secrets.
<project>/slo.yaml       ← the project's SLO definition (see /slo skill)
```

**Nothing secret ever goes in a `<project>/` file.** `.gitignore` covers `.env` and `*.auto.tfvars`,
but the rule is the habit, not the file.

## Setup

Four scripts, in order, from the repo root:

```bash
./scripts/01-install-tools.sh    # the 7 binaries above; installs what is missing
./scripts/02-create-env.sh       # creates .env, then lists the keys you must fill in
./scripts/03-wire-repo.sh        # direnv shell hook + direnv allow
./scripts/04-verify-setup.sh     # read-only preflight: right AWS account, TFC reachable
```

Each one ends by printing what it produced and which later script consumes it; if it cannot
finish, it prints the exact command that unblocks it and exits non-zero. All four are idempotent —
re-run any of them at any time.

Only **02** needs you: it creates `.env` from the committed template, then stops with a `✘` beside
every key still empty. Fill them in (`$EDITOR .env` — `.env.example` documents each one inline) and
run it again.

**04 is also the "why is this broken" script.** It creates nothing and bills nothing; run it
whenever something stops working. Pass a project to have it `terraform init` that project too:

```bash
./scripts/04-verify-setup.sh ecs-dynamodb-rps
```

Then bring up the shared stack, once, and deploy a project into it:

```bash
terraform -chdir=platform apply                    # shared stack: TFC project, workspaces, Grafana folder, k6 projects
terraform -chdir=<project>/infra/main apply -var-file=dev.tfvars
cd <project> && ./scripts/deploy-service.sh        # build → push → roll the ECS service → seed → health
```

Both applies stay manual and separate from the scripts: the `guard-terraform.sh` hook matches on
command text, so an apply hidden inside a script would never reach the approval gate that CLAUDE.md
requires before anything billable is created. Deployment is per-project — each project owns a
`scripts/deploy-service.sh`, because what "deploy" means differs by platform — and it starts where
the apply ends, refusing to run when the project has no applied infrastructure.

Re-run `./scripts/deploy-service.sh` after every change under `<project>/service/src/` — Terraform
does not rebuild the image, and skipping it fails silently: the old code keeps serving, looking
healthy.

### What `.env` holds

`.env.example` is the annotated source of truth and `02` tells you which keys are still missing;
these are the ones with a catch.

| key | catch |
|---|---|
| `AWS_ACCOUNT_ID` | a guard rail, not a credential — `/env` and `04` refuse to proceed when the `sts` caller differs |
| `TF_TOKEN_app_terraform_io` | exact spelling: `TF_TOKEN_<hostname, dots as underscores>` |
| `TF_CLOUD_PROJECT` | must be `high-load-test`, or `init` puts the workspace in the org's default project |
| `TF_WORKSPACE` | **must not exist.** Each root module names its own workspace in `cloud { workspaces { name = … } }`; one exported value could only ever be right for one of them, and Terraform aborts when it disagrees |
| `K6_CLOUD_PROJECT_ID` | filled after the first apply, not at setup — `02` expects it empty. There is no `BASE_URL` key: the endpoint is per-project and Terraform owns it, so everything reads `terraform -chdir=<project>/infra/main output` instead of a copy here |
| `K6_PROMETHEUS_RW_SERVER_URL` | ends in `/api/prom/push`; `_USERNAME` is the numeric instance ID, not a policy name |

`AWS_PROFILE` must stay unset — environment variables outrank `~/.aws/credentials`, and setting
both makes which one wins tool-dependent. `.envrc` unsets it for this directory.

> Project workspaces run **remote**, so their credentials live as TFC workspace variables — managed
> by `platform/` from this `.env` via `TF_VAR_*`, never typed into the UI. The `platform` workspace
> runs **local**, because it is the stack that creates them.

### direnv, and the one case it does not cover

`.env` has no `export` keywords, so it reaches nothing on its own. `03` installs the hook that makes
direnv run the committed `.envrc`, which loads `.env`, unsets `AWS_PROFILE`, and adds `TFE_TOKEN`
plus the `TF_VAR_*` aliases `platform/` needs. `cd` in and you should see `direnv: loading …`.

direnv fires in **interactive shells only** — scripts, CI, and tools that shell out get nothing:

```bash
direnv exec . terraform -chdir=platform plan
```

```bash
k6 run -o experimental-prometheus-rw <project>/infra/k6/tests/constant.js   # still `experimental-` in k6 1.4
```

---

## Daily workflow

Three Claude Code skills automate the loop (see `CLAUDE.md` for the full rules):

```
/env up <project>          provision, with an approval gate before apply
/loadtest <project> <profile> [--compare]
/slo <project> [--check]   regenerate k6 thresholds + Grafana alerts from slo.yaml
/env down <project>         destroy, then sweep for surviving billable resources
```

**Always `/env down` when you stop measuring.** A forgotten NAT gateway is about $32/month, and an
idle DocumentDB cluster costs considerably more.

---

## Cost safety

- Every resource carries a `Project = <project-dir>` tag (via provider `default_tags`), so the
  teardown sweep can find orphans with one query. Untagged resources are invisible to it.
- `terraform destroy` reporting success is **not** evidence the account is clean. `/env down` runs a
  sweep afterwards for NAT gateways, unattached EIPs, manual snapshots, log groups, and ECR repos.
- A `PreToolUse` hook (`.claude/hooks/guard-terraform.sh`) intercepts `terraform apply`/`destroy` in
  Claude Code sessions: it prompts for confirmation, and **blocks `-auto-approve` outright** since that
  flag removes the human gate. It does not affect terraform run manually in your own terminal.
  It matches on the command text, so a *mention* of the phrase (e.g. `git commit -m "docs: terraform
  apply gate"`) also prompts. That is deliberate: a spurious prompt costs one keystroke, a missed
  apply costs money, so the pattern stays conservative rather than clever about shell quoting.
- `terraform apply`/`destroy` are deliberately absent from the permission allowlist in
  `.claude/settings.json`. Do not add them.

> **After a fresh clone, open `/hooks` once (or restart Claude Code)** so the guard hook is loaded.
> Claude Code only watches settings directories that existed when the session started.

---

## Repository layout

```
<project>/
  infra/
    main/        ROOT MODULE: the AWS infrastructure; calls ../grafana and ../k6 as modules
    grafana/     dashboards, SLO definitions, alert rules (as Terraform)
    k6/          tests/ holds the load profiles + the generated lib/slo.js thresholds
  service/       the Node.js service: src/ test/ scripts/, package.json, Dockerfile
  heartbeat/     side pieces managed separately from the service (here: the idle-load Lambda)
  scripts/       every script this project owns: deploy-service.sh, upload-k6.sh
  slo.yaml       SLO source of truth
  results.md     recorded before/after measurements
  README.md      what it provisions and what was measured

platform/                 the shared stack (see below) — not a project
scripts/                  repo-wide only: setup (01-04) and the shared logging in lib.sh
docs/superpowers/specs/   specs   (brainstorming skill)
docs/superpowers/plans/   plans   (writing-plans skill)
.claude/                  skills, hooks, permissions
```

`platform/` is the one Terraform root that is not a project: it owns the Terraform Cloud project, one
workspace per repo project, the shared variable set, the Grafana folder `high-load-test` and the
Grafana Cloud k6 projects — everything a project workspace needs to already exist. It is long-lived,
runs locally, and is applied by hand
(`terraform -chdir=platform apply`), never by `/env up`. See
`platform/README.md`.

Projects are independent by design — they must not share Terraform modules or state, so each can be
created and destroyed in isolation. Duplication between projects is preferred over coupling. What
`platform/` creates they find by a fixed string (the folder title, the k6 project's name), not by
reading its state.
