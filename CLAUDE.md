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

- **`ecs-document-db`** — Node.js service on AWS ECS + DocumentDB. Measure sustained RPS, add
  autoscaling 1→4 tasks, compare SLO attainment under peak vs. constant load.
- **`lambda-concurrency-limit`** — Lambda + a database, exploring concurrency limits. Same
  measure/break/improve/re-measure loop.

## Layout

### Naming

A project directory is named for **the scenario it covers**, never for the platform alone:
`<platform>-<scenario>`, kebab-case.

There will be several scenarios on the same platform, so `ecs/` and `lambda/` are not names — they are
categories, and the second one to arrive would have nowhere to go. Lead with the platform so related
scenarios sort together, then name the thing under test — the datastore, the constraint, the knob:

```
ecs-document-db            ecs-rds-postgres           ecs-autoscaling-cold-start
lambda-concurrency-limit   lambda-dynamodb            lambda-provisioned-concurrency
```

This name is also the `Project` tag value on every AWS resource and the commit scope, so it must be
stable — renaming later orphans tagged resources from the sweep that is supposed to find them (done
once, on 2026-09-03, `ecs-dynamodb-rps-ceiling` → `ecs-dynamodb-rps`, while nothing was deployed and
the tag therefore pointed at nothing — see
`docs/superpowers/specs/2026-09-02-ecs-dynamodb-rps-restructure-design.md`).

```
<project>/            one directory per scenario, fully independent
  infra/
    main/             ROOT MODULE: the AWS infrastructure; calls ../grafana and ../k6 as modules
    grafana/          dashboards, SLO definitions, alert rules as code
    k6/               tests/ holds the load profiles; a data source reads the k6 project id
  service/            the Node.js service: src/ test/ scripts/, package.json, Dockerfile
  heartbeat/          small side pieces managed separately from the service (ECS: the idle-load Lambda)
  slo.yaml            SLO source of truth; generates the k6 thresholds and the Grafana rules
  results.md          the run ledger (/loadtest appends here)
  README.md           what it provisions, how to run it, measured results
```

This layout was chosen in
`docs/superpowers/specs/2026-09-02-ecs-dynamodb-rps-restructure-design.md` (section 4); the working
directory `infra/main` is what makes `../grafana`, `../k6` and `../../heartbeat` resolve inside a
remote HCP run, so it is set on the workspace by `platform/`, not in HCL.

Global (repo root) holds only shared credentials/config for AWS, Terraform Cloud, and Grafana Cloud —
and `platform/`, the one Terraform root that is not a project: it owns the TFC project, the project
workspaces, the shared variable set, the Grafana folder `high-load-test` and the k6 projects (the
restructure spec, section 6). **Everything else is per-project.** Projects must not import each
other's Terraform modules or state; duplication between projects is acceptable and preferred over
coupling, because each must be creatable and destroyable in isolation. What `platform/` creates is
found by a **fixed string** — the folder title `high-load-test`, the k6 project's own name — never by
reading its state, so that rule still holds.

## Hard constraints

- **Terraform is the only way infrastructure exists.** No click-ops, no `aws` CLI mutations. If
  something was created by hand, it is a bug — import it or delete it.
- **Every environment must be cheap to destroy and recreate.** `terraform destroy` must leave nothing
  billable behind. Watch for the usual survivors: RDS/DocumentDB final snapshots, CloudWatch log
  groups, NAT gateways, EIPs, ECR images. Prefer `skip_final_snapshot`, explicit log-group resources
  with retention, and `force_destroy` where the data is disposable — this is a test lab, not prod.
- **Every resource carries a `Project = <project-dir>` tag.** The teardown sweep finds orphans with a
  single `resourcegroupstaggingapi` query; an untagged resource is invisible to it and bills forever.
  Set it via `default_tags` on the AWS provider so it cannot be forgotten per-resource.
- **State lives in Terraform Cloud**, one workspace per project, plus the `platform` workspace that
  owns the project and workspaces themselves (the restructure spec, section 6). Never commit
  `.tfstate` or `.terraform/`.
- **Secrets are global and never in a project folder.** AWS, Terraform Cloud, and Grafana Cloud
  credentials come from the environment / a gitignored root-level env file. Per-project `.tfvars`
  hold only non-secret sizing knobs (instance class, task count, load profile).
