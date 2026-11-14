---
name: new-project
description: Create a new <platform>-<scenario> project directory in this repo from an approved spec — what every project must contain, the few repo-wide files that must name it, and how to verify it before the first apply. Use when starting a new scenario (e.g. lambda-concurrency-limit, ecs-document-db), or when checking an existing project for a missing piece.
---

# New project

Usage: `/new-project <project>`

**This skill does not decide anything.** What to measure, the knob sequence, the datastore and the
SLO come from a spec in `docs/superpowers/specs/`, written through `superpowers:brainstorming` and
approved — CLAUDE.md: never start with Terraform. No approved spec for `<project>`: stop and say so.
This skill is the checklist that turns that spec into a directory that fits the repo, so nothing
the other skills, hooks and scripts depend on is forgotten.

## 1. The name

`<platform>-<scenario>`, kebab-case: the platform first, then the thing under test
(`lambda-concurrency-limit`, `ecs-document-db`). Never a bare platform (`lambda/`).

**The name is permanent once anything is deployed.** It is the directory, the `Project` tag on every
AWS resource (what the teardown sweep queries), the TFC workspace name and the commit scope.
Renaming after an apply orphans tagged resources from the sweep.

## 2. Fork the nearest sibling — do not share

Projects never import each other's modules or state; duplication is preferred over coupling. Start
from the sibling closest to the new platform (today both are ECS: `ecs-rds-postgres-pool` is the newer
and better-commented one). Every file copied gets the header both siblings already use:

```
# Forked from <sibling>/<path> on <YYYY-MM-DD>.
# A bug fixed here does not reach the sibling copy; fix both.
```

Then delete what the spec does not need — a Lambda project has no ECS service, ALB or event loop.
Do not leave sibling-shaped leftovers "for later"; an unused resource still bills and still has to
survive `terraform destroy`.

## 3. What the directory must contain

```
<project>/
  .terraformignore      upload root for remote runs: excludes service/, infra/k6/tests/, *.md
  slo.yaml              SLO source of truth (window 7d..14d — see its comments in either sibling)
  loadtest.md           the project side of /loadtest — see the loadtest skill, "The project contract"
  results.md            run ledger, header copied from loadtest.md, no rows until a run exists
  verify/               the project side of /verify: target.sh + feature map — see the verify skill
  README.md             written with /readme
  infra/main/           ROOT MODULE
  infra/grafana/        module: dashboards, SLO, alert rules (part generated from slo.yaml)
  infra/k6/             module: the project's Grafana Cloud k6 project + limits; tests/ = profiles
  service/              the code under test, with its own package.json, tests and slo generator
  heartbeat/            only if the project needs idle load (both siblings: a scheduled Lambda)
  scripts/              deploy-service.sh, upload-k6.sh, and whatever else only this project runs
```

Each item below is something a sibling learned the hard way. Check every one.

**`infra/main` (the root module)**
- `versions.tf`: `cloud { workspaces { name = "<project>" } }` — the workspace is named here, never
  in the shell — and `required_version = "~> 1.14.0"` to match the workspace pin in `platform/`.
- `provider "aws"` with `default_tags { tags = { Project = var.project, ManagedBy = "terraform",
  Workspace = var.project } }`. Never tag per resource; `default_tags` cannot be forgotten.
- An account precondition on the resource everything depends on (both siblings: `aws_vpc.main`),
  comparing `data.aws_caller_identity.current.account_id` with `var.aws_account_id`.
- Outputs `base_url` and `k6_project_id` (re-exported from `module.k6`). `/loadtest`,
  `upload-k6.sh` and `/env` read both by name with `terraform output -json`.
- Nothing billable survives `destroy`: `skip_final_snapshot = true` on databases, an explicit
  `aws_cloudwatch_log_group` with `retention_in_days` for every log stream (a Lambda creates
  its own otherwise, untagged and kept forever), `force_delete = true` on ECR. No NAT
  gateway unless the spec names its cost.
- `dev.tfvars` holds every sizing knob and nothing secret.

**Secrets** (only if the project has its own, e.g. a database password): the value lives in the root
`.env`, documented in `.env.example`, and reaches remote runs through the shared variable set —
`platform/variables.tf` plus an entry in `local.tf_vars` in `platform/tfc.tf`. Never in a project
file. `ecs-rds-postgres-pool`'s `DB_PASSWORD` is the worked example.

**SLO and Grafana**
- `slo.yaml` plus `service/scripts/generate-slo.js` and the npm scripts `slo:generate` /
  `slo:check`. Generated files start `GENERATED from slo.yaml by npm run slo:generate`.
- Copy the test asserting every burn objective is above its floor (93.06% for 14.4×, 83.33% for 6×):
  below it the fast-burn alert can never fire and still looks healthy.
- Alert `runbook_url`s point at a README heading; renaming the heading breaks the link.

**k6 profiles** (`infra/k6/tests/`)
- At least `discovery`, `constant` and `stress` — CLAUDE.md requires a constant load at capacity and
  a spike that breaches the SLO.
