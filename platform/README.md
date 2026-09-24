# `platform/`

The one Terraform root in this repo that is not a project. It owns the Terraform Cloud plumbing
every project workspace depends on, plus the one Grafana Cloud resource shared across projects:

| resource | what it is |
|---|---|
| `tfe_project.this` | the `high-load-test` Terraform Cloud project |
| `tfe_workspace.project` + `_settings` | one workspace per repo project (`local.projects` in `tfc.tf`) — remote execution, working directory, pinned `terraform_version`, `auto_apply = false` |
| `tfe_variable_set.shared` | the **non-secret** values every project workspace needs (region, account id, Grafana URL and stack id, OTLP/Prometheus endpoints and usernames), attached to the TFC project so future workspaces inherit them |
| `tfe_variable.secret` | each workspace's secrets — only those listed in its `local.projects[*].secrets` — written with the write-only `value_wo`, so **no secret is stored in this stack's state** |
| `aws_iam_openid_connect_provider.hcp_terraform` + `aws_iam_role.run` | dynamic AWS credentials: per workspace, a `ReadOnlyAccess` role for the plan phase and an `AdministratorAccess` role for apply, each trusting exactly that workspace and phase. `tfe_variable.aws_auth` points the workspace at them. **No AWS key is stored in HCP** |
| `grafana_folder.root` + `grafana_folder_permission.root` | the shared parent folder (fixed uid `high-load-test`) each project nests under; Editors get View only, the Terraform service account Admin |
| `tfe_team_project_access.this`, `tfe_notification_configuration.runs` | optional: who may use the project workspaces (`team_project_access`, empty = org owners), and run emails (`TFC_NOTIFICATION_EMAIL`, empty = off) |

**Not here: the Grafana Cloud k6 projects.** They lived here from 2026-09-03 to 2026-09-14, so that
the project id and run history survived `/env down`. They moved into each project's own
`infra/k6` module, created and destroyed with the environment, once the id stopped being copied into
`.env` — see `docs/superpowers/specs/2026-09-14-ecs-dynamodb-rps-k6-project-ownership-design.md`.
This stack still **forwards** `GRAFANA_K6_ACCESS_TOKEN` (a workspace secret) and `GRAFANA_STACK_ID`
(the shared set) to the project workspaces, because that is how each project's remote run
authenticates to create its k6 project.

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
`TF_TOKEN_app_terraform_io`), the `.env` AWS keys for the `aws` provider (read directly, never
forwarded anywhere), plus every `TF_VAR_*` it writes into HCP. Every required `TF_VAR_*` is validated
non-empty: `.envrc` turns a missing `.env` line into `""`, and the plan fails on it rather than
blanking the value in HCP.

**After changing a secret in `.env`, re-apply this stack.** Secrets are write-only, so Terraform
cannot see the old value. It notices a change through `value_wo_version`, a 48-bit prefix of the
value's SHA-256, which changes with the value.

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

## Security model

This stack holds every credential in the repo, so its design rules are about limiting who can read
them. The findings behind each rule are in
`docs/superpowers/specs/2026-09-24-platform-security-hardening-design.md`.

- **No secret in state.** Secrets use `value_wo`. Non-secret values use plain `value` and live in
  the shared set.
- **Plan permission equals reading the secrets.** A CLI-driven remote plan runs whatever
  configuration it is given, with whatever the workspace holds. That is why the plan phase gets a
  read-only AWS role, why each workspace holds only its own secrets, and why `team_project_access`
  lists every team that can plan (empty means org owners only).
- **No long-lived AWS key leaves the machine.** Remote runs get one-hour OIDC role credentials. The
  apply role is still `AdministratorAccess`, the same privilege as the IAM user keys it replaced.
  Narrowing it is future work.
- **Provider versions are pinned to the patch level** (`~> x.y.z`), because this stack runs locally
  with every credential in its environment.

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

Add one entry to `local.projects` in `tfc.tf`:

```hcl
locals {
  projects = {
    "<new-project-dir>" = {
      working_directory = "infra/main"
      secrets           = ["GRAFANA_AUTH", "GRAFANA_K6_ACCESS_TOKEN", "grafana_otlp_password"]
    }
  }
}
```

That single map drives the TFC workspace, its execution-mode settings, its plan and apply IAM roles
and its secrets. Nothing else in this stack needs to change. List **only** the secrets the project
declares. A workspace receives nothing secret it does not name here; that is the point. A new
secret needs a variable in `variables.tf`, an entry in `local.secrets` and a `.envrc` alias. The new project's Grafana Cloud k6 project is **not** created here: give the
project its own `infra/k6` module with `grafana_k6_project` + `grafana_k6_project_limits` (copy
`ecs-dynamodb-rps/infra/k6/`, including the comment on the limits resource).
