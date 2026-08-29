# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

The repository has no project code yet (no commits). Everything below is the agreed target design —
treat it as the contract for new code, and update this file as reality diverges from it. The only
committed configuration is `.claude/settings.json`, which enables the superpowers plugin.

## Purpose

A set of self-contained reference environments demonstrating **high-load infrastructure and how it is
observed**: monitoring, alerting, and SLO/SLA definition + tracking. Each project follows the same
loop:

1. Provision a service + database with Terraform.
2. Instrument it and define SLIs/SLOs (and the alerts derived from them).
3. Drive load with k6 until the SLO burns.
4. Change one thing (autoscaling, provisioned capacity, connection pooling, …).
5. Re-run the identical load profile and compare the before/after SLO/error-budget numbers.

Step 5 is the deliverable. A project that provisions cleanly but has no recorded before/after metrics
is not finished. Keep the measured results in the project's own README.

Planned projects:

- **ECS project** — Node.js service on AWS ECS + a database. Measure sustained RPS, add autoscaling
  1→4 tasks, compare SLO attainment under peak vs. constant load.
- **Lambda project** — Lambda + a database. Same measure/break/improve/re-measure loop.

## Layout

```
<project>/            one directory per scenario, fully independent
  terraform/          all infra for the scenario; no manual console changes
  src/                Node.js service code (ECS: container app; Lambda: handlers)
  k6/                 load profiles for this scenario
  grafana/            dashboards, SLO definitions, alert rules as code
  README.md           what it provisions, how to run it, measured results
```

Global (repo root) holds only shared credentials/config for AWS, Terraform Cloud, and Grafana Cloud.
**Everything else is per-project.** Projects must not import each other's Terraform modules or state;
duplication between projects is acceptable and preferred over coupling, because each must be
creatable and destroyable in isolation.

## Hard constraints

- **Terraform is the only way infrastructure exists.** No click-ops, no `aws` CLI mutations. If
  something was created by hand, it is a bug — import it or delete it.
- **Every environment must be cheap to destroy and recreate.** `terraform destroy` must leave nothing
  billable behind. Watch for the usual survivors: RDS/DocumentDB final snapshots, CloudWatch log
  groups, NAT gateways, EIPs, ECR images. Prefer `skip_final_snapshot`, explicit log-group resources
  with retention, and `force_destroy` where the data is disposable — this is a test lab, not prod.
- **State lives in Terraform Cloud**, one workspace per project. Never commit `.tfstate` or
  `.terraform/`.
- **Secrets are global and never in a project folder.** AWS, Terraform Cloud, and Grafana Cloud
  credentials come from the environment / a gitignored root-level env file. Per-project `.tfvars`
  hold only non-secret sizing knobs (instance class, task count, load profile).
- **SLOs are code**, not dashboard clicks — Grafana dashboards, SLO definitions, and alert rules are
  checked in under the project's `grafana/` and applied via Terraform (Grafana provider).

## Spec-driven development (superpowers)

This repo uses the **superpowers** plugin (enabled project-scoped in `.claude/settings.json`).
Its skills are the process for all non-trivial work here. The pipeline:

`brainstorming` → `writing-plans` → `subagent-driven-development` (or `executing-plans`)
→ `verification-before-completion` → `finishing-a-development-branch`

- **Never start with Terraform.** Each new project or subsystem is the *architectural* path in
  `brainstorming`: questions, approaches, a sectioned design, then a written spec — and an explicit
  approval gate before any code or infra is written.
- **One spec and one plan per project directory.** A spec covering both the ECS and Lambda projects
  must be split; each has to produce working, measurable infrastructure on its own.
- Specs live in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/YYYY-MM-DD-<name>.md`.
- `verification-before-completion` applies literally to SLO claims: **an SLO or RPS number may not be
  reported without the k6 output or Grafana query that produced it, from a run in that same session.**
  No remembered numbers, no extrapolation.

### Adapting the skills to infrastructure

Two skills need translation, because superpowers assumes an application codebase:

- **`test-driven-development`** names configuration files as an exception to the red-green loop, and
  Terraform HCL is configuration — do not invent unit tests for it. The honest analogue here is the
  measurement loop: **write the k6 threshold that encodes the SLO, watch it fail against current
  infrastructure, then change the infrastructure until it passes.** Same discipline (see the failure
  first, or you don't know the assertion is real), applied to the thing that can actually fail.
  Terraform's own feedback loop — `fmt -check`, `validate`, then a reviewed `plan` — is the per-task
  verification step, and it belongs in every plan task that touches HCL.
- **`subagent-driven-development`** says to execute all tasks without pausing, stopping only for
  irreversible or destructive operations. In this repo `terraform apply` and `terraform destroy` are
  exactly that — they create and delete billable AWS resources. **Every plan must put apply/destroy in
  its own task, and that task stops for approval.** A subagent may write and `plan` Terraform freely;
  it may not `apply` it unprompted.

Load `superpowers:using-superpowers` if the skill set isn't loaded and you're unsure which applies.

## Commit messages

Every commit in this repo follows **Conventional Commits 1.0.0**:

```
<type>(<scope>): <subject>

