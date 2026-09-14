# ecs-dynamodb-rps — the k6 project lives in the project stack

- **Date:** 2026-09-14
- **Status:** approved — every open question was answered on the review page
  <https://claude.ai/code/artifact/7bd700f1-df4e-4651-8f4c-fc0185808f68> on 2026-09-14. Plan:
  `docs/superpowers/plans/2026-09-14-ecs-dynamodb-rps-k6-project-ownership.md`.
- **Project directory:** `ecs-dynamodb-rps/` (plus the lines of `platform/` that own its k6 project)
- **Amends:** `docs/superpowers/specs/2026-09-02-ecs-dynamodb-rps-restructure-design.md` — **reverses
  section 7.2** ("k6 project — in `platform/`"), its decision-table row `k6-project-home`, and the
  rejected alternative "the k6 project staying in the project workspace (new id every apply)"; and
  narrows section 7.3's "done once per project rather than once per apply", which reverts to once per
  apply.
- **Research:** `docs/research/k6-project-ownership.md` — the reference sweep, the costs, and the
  reasoning behind each answer below.

---

## 1. The question

After `terraform destroy` of `ecs-dynamodb-rps/infra/main`, the Grafana Cloud k6 project
`ecs-dynamodb-rps` (id `8476029`) is still there. The ask: the project should live in the project
folder, have its own id, and be destroyed with the environment — with no shared
`K6_CLOUD_PROJECT_ID` in the root `.env`.

## 2. Why section 7.2's reasoning failed

Section 7.2 moved `grafana_k6_project` into `platform/` for two reasons.

**"The id becomes stable, so `K6_CLOUD_PROJECT_ID` and the README links stop rotting."** This was never
a property of the k6 project. It was a property of keeping a copy of a Terraform-owned value in `.env`
and in prose — a copy nothing updates. The repo already applies the right rule to the sibling value:
the root README's env table explains there is deliberately no `BASE_URL` key, because Terraform owns
the endpoint and everything reads `terraform output` instead of a copy. The k6 id is the same shape of
value and got the opposite treatment. Delete the copy and the argument is gone. It was also about to
break on its own: a second scenario is being designed, and one `K6_CLOUD_PROJECT_ID` cannot address
two k6 projects.

**"Run history survives `/env down`."** True, and not load-bearing. `/loadtest --compare` reads the
previous row in the project's `results.md`, not the cloud, so the before/after comparison survives a
deleted project untouched. And CLAUDE.md already forbids reporting an SLO or RPS number without the
output that produced it from a run in the same session, so an old cloud run was never citable
evidence.

Two facts that looked like obstacles are not. **Credentials:** the project workspace runs remotely,
but the variable set `platform/` manages already puts `GRAFANA_K6_ACCESS_TOKEN` and
`GRAFANA_STACK_ID` on every project workspace. **Cost:** a k6 project is not billable — Grafana Cloud
k6 meters virtual-user-hours per run — so this change is about teardown consistency, not money.

## 3. Decisions

| # | question | answer |
|---|---|---|
| K1 | browsable cloud run history | **accept the loss** — `results.md` is the record |
| K1a | the per-cycle re-upload | **accept** — `upload-k6.sh` by hand after every `/env up` |
| K2 | the live project `8476029` | **let it go** — deleted by the `platform/` apply, fresh id on the next `/env up` |
| K3 | `grafana_k6_project_limits` | **move it**, all four values explicit |
| K4 | the teardown sweep | **add a k6 check** — "with /env down I also want to remove relevant k6 project" |

## 4. Design

### 4.1 Terraform

- `ecs-dynamodb-rps/infra/k6/` **creates** `grafana_k6_project.this` (named `var.project`) and
  `grafana_k6_project_limits.this`, replacing `data "grafana_k6_projects"`. The four limits become
  module variables with today's values as defaults (`vu_max_per_test = 25000`,
  `vu_browser_max_per_test = 1000`, `vuh_max_per_month = 50000`, `duration_max_per_test = 18000`),
  and the warning comment moves with them verbatim: an unset attribute is sent as `null` and resets
  the live value, and the API exposes no endpoint to read limits back.
- `platform/k6.tf` is deleted, with its output `k6_project_ids` and its four limit variables.
  `local.projects` stays; it now drives only the TFC workspace and its settings. The platform
  workspace's `description` loses "and the k6 projects".
- The `one()`-of-empty-list guard ("apply `platform/` first") disappears with the data source. The
  folder dependency it did not guard remains: `platform/` still owns `high-load-test`, which the
  project's Grafana subfolder nests under.

### 4.2 The id is read from Terraform, never copied

