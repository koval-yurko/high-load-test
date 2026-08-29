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
<project>/<env>.tfvars   ← per-project Terraform inputs. committed. no secrets.
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

`.envrc` is committed: it loads `.env` and unsets `AWS_PROFILE` so it can never conflict with the keys.

**No install — source it in each new shell:**

```bash
set -a && source .env && set +a
```

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

> **Where AWS creds must live depends on the workspace execution mode.** With **local** execution,
> Terraform runs on your machine and picks up the `.env` values — define them once, as above. With
> **remote** execution, the run happens on Terraform Cloud's runners, which never see your shell, so
> the AWS keys must *also* be set as workspace environment variables in the TFC UI. Pick local
> execution for these projects unless you specifically want remote runs; it keeps `.env` the single
> definition point and keeps `/env`'s account assertion meaningful.

**Grafana Cloud** — `GRAFANA_URL` is your stack URL (`https://<stack>.grafana.net`); `GRAFANA_AUTH` is
a service-account token with Editor or Admin on that stack. These are what the Terraform `grafana`
provider uses to manage dashboards, alert rules, and SLOs as code.

**Grafana Cloud k6** — `K6_CLOUD_TOKEN` and `K6_CLOUD_PROJECT_ID` for `k6 cloud run`.

**Streaming local runs to Grafana** — `K6_PROMETHEUS_RW_SERVER_URL` (ends in `/api/prom/push`),
`K6_PROMETHEUS_RW_USERNAME` (the numeric Prometheus instance ID), and `K6_PROMETHEUS_RW_PASSWORD`
(a Grafana Cloud access-policy token). Used as:

```bash
k6 run -o experimental-prometheus-rw ecs-document-db/k6/constant.js
```

> The output name still carries the `experimental-` prefix in k6 1.4.0. Available outputs on this
> version: `cloud, csv, experimental-opentelemetry, experimental-prometheus-rw, influxdb, json,
> opentelemetry, statsd, web-dashboard`.

### Step 2 — verify before provisioning anything

```bash
aws sts get-caller-identity          # correct account? this is the expensive mistake
terraform -chdir=<project>/terraform init
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
  terraform/     all infrastructure for this scenario
  src/           Node.js service code
  k6/            load profiles + generated thresholds.js
  grafana/       dashboards, SLO definitions, alert rules (as Terraform)
  slo.yaml       SLO source of truth
  results.md     recorded before/after measurements
  README.md      what it provisions and what was measured

docs/superpowers/specs/   specs   (brainstorming skill)
docs/superpowers/plans/   plans   (writing-plans skill)
.claude/                  skills, hooks, permissions
```

Projects are independent by design — they must not share Terraform modules or state, so each can be
created and destroyed in isolation. Duplication between projects is preferred over coupling.