- **SLOs are code**, not dashboard clicks — Grafana dashboards, SLO definitions, and alert rules are
  checked in under the project's `infra/grafana/` and applied via Terraform (Grafana provider).

## Spec-driven development (superpowers)

This repo uses the **superpowers** plugin (enabled project-scoped in `.claude/settings.json`).
Its skills are the process for all non-trivial work here.

**`SP` is reserved shorthand for "superpowers."** Anywhere in a prompt — any casing, `SP` or
`sp` — it expands to the plugin name and nothing else. "SP research something" means "superpowers
research something"; "SP this spec" means run it through the superpowers pipeline. Expand it
silently and act; never ask what it stands for, and never read it as a variable, a project prefix,
or an AWS abbreviation. There is no `/sp` command — this is a naming convention for prose, not a
skill invocation, so `SP brainstorm` still means invoking `superpowers:brainstorming` by its real
name.

The pipeline:

`brainstorming` → `writing-plans` → `subagent-driven-development` (or `executing-plans`)
→ `verification-before-completion` → `finishing-a-development-branch`

- **Never start with Terraform.** Each new project or subsystem is the *architectural* path in
  `brainstorming`: questions, approaches, a sectioned design, then a written spec — and an explicit
  approval gate before any code or infra is written.
- **A spec covers exactly one project directory — but a project may accrue several specs and
  plans over time.** A spec covering both the ECS and Lambda projects must be split; each has to
  produce working, measurable infrastructure on its own. What must never happen is one document
  spanning two projects. A second spec for the *same* project is normal and expected: a new
  subsystem, or a design decision that turns out to be wrong once real numbers arrive.
- **When a later document changes an earlier decision, both must say so.** The new spec names what
  it amends and why the original reasoning failed; the older spec gets a forward-pointer **at the
  decision itself**, not only in a header. This is the single rule that makes multiple specs safe —
  without it a reader lands on the older document, finds a decision stated with full confidence,
  and acts on guidance that was reversed months ago. Superseding in silence is worse than never
  having written the second spec.
- **Every spec and plan carries a `Status:` line** near the top, one of: `draft`, `approved`,
  `in progress`, `partially executed (on hold)`, `complete`, `superseded by <doc>`. A plan sitting
  at `in progress` that nobody is working is a lie the next reader will act on. A partially
  executed plan must also say **which tasks are done** and **what is blocking the rest** — "on
  hold" without a reason is an invitation to redo finished work.
- Specs live in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/YYYY-MM-DD-<name>.md`.
  The date prefix is what lets several coexist and orders them; never overwrite an executed plan
  in place, because the ledger and the commit history reference its task numbers.
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

## Referring to other documents

**Never cite a document by number alone.** `§5`, `D7`, `S16`, `Task 18 Step 7` and
`the 2026-08-31 spec` are addresses, not content — they oblige the reader to go and look, and in a
project with four specs and five plans that is a real cost paid every time.

State the substance, then give the address so it can be checked:

> ~~"Run the completeness check from the `loadtest` skill before writing up results."~~
>
> "Before writing up results, flag any row with a blank `infra change` (`$4`), `k6 attainment`
> (`$6`), `service attainment` (`$7`) or `throttles` (`$13`) — and re-derive those field indices by
> piping the header through `awk -F'|'`, never by counting pipes, because a leading-pipe Markdown
> row makes `$1` the empty string before the first column. The snippet is in
> `.claude/skills/loadtest/SKILL.md` if you need it."

This applies hardest to **questions**. A question a reader cannot answer without opening another file
is not a question, it is a research assignment. Inline every number, metric name and trade-off the
answer depends on.

The exception is a pure pointer whose whole purpose is navigation — an `Amends:` header, a
forward-pointer at a superseded decision, a "full reasoning lives here" footer. Those are addresses
on purpose.

## `PIIB` — present it in browser

`PIIB` (any casing, anywhere in a prompt) means: leave the terminal and present the deliverable as
a claude.ai Artifact page. `STC` means "Send to Claude". Both are defined, with the whole flow, by
the global skills — `~/.claude/skills/piib` to present, `piib-check` to collect what the page
recorded, `piib-save` to write it down. They are project-independent on purpose: a fix made in one
repo reaches every other.

Enter the flow **without being asked** when a report would run past about one screen, when it
carries a diagram or a table wider than the terminal, or when a decision's options need a paragraph
each to be understood. `AskUserQuestion` stays for a single question with short, self-explanatory
options. Rationale: a decision answered from a terminal prompt is answered from memory of the
options; one answered on the page is answered next to the explanations, and the answer is recorded
where the next session can read it.

What is specific to this repo: nothing yet. Anything that becomes so belongs here, not in the
skill.

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

**Scope** is the project directory name (`ecs-document-db`, `lambda-concurrency-limit`). When the layer
matters, append it with a slash: `ecs-document-db/terraform`, `lambda-concurrency-limit/k6`. Use `repo`
or `docs` for cross-cutting work. A commit that needs two unrelated scopes should usually be two
commits.

**`perf` vs `feat` matters here.** The repo's whole point is the measure → improve → re-measure loop,
so the commit that raises task count or adds a connection pool is `perf`, and its body should carry
the numbers — before/after p95, error rate, SLO attainment. That makes `git log --grep '^perf'` the
history of what actually moved the needle.

**Breaking changes** mean something specific in an infrastructure repo: a change requiring
**destroy/recreate rather than an in-place update**, or one that alters an interface another project's
configuration depends on. Mark both ways — `!` after the scope and a `BREAKING CHANGE:` footer stating
the migration:

```
fix(lambda-concurrency-limit/terraform)!: replace rds instance to enable iam auth

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

