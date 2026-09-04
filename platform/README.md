# `platform/`

The one Terraform root in this repo that is not a project. It owns the Terraform Cloud
plumbing every project workspace depends on, plus the Grafana Cloud resources shared across
projects:

- **`tfe_project.this`** — the `high-load-test` Terraform Cloud project.
- **`tfe_workspace.project` / `tfe_workspace_settings.project`** — one workspace per repo
  project directory (`local.projects` in `tfc.tf`), remote execution, working directory,
  pinned `terraform_version`, `auto_apply = false`.
- **`tfe_variable_set.shared`** — the AWS keys, region, account id, and the Grafana /
  Grafana Cloud k6 / OTLP / Prometheus credentials every project workspace needs, attached to
  the TFC project so every future workspace inherits them. Values come from the root `.env`
  via `TF_VAR_*`; **this variable set is the only copy in HCP**, `.env` the only copy on disk.
- **`grafana_folder.root`** — the shared parent folder (fixed uid `high-load-test`) that
  every project nests its own subfolder under.
- **`grafana_k6_project.project` / `grafana_k6_project_limits.project`** — one Grafana Cloud
  k6 project per repo project, with its upload limits. Living here instead of in the project's
  own state is what makes the k6 project id (and its run history) **survive `/env down`**.

What it cannot do: **run remotely**. This is the stack that creates the credentials the other
workspaces run with, so it has to run locally, with the developer's own `.env` in the shell and
state kept in HCP (`tfe_workspace_settings.platform` pins `execution_mode = "local"`, so it
cannot drift back to remote — HCP creates every *new* workspace in remote mode on `init`).

## Why every command unsets `TF_WORKSPACE`

The root `.env` exports `TF_WORKSPACE=<project workspace>` for the project roots (e.g.
`ecs-dynamodb-rps`), but this stack's `cloud { workspaces { name = "platform" } }` block names
its own workspace explicitly — and Terraform refuses to run when `TF_WORKSPACE` disagrees with
that block — so every command below runs with `TF_WORKSPACE` unset for this one invocation:

```bash
env -u TF_WORKSPACE terraform -chdir=platform init
env -u TF_WORKSPACE terraform -chdir=platform plan
env -u TF_WORKSPACE terraform -chdir=platform apply
```

## How to run

With [direnv](https://direnv.net/) installed, entering the repo root loads `.env` and the
`TFE_TOKEN` / `TF_VAR_*` aliases automatically (`.envrc`) — just run the commands above.

Without direnv, load the same values into your shell first:

```bash
set -a; source .env; set +a
source <(grep '^export ' .envrc)
env -u TF_WORKSPACE terraform -chdir=platform init
env -u TF_WORKSPACE terraform -chdir=platform plan
```

## Bootstrap sequence

Documented in full in Task 7 of the restructure plan
(`docs/superpowers/plans/2026-09-03-ecs-dynamodb-rps-restructure.md`). In short:

1. `env -u TF_WORKSPACE terraform -chdir=platform init` — HCP creates the `high-load-test`
   project and the `platform` workspace (in remote mode) because neither exists yet.
2. Switch the `platform` workspace to local execution — one API call, not a UI click:
   `PATCH /api/v2/workspaces/<ws-id>` with `"execution-mode": "local"`. A workspace cannot
   manage its own execution mode from a run *in* that mode, so this one change has to come
   from outside Terraform.
3. Import the five objects that already exist, against the hand-made project and workspace:
   `tfe_project.this <prj-id>`, `tfe_workspace.platform <platform-ws-id>`,
   `tfe_workspace_settings.platform <platform-ws-id>` (the settings resource imports by the
   workspace id, not an id of its own), `tfe_workspace.project["ecs-dynamodb-rps"] <ws-id>`
   and `tfe_workspace_settings.project["ecs-dynamodb-rps"] <ws-id>`.
4. `env -u TF_WORKSPACE terraform -chdir=platform plan` — review the rename and
   working-directory changes as in-place updates, then `apply`.
5. Read `k6_project_ids` and `workspace_ids` from the output and update `K6_CLOUD_PROJECT_ID`
   in `.env` once.

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

That single map drives the TFC workspace, its execution-mode settings, and the Grafana Cloud
k6 project + limits for the new project — nothing else in this stack needs to change.