- All import thresholds from the generated `lib/slo.js`, never inline their own.
- `lib/env.js` tags every sample `rate_source=default` when `RATE` is unset.
- `options.cloud.distribution` is Frankfurt (`amazon:de:frankfurt`); `preAllocatedVUs` stays under
  the 100-VU subscription cap; `dropped_iterations: ['count==0']` is a threshold.

**`verify/`** (the project side of `/verify`, `.claude/skills/verify/SKILL.md`). It is required: the
git pre-commit hook runs `verify.sh lint` on every directory with `infra/main` and refuses the commit
when `verify/` is missing or broken.
- **Deployed environment only.** No local launch, no DynamoDB Local, no database container: the user
  decided this on 2026-11-14 for every project. Recipes call the real `base_url`.
- Fork the nearest sibling's `verify/` (same header rule as above), then rewrite every recipe for this
  project's routes. Do not keep a sibling route that this service does not have.
- `target.sh` is sourced with `$TF_OUT` (`terraform output -json`). It must set `PROBE_PATH` to a
  seeded record, so `doctor` proves the data path and not only a health route. Set `TABLE_NAME` when
  there is a DynamoDB table (it turns on `ddb-get`), and `AUTH_HEADER` when the API needs a key. Read
  every value from an output; add the output to `infra/main/outputs.tf` if it is missing.
- `README.md`: baseline preconditions (`/env up`, the deploy and seed step, `attach`, `doctor`, no
  load test running), driving and proof conventions, the feature entry contract, and `## Features`
  with a link to every feature file.
- One file per user-facing route or behavior, taken from the route table in `service/src/` and the
  API resources in `infra/main/`. Exactly these H2s, in order: `Sub-features`,
  `How to get to it (user POV)`, `Driving it with verify.sh`, `Gotchas`. Each `Driving` section
  starts with `Preconditions:` and pairs each action with an exact `$V ...` command and the status
  and body it must return. A write needs a read-back step. A step that needs a knob that is off in
  `dev.tfvars` says so, and is reported as not run.
- `verify/target.sh` is not Terraform, so `.terraformignore` may leave it in the upload; it is
  harmless there.

**Scripts**
- `deploy-service.sh` is per platform — ECS pushes an image and forces a deployment; Lambda
  publishes a version. Never share one script across projects.
- `upload-k6.sh` with `--check` and `--rate`.
- Output helpers come from `../../scripts/lib.sh`. **No script runs `terraform apply` or
  `destroy`.**

## 4. The repo-wide files that must name the project

Nothing else outside `<project>/` changes. The git pre-commit hook and the Claude edit hook find the
root module from the path, and the hook finds every project for its `verify/` lint by `*/infra/main`,
so they need no entry. The `/verify` skill finds the project by its directory, so it needs none either.

1. **`platform/tfc.tf`** — one line in `local.projects`:
   `"<project>" = { working_directory = "infra/main" }`. This creates the TFC workspace, in remote
   execution mode with `infra/main` as working directory, which is what makes `../grafana`, `../k6`
   and `../../heartbeat` resolve inside a remote run. Then `terraform -chdir=platform apply` by hand
   — `platform/` is not part of `/env`.
2. **`README.md`**, the `## Projects` table: a row with directory, what it demonstrates, status.
3. **`CLAUDE.md`**, "Planned projects": update the entry if the project was listed there.
4. **Secrets**, only if any — see above.

## 5. Verify before the first apply

```bash
P=<project>
terraform fmt -check -recursive $P
terraform -chdir=$P/infra/main init -backend=false && terraform -chdir=$P/infra/main validate
(cd $P/service && npm ci && npm test && npm run slo:check)
for f in $P/infra/k6/tests/*.js; do k6 inspect "$f" >/dev/null || echo "BROKEN: $f"; done
grep -rn 'Project *=' $P/infra --include='*.tf'   # only in default_tags, nowhere per resource
.claude/skills/verify/scripts/verify.sh lint $P   # verify/ contract; the pre-commit hook runs it too
```

`k6 inspect` loads each profile with its imports and evaluates `options` and `thresholds` without
sending a request — the cheap check before a cloud run costs VU-hours.

After the platform apply: `./scripts/04-verify-setup.sh <project>` runs `terraform init` against the
real workspace. Then `terraform plan -var-file=dev.tfvars`, reviewed, and `/env up <project>`.

After the first `/env up` and `deploy-service.sh`, the project is not ready until `/verify <project>`
has run once on the live environment: `attach`, `doctor` with only `ok` lines, and at least one
feature file driven end to end, with its evidence. Fix the map, not the service, when a recipe is
wrong. When the service is wrong, keep the step and record the failure in that feature's `Gotchas`.
`lint` proves only the shape of the files; this run proves that the recipes are true.

## 6. Commit

Scope is the project name: `feat(<project>): ...`, with `/terraform` or `/k6` appended when the
layer matters. The `platform/tfc.tf` line is its own commit, `feat(platform): add <project>
workspace`, because it is applied separately and earlier. Run `graphify update .` afterwards if the
post-commit hook did not (it skips linked worktrees).
