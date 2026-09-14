# `platform/`

The one Terraform root in this repo that is not a project. It owns the Terraform Cloud plumbing
every project workspace depends on, plus the one Grafana Cloud resource shared across projects:

| resource | what it is |
|---|---|
| `tfe_project.this` | the `high-load-test` Terraform Cloud project |
| `tfe_workspace.project` + `_settings` | one workspace per repo project (`local.projects` in `tfc.tf`) — remote execution, working directory, pinned `terraform_version`, `auto_apply = false` |
| `tfe_variable_set.shared` | every credential a project workspace needs, attached to the TFC project so future workspaces inherit it. Fed from the root `.env` via `TF_VAR_*` — **the only copy in HCP**, `.env` the only copy on disk |
| `grafana_folder.root` | the shared parent folder (fixed uid `high-load-test`) each project nests under |

**Not here: the Grafana Cloud k6 projects.** They lived here from 2026-09-03 to 2026-09-14, so that
the project id and run history survived `/env down`. They moved into each project's own
`infra/k6` module, created and destroyed with the environment, once the id stopped being copied into
`.env` — see `docs/superpowers/specs/2026-09-14-ecs-dynamodb-rps-k6-project-ownership-design.md`.
This stack still **forwards** `GRAFANA_K6_ACCESS_TOKEN` and `GRAFANA_STACK_ID` into the variable set,
because that is how each project's remote run authenticates to create its k6 project.

It **cannot run remotely**: this is the stack that creates the credentials the other workspaces run
with, so it runs locally against state in HCP. `tfe_workspace_settings.platform` pins
`execution_mode = "local"` so it cannot drift back — HCP creates every *new* workspace in remote
mode on `init`.

## How to run

```bash
terraform -chdir=platform init
terraform -chdir=platform plan
terraform -chdir=platform apply
```

From the repo root, in a direnv-loaded shell (root `README.md`, Step 2). Workspace identity comes
from `cloud { workspaces { name = "platform" } }` in `versions.tf`, never the shell — no
`TF_WORKSPACE`, no `env -u` prefix. Credentials *do* come from the shell, and this stack needs more
of them than any other root module: `TFE_TOKEN` for the `tfe` provider (`.envrc` aliases it from
`TF_TOKEN_app_terraform_io`), plus every `TF_VAR_*` it writes into the variable set.

An unloaded shell fails here first:

```
Error: Invalid or missing required argument
"organization" must be set in the cloud configuration or as an environment variable:
TF_CLOUD_ORGANIZATION.
```

`versions.tf` takes the org from the environment on purpose, so it never lands in a committed file.
Check for `direnv: loading …`, and `direnv allow` after any `.env` edit. Scripts and CI get no
direnv: `direnv exec . terraform -chdir=platform …`.

> A stale `TF_WORKSPACE=ecs-dynamodb-rps` in an older shell aborts the same way, by disagreeing with
> the `cloud` block. It was removed from `.env` on 2026-09-09 — unset it.

## Bootstrap sequence

Full detail in Task 7 of `docs/superpowers/plans/2026-09-03-ecs-dynamodb-rps-restructure.md`:

1. `terraform -chdir=platform init` — HCP creates the project and the `platform` workspace, in
   remote mode, because neither exists yet.
2. Switch that workspace to local execution: `PATCH /api/v2/workspaces/<ws-id>` with
   `"execution-mode": "local"`. A workspace cannot change its own execution mode from a run *inside*
   it, so this step alone comes from outside Terraform.
3. Import the five objects that now exist — `tfe_project.this`, `tfe_workspace.platform`,
   `tfe_workspace_settings.platform`, `tfe_workspace.project["ecs-dynamodb-rps"]`,
   `tfe_workspace_settings.project["ecs-dynamodb-rps"]`. The settings resources import by workspace
   id, not an id of their own.
4. `plan` — review the renames and working-directory changes as in-place updates — then `apply`.

(A fifth step, copying `k6_project_ids` into `K6_CLOUD_PROJECT_ID` in `.env`, was removed on
2026-09-14: neither the output nor the key exists any more.)

## Adding a project

Add one line to `local.projects` in `tfc.tf`:

```hcl
locals {
  projects = {
    "ecs-dynamodb-rps"    = { working_directory = "infra/main" }
    "<new-project-dir>"   = { working_directory = "infra/main" }
  }
}
```

That single map drives the TFC workspace and its execution-mode settings — nothing else in this
stack needs to change. The new project's Grafana Cloud k6 project is **not** created here: give the
project its own `infra/k6` module with `grafana_k6_project` + `grafana_k6_project_limits` (copy
`ecs-dynamodb-rps/infra/k6/`, including the comment on the limits resource).
