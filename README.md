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

### Step 1 — global secrets

```bash
cp .env.example .env
$EDITOR .env
```

Then pick how it gets loaded:

**Recommended — [direnv](https://direnv.net), loads automatically on `cd`:**

```bash
brew install direnv
echo 'eval "$(direnv hook zsh)"' >> ~/.zshrc && exec zsh
direnv allow            # once here, and again after each .env edit
```

`.envrc` is committed: it loads `.env`, unsets `AWS_PROFILE` so it can never conflict with the keys,
and exports the aliases the providers need under their own names (`TFE_TOKEN`, the `TF_VAR_*`
values).

**direnv is optional — without it, source both in each new shell:**

```bash
set -a; source .env; set +a
source <(grep '^export ' .envrc)
```

The second line is what `platform/` needs: `.env` alone leaves `TFE_TOKEN` and the `TF_VAR_*`
aliases unset.

What each block needs, and where to get it:

**AWS** — permanent IAM user keys, set once in `.env`:

```
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=eu-central-1
AWS_ACCOUNT_ID=123456789012
```

No named profile is needed. Environment variables sit **first** in the AWS credential provider chain —
ahead of `~/.aws/credentials` — so the CLI, the SDKs and the Terraform AWS provider all pick these up
automatically, and any existing profile is ignored. Leave `AWS_PROFILE` unset; setting it alongside
these keys makes the winner tool-dependent.

`AWS_ACCOUNT_ID` is a guard rail, not a credential. This machine has a `[default]` profile, so a shell
where `.env` was never loaded **does not fail** — it silently authenticates as a different account.
`/env` asserts the caller identity matches this value and refuses to provision otherwise.

**Terraform Cloud** — a user API token from
<https://app.terraform.io/app/settings/tokens>. The variable name is not free-form: Terraform reads
`TF_TOKEN_<hostname with dots as underscores>`, so for `app.terraform.io` it must be spelled exactly
**`TF_TOKEN_app_terraform_io`**. Also set `TF_CLOUD_ORGANIZATION`.

Set `TF_WORKSPACE` to the project workspace you are working on, and `TF_CLOUD_PROJECT` to
`high-load-test`. The `tfe` provider used by `platform/` reads `TFE_TOKEN` rather than the
`TF_TOKEN_…` name, so `.envrc` exports it as an alias of the same token — never a second copy.

> **Where AWS creds must live depends on the workspace execution mode, and this repo uses both.**
> Each **project** workspace runs **remote** — on Terraform Cloud's runners, which never see your
> shell — so its credentials are workspace variables. You do not type them into the TFC UI: the
> `platform/` stack manages one variable set, scoped to the `high-load-test` TFC project, fed from
> this `.env` through `TF_VAR_*`, so `.env` stays the only copy on disk and HCP holds the only other
> one. The **`platform`** workspace itself runs **local** — it is the stack that creates those
> credentials, so it has to run with your own shell loaded, which is also what keeps `/env`'s account
> assertion meaningful there.

**Grafana Cloud** — `GRAFANA_URL` is your stack URL (`https://<stack>.grafana.net`); `GRAFANA_AUTH` is
a service-account token with Editor or Admin on that stack. These are what the Terraform `grafana`
provider uses to manage dashboards, alert rules, and SLOs as code.

**Grafana Cloud k6** — `K6_CLOUD_TOKEN` and `K6_CLOUD_PROJECT_ID` for `k6 cloud run`.

`K6_CLOUD_PROJECT_ID` is the numeric id of the k6 project the run uploads into. The k6 projects are
owned by the `platform/` stack (one per repo project, named after it), so the id is **stable** — it
survives `/env down`, and so does the run history under it. Set it **once**, from the platform
output:

```bash
env -u TF_WORKSPACE terraform -chdir=platform output -json k6_project_ids
```

A project's own root re-exposes the same id (`terraform -chdir=<project>/infra/main output -raw
k6_project_id`), read back by name rather than created, if you would rather ask the project.

**Streaming local runs to Grafana** — `K6_PROMETHEUS_RW_SERVER_URL` (ends in `/api/prom/push`),
`K6_PROMETHEUS_RW_USERNAME` (the numeric Prometheus instance ID), and `K6_PROMETHEUS_RW_PASSWORD`
(a Grafana Cloud access-policy token). Used as:

```bash
k6 run -o experimental-prometheus-rw ecs-document-db/infra/k6/tests/constant.js
```

> The output name still carries the `experimental-` prefix in k6 1.4.0. Available outputs on this
> version: `cloud, csv, experimental-opentelemetry, experimental-prometheus-rw, influxdb, json,
> opentelemetry, statsd, web-dashboard`.

### Step 2 — verify before provisioning anything

```bash
aws sts get-caller-identity          # correct account? this is the expensive mistake
terraform -chdir=<project>/infra/main init
k6 version
```

### Step 3 — repo-local git setup

Git config is **not** cloned, so after a fresh clone run this once to get the Conventional Commits
template:

```bash
git config commit.template .gitmessage
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
  slo.yaml       SLO source of truth
  results.md     recorded before/after measurements
  README.md      what it provisions and what was measured

platform/                 the shared stack (see below) — not a project
docs/superpowers/specs/   specs   (brainstorming skill)
docs/superpowers/plans/   plans   (writing-plans skill)
.claude/                  skills, hooks, permissions
```

`platform/` is the one Terraform root that is not a project: it owns the Terraform Cloud project, one
workspace per repo project, the shared variable set, the Grafana folder `high-load-test` and the
Grafana Cloud k6 projects — everything a project workspace needs to already exist. It is long-lived,
runs locally, and is applied by hand
(`env -u TF_WORKSPACE terraform -chdir=platform apply`), never by `/env up`. See
`platform/README.md`.

Projects are independent by design — they must not share Terraform modules or state, so each can be
created and destroyed in isolation. Duplication between projects is preferred over coupling. What
`platform/` creates they find by a fixed string (the folder title, the k6 project's name), not by
reading its state.