## Project skills

Three skills in `.claude/skills/` automate the loop. Prefer them over ad-hoc commands — each encodes
gotchas that cost real money or produce wrong numbers:

- **`/env up|down|status <project>`** — Terraform lifecycle for `<project>/infra/main`, with an
  approval gate before apply/destroy and a billable-resource sweep after teardown. `terraform
  destroy` succeeding is not evidence the account is clean. The `platform/` stack is **not** part of
  `/env up|down` — it is long-lived and brought up by hand with
  `env -u TF_WORKSPACE terraform -chdir=platform apply`.
- **`/loadtest <project> <profile> [--compare]`** — runs k6, parses the summary, appends a result row
  with the infra change that distinguishes the run. Encodes two verified k6 quirks (below).
- **`/slo <project> [--check]`** — one `slo.yaml` generates both the k6 thresholds and the Grafana
  alert rules, so they cannot drift apart.

### k6 facts worth not re-learning

Verified against the installed k6 v1.4.0:

- In `--summary-export` JSON, a threshold's boolean is **"was it breached"**, not "did it pass":
  `true` = **crossed = FAILED**, `false` = satisfied. Reading it the intuitive way inverts every verdict.
- `http_req_failed.passes` counts requests that *were* failures. Use `.value` (0..1) for error rate.
- k6 exits **99** when a threshold is breached, **0** when all pass. Capture the code off the k6
  command itself — behind a pipe you get the pipe's status instead.

`terraform apply` and `terraform destroy` are deliberately **absent** from the permission allowlist in
`.claude/settings.json`, so they still prompt. That prompt is the one mechanical guard against
unattended AWS spend — do not add them to the allowlist.

## Working commands

Per project, from that project's directory:

```bash
terraform -chdir=infra/main init
terraform -chdir=infra/main plan  -var-file=<env>.tfvars
terraform -chdir=infra/main apply -var-file=<env>.tfvars
terraform -chdir=infra/main destroy -var-file=<env>.tfvars   # always, when done measuring

k6 run infra/k6/tests/<profile>.js                       # local run
k6 cloud run infra/k6/tests/<profile>.js                 # Grafana Cloud k6 run
k6 run -e BASE_URL=<url> -e VUS=200 infra/k6/tests/<profile>.js
```

The shared stack is separate and runs from the repo root, not from a project directory:

```bash
env -u TF_WORKSPACE terraform -chdir=platform plan     # also init / apply
```

`TF_WORKSPACE` is unset for it because the root `.env` exports the *project* workspace name while
`platform/`'s `cloud` block names its own, and Terraform refuses to run when the two disagree
(`platform/README.md`).

Node service (ECS project), from `<project>/service/`: `npm ci`, `npm test`, `npm start`. A single
test is `npm test -- <pattern>` — pin the exact runner in the project README once chosen.

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
