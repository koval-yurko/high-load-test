# ecs-dynamodb-rps — move the k6 project into the project stack

- **Status:** partially executed (on hold) — Tasks 1–6 done: committed as one commit and pushed to
  `origin/master`. **Blocking the rest:** Tasks 7–8 are applies, which stop for approval by repo rule;
  and the main checkout must pull the commit first (Task 6's after-merge items).
- **Spec:** `docs/superpowers/specs/2026-09-14-ecs-dynamodb-rps-k6-project-ownership-design.md`
- **Goal:** `grafana_k6_project` and its limits are created and destroyed by
  `ecs-dynamodb-rps/infra/main`; no `K6_CLOUD_PROJECT_ID` anywhere; the `/env down` sweep checks
  Grafana Cloud k6.

---

## Task 1 — Terraform: move the resource

- [x] `ecs-dynamodb-rps/infra/k6/main.tf`: replace `data "grafana_k6_projects"` with
  `grafana_k6_project.this` + `grafana_k6_project_limits.this`; move the limits warning verbatim, plus
  the commit-before-apply note for the recorded null-out.
- [x] `ecs-dynamodb-rps/infra/k6/variables.tf`: the four limit variables, today's values as defaults.
- [x] `ecs-dynamodb-rps/infra/k6/outputs.tf` and `infra/main/outputs.tf`: value from the resource;
  descriptions no longer claim the id is stable.
- [x] `ecs-dynamodb-rps/infra/main/grafana.tf`: comments.
- [x] `platform/`: delete `k6.tf`, the `k6_project_ids` output and the four limit variables; correct the
  workspace description and the provider comment.
- [x] Verify: `terraform fmt -check -recursive` and `validate` for both roots.

## Task 2 — Readers of the id

- [x] `ecs-dynamodb-rps/scripts/upload-k6.sh`: id from `terraform output -json | jq`, never `-raw`;
  failure messages say "apply the environment first".
- [x] `.env.example`, `scripts/02-create-env.sh`: remove the key and its deferred handling.
- [x] `.claude/skills/loadtest/SKILL.md`: the API recipe reads the id from Terraform.

## Task 3 — Teardown sweep

- [x] `.claude/skills/env/SKILL.md`: `platform/` no longer owns k6 projects; add the k6 step to the
  sweep; `status` reports the k6 project.

## Task 4 — Documentation

- [x] CLAUDE.md, README.md, `ecs-dynamodb-rps/README.md`, `platform/README.md`.
- [x] Restructure design section 7.2, its decision row and rejected alternative, and 7.3: inline
  amendments pointing at the new spec. Restructure plan: a forward-pointer at the k6 step.
- [x] SLO-relaxation spec: qualify the status line.

## Task 5 — Plan both roots (no apply)

- [x] `terraform -chdir=platform plan` — expect exactly the two k6 resources destroyed and the platform
  workspace description changed.
- [x] `terraform -chdir=ecs-dynamodb-rps/infra/main plan -var-file=dev.tfvars` — expect the k6 project
  and its limits created. Recorded below.

## Task 6 — Commit and merge (needs the user)

- [x] Commit on the branch. **Commit before any apply**: the 2026-09-01 null-out came from an untracked
  k6 file in a worktree sharing the workspace.
- [x] Merge to `master` — pushed as a single commit straight to `origin/master` (a fast-forward; the
  branch was cut from it). Must precede Task 7 — until the main checkout has it, it still looks the
  project up by name, and applying `platform/` makes its plans fail. **Pull it into the main checkout
  before Task 7.**
- [ ] After merge: remove `K6_CLOUD_PROJECT_ID` from the real root `.env` (gitignored, so no commit
  catches it), and correct `docs/research/ecs-rds-postgres-pool.md` (untracked, not on this branch).

## Task 7 — Apply `platform/` (STOPS FOR APPROVAL)

- [ ] `terraform -chdir=platform apply` — deletes `8476029` and its limits. This is the first test of
  deleting a project that holds hand-uploaded tests; if it refuses, stop and report.
- [ ] Confirm via `GET https://api.k6.io/cloud/v6/projects` that no `ecs-dynamodb-rps` project remains.

## Task 8 — Apply `infra/main` (STOPS FOR APPROVAL)

- [ ] **From the main checkout, after the merge — never from this worktree.** The live environment was
  applied from the main checkout's uncommitted `dev.tfvars`; this branch carries the committed one, so
  an apply from here would also resize the table and remove autoscaling (see the Task 5 record).
- [ ] `/env up ecs-dynamodb-rps` (or, if the environment is already up, the plain apply) — creates the new
  project. Record the new id and the limits the apply set.
- [ ] `./scripts/upload-k6.sh` — re-upload the three profiles into the new project.

---

## Execution record

**Tasks 1–4, 2026-09-14.** Done as listed. One finding beyond the research sweep: `k6 cloud upload` and
`k6 cloud run` picked their destination project from `K6_CLOUD_PROJECT_ID` arriving implicitly from
`.env` — no test sets `options.cloud.projectID` — so removing the key alone would have sent uploads to
the stack's default project. `upload-k6.sh` and the `/loadtest` recipe now pass it explicitly from
Terraform. Recorded in the spec, section 4.2. The sweep's k6 query was run against the live API and
returned `8476029  ecs-dynamodb-rps  created 2026-09-04T05:57:23.158973Z`, confirming the response
shape (`.value[]`, `.name`).

`terraform fmt -check -recursive` passes for `platform/` and `ecs-dynamodb-rps/infra`; `validate` passes
for both roots (warnings only: the pre-existing `failure_threshold` deprecation and local provider
dev-overrides); `bash -n` passes for both edited scripts.

**Task 5, 2026-09-14.** `terraform -chdir=platform plan`:

```
grafana_k6_project.project["ecs-dynamodb-rps"] will be destroyed        id = "8476029"
grafana_k6_project_limits.project["ecs-dynamodb-rps"] will be destroyed
tfe_workspace.platform will be updated in-place                          (description)
Plan: 0 to add, 1 to change, 2 to destroy.
```

`terraform -chdir=ecs-dynamodb-rps/infra/main plan -var-file=dev.tfvars`, from the worktree:

```
module.k6.grafana_k6_project.this will be created          name = "ecs-dynamodb-rps"
module.k6.grafana_k6_project_limits.this will be created   25000 / 1000 / 50000 / 18000
aws_appautoscaling_policy.cpu[0] will be destroyed          -- drift, not this branch
aws_appautoscaling_target.ecs[0] will be destroyed          -- drift, not this branch
aws_dynamodb_table.items will be updated in-place           1000 -> 25, 500 -> 25 -- drift
aws_iam_role_policy.task will be updated in-place           re-read only, follows the table
Plan: 2 to add, 2 to change, 2 to destroy.
```

The four non-k6 lines are the difference between this branch's committed `dev.tfvars`
(`read_capacity = 25`, `write_capacity = 25`, autoscaling off) and the live environment, which was
applied from the main checkout's uncommitted edits. No file this branch touches affects them. Hence
Task 8's "from the main checkout" rule.