`K6_CLOUD_PROJECT_ID` leaves `.env.example` and `scripts/02-create-env.sh`. Every reader asks
`terraform -chdir=infra/main output -json` and extracts `.k6_project_id.value // empty` with `jq` —
**never `output -raw`**, which against empty state prints a warning to stdout and exits 0. After
this change empty state is the normal condition between `/env down` and the next `/env up`, so that
trap stops being theoretical.

- `ecs-dynamodb-rps/scripts/upload-k6.sh` resolves the id from Terraform. Its two failure messages
  change from "apply `platform/`" to "apply the environment first", and the script now requires
  `infra/main` to be applied — reading an output is allowed for a project script; running `apply`
  is not.
- The `/loadtest` skill's API recipe stops using `$K6_CLOUD_PROJECT_ID`.

**Found during implementation, not in the research sweep:** `K6_CLOUD_PROJECT_ID` was not only read
by `upload-k6.sh` to *name* the project — it is how the `k6` binary itself picks the destination.
No script under `tests/` sets `options.cloud.projectID`, so `k6 cloud upload` and `k6 cloud run`
relied on the variable arriving implicitly from `.env` through direnv. Deleting the key alone would
have sent every upload to the stack's default project while the script read back from the Terraform
id and found nothing. Both now pass `K6_CLOUD_PROJECT_ID="$PROJECT_ID"` explicitly on the k6 command,
from the Terraform output — which also overrides a stale key left in someone's `.env`.

### 4.3 Teardown

`/env down` destroys the k6 project with everything else. The sweep that follows gains a Grafana
Cloud step after the AWS queries: list the stack's k6 projects
(`GET https://api.k6.io/cloud/v6/projects`, headers `Authorization: Bearer $K6_CLOUD_TOKEN` and
`X-Stack-Id: $GRAFANA_STACK_ID` — the shape `upload-k6.sh` already uses) and report any project named
for the project just torn down. The sweep runs locally, so these come from the root `.env`; a
failure there is the sweep's, not the destroy's, and the skill says so.

### 4.4 Migration of `8476029` (K2)

`platform/` stops declaring the project, so the `platform/` apply **deletes** `8476029` and its
limits. The next `infra/main` apply creates a fresh project. No `state rm`, no `import`. This must be
an explicit, ordered step: if the `platform/` change were merged without being applied, nothing would
ever delete `8476029`, and it would survive untracked and invisible to the sweep.

**Ordering hazard.** Until this branch is merged, the main checkout's `infra/k6` still looks the
project up by name. Applying `platform/` from this branch while the main checkout still carries the
lookup makes every plan from the main checkout fail. So: merge first, then apply `platform/`, then
apply `infra/main`.

### 4.5 Known risks carried into the apply

- **Deleting a k6 project that holds hand-uploaded load tests is untested.** The three profiles are
  pushed by `upload-k6.sh`, so Terraform does not know they exist. The `platform/` apply in 4.4 is the
  first test of it, and happens on a project nobody needs — which is exactly where to find out.
- **A freshly created project's starting limits are unknown.** K2 creates a new project and K3 asserts
  four values onto it; the apply output shows what changed.
- **The recorded null-out.** On 2026-09-01 `vuh_max_per_month` went `50000 -> null` because the HCP
  workspace was shared with a worktree in which the k6 file was *untracked*, so the configuration the
  run uploaded did not contain the resource. The mitigation is procedural: **commit before any apply
  from a worktree.** It is written next to the resource as well as here.

## 5. Consequences for other documents

- **Restructure design, section 7.2** — gets an inline "Amended 2026-09-14" block at the decision
  pointing here, in the same shape 7.1 and 7.3 already carry; the decision-table row and the rejected
  alternative get the same pointer.
- **SLO-relaxation spec** — its `Status:` line asserts the k6 project "still carries" the old uploaded
  configuration. It still does until the next teardown; the line gains that qualifier.
- **CLAUDE.md, README.md, `ecs-dynamodb-rps/README.md`, `platform/README.md`, `.env.example`, the
  `env` and `loadtest` skills** — every statement that `platform/` owns the k6 project, that its id
  is stable, or that it survives `/env down`, is corrected. The per-cycle re-upload (K1a) is added to
  the project README's known gaps.
- **The Postgres research note** (`docs/research/ecs-rds-postgres-pool.md`) says a new line in
  `platform/tfc.tf` creates the k6 project, and recommends `output -raw`. It is untracked and not on
  this branch, so it is corrected after the merge.

## 6. Out of scope

- Managing the load profiles as `grafana_k6_load_test` resources (declined again under K1a).
- Archiving run summaries (declined under K1).
- Dropping `grafana_k6_project_limits` (declined under K3).