<body — why, not what>

<footers>
```

Subject: imperative mood, lowercase, no trailing period, ≤72 characters.

| type | use for |
|---|---|
| `feat` | a new capability — a service, a resource, a dashboard, a load profile |
| `fix` | corrects broken behavior or a misconfigured resource |
| `perf` | a change whose *point* is an SLO / latency / throughput improvement |
| `refactor` | restructuring with no behavior or infrastructure change |
| `test` | k6 profiles, assertions, thresholds |
| `docs` | README, CLAUDE.md, specs, plans, recorded measurements |
| `build` | dependencies, Dockerfile, package.json |
| `chore` | tooling and housekeeping nothing observes |
| `revert` | reverts a previous commit |

**Scope** is the project directory (`ecs`, `lambda`) or the layer inside it (`terraform`, `k6`,
`grafana`, `src`); combine them when both matter (`ecs-terraform`, `lambda-k6`). Use `repo` or `docs`
for cross-cutting work. A commit that needs two unrelated scopes should usually be two commits.

**`perf` vs `feat` matters here.** The repo's whole point is the measure → improve → re-measure loop,
so the commit that raises task count or adds a connection pool is `perf`, and its body should carry
the numbers — before/after p95, error rate, SLO attainment. That makes `git log --grep '^perf'` the
history of what actually moved the needle.

**Breaking changes** mean something specific in an infrastructure repo: a change requiring
**destroy/recreate rather than an in-place update**, or one that alters an interface another project's
configuration depends on. Mark both ways — `!` after the scope and a `BREAKING CHANGE:` footer stating
the migration:

```
fix(lambda-terraform)!: replace rds instance to enable iam auth

BREAKING CHANGE: forces replacement of the db instance. Destroy the
environment before applying; existing data is not migrated.
```

Claude-authored commits keep their attribution trailers (`Co-Authored-By:`, `Claude-Session:`) in the
footer block, below any `BREAKING CHANGE:` footer.

### Setup, and what enforces it

`.gitmessage` is committed and wired up with `git config commit.template .gitmessage`. **Git config is
not cloned**, so a fresh clone must run that command once to get the template — the file alone does
nothing.

By deliberate choice there is **no commit-msg hook and no CI lint**, so nothing mechanically rejects a
malformed message. The format holds only because the author follows this section. Before committing,
re-read the subject line against the type table above; a wrong type is the common failure, not wrong
syntax.

## Working commands

Per project, from that project's directory:

```bash
terraform -chdir=terraform init
terraform -chdir=terraform plan  -var-file=<env>.tfvars
terraform -chdir=terraform apply -var-file=<env>.tfvars
terraform -chdir=terraform destroy -var-file=<env>.tfvars   # always, when done measuring

k6 run k6/<profile>.js                       # local run
k6 cloud run k6/<profile>.js                 # Grafana Cloud k6 run
k6 run -e BASE_URL=<url> -e VUS=200 k6/<profile>.js
```

Node service (ECS project): `npm ci`, `npm test`, `npm start`. A single test is
`npm test -- <pattern>` — pin the exact runner in the project README once chosen.

Verified locally: Node 22.13, npm 10.9, Terraform 1.14, AWS CLI 2.23, k6 1.4, Docker 27.4.

## Load-testing conventions

- A load profile is only comparable to itself. When measuring an improvement, change the
  infrastructure, **not** the k6 script — same VUs, same stages, same thresholds.
- Encode the SLO in the k6 script's `thresholds` as well as in Grafana, so a run fails loudly and
  locally, not only on a dashboard.
- Always run at least two shapes per project: a **constant** load at the discovered capacity, and a
  **peak/spike** that deliberately breaches the SLO. Autoscaling only proves itself against the spike.
- Record for each run: RPS achieved, p95/p99 latency, error rate, SLO attainment, error budget
  burned, and what infra change distinguished it from the previous run.

## Database notes

Projects may target AWS DocumentDB, RDS PostgreSQL, or DynamoDB. The database is usually the thing
that breaks first, so treat its metrics as first-class SLIs (connection count and CPU for
DocumentDB/RDS; throttled requests and consumed capacity for DynamoDB) — not just service-side
latency. DocumentDB and RDS require a VPC and are the expensive resources here; destroy them
promptly.

## Tooling note

`rtk` (Rust Token Killer) is installed and a hook transparently rewrites common shell commands
through it. Use commands normally.
