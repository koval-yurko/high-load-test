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
| `ecs-dynamodb-rps/` | Node.js on ECS + DynamoDB, sustained RPS ceiling | built, first apply pending |
| `ecs-rds-postgres-pool/` | Node.js on ECS Fargate + RDS PostgreSQL, the connection pool as the binding constraint (bigger pool / more tasks / RDS Proxy) | built, baseline pending |
| `ecs-document-db/` | Node.js on ECS + DocumentDB, autoscaling 1→4 tasks | planned, no directory yet |
| `lambda-concurrency-limit/` | Lambda + DB, concurrency limits under load | planned, no directory yet |

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
| graphify | 0.9.64 | the code map; needs the `[terraform]` extra — see below |

`./scripts/01-install-tools.sh` checks the first seven and installs what is missing. graphify is
separate — see the next section.

Accounts needed: **AWS**, **Terraform Cloud**, **Grafana Cloud** (includes Grafana Cloud k6).

---

## The code map (graphify)

The repo is indexed as a queryable graph, so questions about structure are answered from the graph
rather than by grepping.

### Install

```bash
uv tool install "graphifyy[terraform]"
```

**The `[terraform]` extra is not optional here.** Without it graphify has no HCL extractor, and 30
`.tf`, 2 `.hcl` and 1 `.tfvars` file contribute nothing to the graph — 33 of 81 code files, in a
repo whose entire subject is Terraform. It fails as a warning, not an error, so an incomplete map
looks exactly like a complete one. With the extra, a capacity question returns the
`aws_dynamodb_table.items` resource and its `read_capacity`; without it, nothing.

### Ask it things

```bash
graphify query "dynamodb provisioned capacity"   # scoped subgraph for a question
graphify explain "slo.yaml"                      # one node and its neighbours
graphify affected "slo.yaml"                     # what a change here would touch
graphify god-nodes                               # the most connected nodes
```

Matching is case-folded substring with no stemming and no synonyms, so build queries from the names
the code actually uses — `graphify god-nodes` is a good way to see them.

### Keep it current

```bash
graphify update .                                              # code only: free, offline, seconds
graphify extract . --backend claude-cli --max-workers 2        # also docs, specs, slo.yaml
```

`post-commit` and `post-checkout` git hooks run the first one for you, detached, so commits do not
block. **They do not fire in linked worktrees** — they exit when `git rev-parse --git-dir` differs
from `--git-common-dir` — so run it by hand when working in one.

Pass `--max-workers 2` to the second: an unconstrained full pass exhausted memory on a workstation.
A cold pass takes about 11 minutes here because the `claude-cli` backend is deliberately serial.

### The committed cache

`graphify-out/` is gitignored **except** `graphify-out/cache/semantic/`, which is committed. Those
entries are the output of LLM extraction over markdown and YAML — `slo.yaml` has no structural
extractor at all, so it reaches the graph only this way. Keying them by source content hash means
the work is paid for once and reused by every clone, worktree and CI run: rebuilding the full graph
from a warm cache took **0.95s against 10m43s cold, with zero LLM calls**.

CI regenerates it on every push to master, so `git pull` is normally all you need. To do it
yourself:

```bash
graphify extract . --backend claude-cli --max-workers 2
git add graphify-out/cache/semantic/
git commit -m "chore(repo): refresh graphify semantic cache"
```

Both routes converge — refresh by hand and the CI job finds every hash already present, calls no
LLM and commits nothing. Entries are named by content hash, so they cannot conflict; if two ever
collide, either side is correct.

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
terraform -chdir=platform apply                    # shared stack: TFC project, workspaces, Grafana folder
terraform -chdir=<project>/infra/main apply -var-file=dev.tfvars   # also creates the project's k6 project
cd <project> && ./scripts/deploy-service.sh        # build → push → roll the ECS service → seed → health
./scripts/upload-k6.sh                             # the k6 project is new on every apply: upload the profiles
```

Both applies stay manual and separate from the scripts: the `permissions.ask` rules match on
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
| `K6_CLOUD_TOKEN` | there is **no** `K6_CLOUD_PROJECT_ID` and **no** `BASE_URL` key beside it. Both are per-project values Terraform owns — the k6 project is created and destroyed with the environment, so its id changes on every rebuild — and a copy here could only ever be the stale one. Everything reads `terraform -chdir=<project>/infra/main output -json` instead (never `-raw`, which prints a warning to stdout against empty state). If an old `.env` still has `K6_CLOUD_PROJECT_ID`, delete the line |
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
  sweep afterwards for NAT gateways, unattached EIPs, manual snapshots, log groups, ECR repos, and a
  surviving Grafana Cloud k6 project (not billable, but an orphan the tag query cannot see).
- `terraform apply`/`destroy` are listed under `permissions.ask` in `.claude/settings.json`, so
  Claude Code prompts before either runs. **This is the only gate that is actually wired**, and it
  is a permission prompt — nothing more. Do not move these entries to the allowlist.
- `.claude/hooks/guard-terraform.sh` is a stronger guard that is **present but not active**. It
  matches apply/destroy in any spelling and blocks `-auto-approve` outright, but no settings file
  registers it, and Claude Code does not auto-discover scripts in `.claude/hooks/`. Wiring it means
  adding a `PreToolUse` entry that points at it.

> **The gate depends on your permission mode.** A gitignored `.claude/settings.local.json` setting
> `permissions.defaultMode` to `bypassPermissions` disables the `ask` prompts, leaving no terraform
> protection at all — and because that file is per-machine, nothing in the repo will tell you. Check
> your mode, and `/hooks`, before a session that will touch infrastructure. An unattended session
> has no mechanical guard against AWS spend.

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
workspace per repo project, the shared variable set and the Grafana folder `high-load-test` —
everything a project workspace needs to already exist. (Each project's Grafana Cloud k6 project is
not here: it lives in that project's `infra/k6` and is destroyed with it.) It is long-lived,
runs locally, and is applied by hand
(`terraform -chdir=platform apply`), never by `/env up`. See
`platform/README.md`.

Projects are independent by design — they must not share Terraform modules or state, so each can be
created and destroyed in isolation. Duplication between projects is preferred over coupling. What
`platform/` creates they find by a fixed string (the folder title), not by reading its state.
