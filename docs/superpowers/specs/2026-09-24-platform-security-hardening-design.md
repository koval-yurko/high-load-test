# platform — security hardening (OWASP review follow-up)

- **Date:** 2026-09-24
- **Status:** **in progress.** The user asked for "all fixes" from the OWASP review of `platform/`
  on 2026-09-24. The code is on branch `claude/festive-hopper-25mvqy`. It passes `fmt -check`,
  `validate` and a mocked `terraform test` run (in a scratch copy, not committed, per CLAUDE.md's
  rule against unit tests for HCL). **`terraform -chdir=platform apply` has not been run.** That
  apply, and the credential rotation after it, are the remaining steps (see "Rollout" below).
- **Scope:** `platform/` plus the root `.envrc` and `.env.example` that feed it. No project's
  infrastructure changes. Two project files change only in comments or a variable description.
- **Amends:**
  - `docs/superpowers/specs/2026-09-02-ecs-dynamodb-rps-restructure-design.md`
    - **Tier 3 item 2.3**, "Dynamic provider credentials (OIDC) — declined". Reversed: see the
      "Why the earlier decisions changed" section below.
    - **Section 6**, the bullet on the `tfe_variable_set`: every credential in one set, scoped to
      the TFC project "so every future workspace inherits them". Reversed: the shared set now holds
      only non-secret values.
  - `docs/superpowers/specs/2026-09-19-ecs-rds-postgres-pool-design.md`, **section 7.4**: the
    ruling that `db_password` travels through the *shared* variable set. It now goes to that one
    workspace only.

  A forward-pointer is written at each of those decisions.

## Why the earlier decisions changed

The restructure spec treated the variable set as a convenience: one place to put credentials, and
every workspace inherits them. The review looked at the same design from the attacker's side and
found three things that design had not weighed:

1. **The platform state held every secret in plain text.** `tfe_variable.value` is saved to state.
   `sensitive = true` hides it from CLI output and nowhere else. So the claim "the variable set is
   the only copy in HCP" was false: the `platform` state was a second copy of the AWS keys, both
   Grafana tokens, both remote-write passwords and the database password.
2. **Plan permission is secret-read permission.** The project workspaces are CLI-driven and run
   remotely. Anyone who can queue a plan can upload any configuration. An `external` data source is
   enough to print `AWS_SECRET_ACCESS_KEY`. `auto_apply = false` does not help, because a plan
   alone is enough. With permanent IAM keys in the set, that meant a lasting AdministratorAccess
   key for anyone who could plan.
3. **Project scope fails open.** `ecs-dynamodb-rps` already received `db_password`, which it does
   not use. Every future workspace would receive everything.

OIDC was declined in 2.3 without a stated reason beyond the answer itself ("nope"). The weakness in
item 2 is what reverses it: with OIDC, a plan phase receives one-hour credentials for a read-only
role, not a permanent admin key.

## Design

| # | Finding (OWASP category) | Change |
|---|---|---|
| 1 | Secrets in platform state (A02 Cryptographic Failures) | Every secret is written with the write-only `value_wo` (Terraform ≥ 1.11, `hashicorp/tfe` 0.80.0 — checked against the provider schema). `value_wo_version` is the first 48 bits of the value's SHA-256, so editing `.env` and re-applying still propagates the change. |
| 2 | Plan permission reads credentials (A01 Broken Access Control; CI/CD-SEC-4 Poisoned Pipeline Execution) | The **plan** phase assumes a `ReadOnlyAccess` role and the **apply** phase an `AdministratorAccess` role. Each role's trust policy matches one workspace and one run phase exactly. `team_project_access` puts who may plan into code (empty = organization owners only). |
| 3 | Permanent IAM keys in HCP (A07 Identification and Authentication Failures) | `platform/aws.tf` adds an IAM OIDC provider for `app.terraform.io` and a plan role plus an apply role per project. Each workspace gets `TFC_AWS_PROVIDER_AUTH`, `TFC_AWS_PLAN_ROLE_ARN` and `TFC_AWS_APPLY_ROLE_ARN`. `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are removed from HCP; they stay in `.env` for local use only. |
| 4 | Every workspace gets every secret (A01; CI/CD-SEC-2 Inadequate Identity and Access Management) | The shared, project-attached set keeps only non-secret values: region, account id, Grafana URL, stack id, OTLP and Prometheus endpoints and usernames. Secrets become workspace variables, listed per project in `local.projects[*].secrets`. |
| 5 | An empty `.env` value blanks the value in HCP (A04 Insecure Design) | Every required string has a non-empty `validation`, plus format checks on `aws_account_id` (12 digits) and `grafana_service_account_id` (numeric). |
| 6 | Hardcoded organization default (A05 Security Misconfiguration) | `tfc_organization` has no default. `.envrc` sets it from `TF_CLOUD_ORGANIZATION`, the same variable the `cloud` block reads. |
| 7 | Loose provider constraints (A06 Vulnerable and Outdated Components; A08 Software and Data Integrity Failures) | `tfe ~> 0.80.0`, `grafana ~> 3.25.0`, `aws ~> 6.66.0`. The lockfile carries `h1:` hashes for linux and darwin (amd64 and arm64) and windows_amd64 for the new AWS provider. |
| 8 | Default Grafana folder permissions (A01) | A `grafana_folder_permission` gives Viewer→View and Editor→View on `high-load-test`, and the Terraform service account (`GRAFANA_SERVICE_ACCOUNT_ID`) Admin. Project folders inherit this. |
| 9 | No run alerting (A09 Security Logging and Monitoring Failures) | An optional `tfe_notification_configuration` per project workspace, triggered on `run:created`, `run:needs_attention` and `run:errored`, emails `TFC_NOTIFICATION_EMAIL`. It is off while that value is empty. |

### Trade-offs accepted

- **The apply role is still AdministratorAccess.** That is the same privilege as the IAM user it
  replaces. The projects create IAM roles, VPCs, ECS services, RDS, Lambda and Secrets Manager
  secrets, and a hand-written policy that has never been tested would break the first `/env up`.
  What improves is how the credential can be exposed. It lives one hour instead of until someone
  rotates it. It is issued only to an apply of that one workspace. And an apply needs a person to
  confirm it, because `auto_apply = false`. Narrowing the apply role is future work.
- **`ReadOnlyAccess` on the plan role is an assumption, not a measurement.** Both projects' data
  sources (`aws_caller_identity`, `aws_region`, `aws_availability_zones`) and every refresh read
  should fit inside it. The first remote plan per project confirms it. If a plan fails with
  `AccessDenied`, add that one read action to the plan role. Do not fall back to the apply role.
- **A 48-bit hash prefix of each secret is stored in state** (`value_wo_version`). The tokens are
  random and `db_password` must be at least 20 characters from a URL-safe alphabet, so a hash prefix
  does not help guess them. The alternative, a version number bumped by hand, silently stops
  propagating `.env` edits the first time someone forgets to bump it. That is the same class of
  failure as finding 5.
- **Values still pass through Terraform variables.** They are not declared `ephemeral`, because
  `value_wo_version` must be computed from them. They reach a saved plan file only with
  `plan -out`, and `tfplan*` is gitignored.

## Rollout

`platform/` is applied by hand (`terraform -chdir=platform apply`), never by `/env up`. The steps:

1. Add `GRAFANA_SERVICE_ACCOUNT_ID` to `.env`. Optionally add `TFC_NOTIFICATION_EMAIL`. Then run
   `direnv allow`.
2. `terraform -chdir=platform init -upgrade`. The constraints narrowed, so the lock must be
   re-checked. The versions do not change: tfe 0.80.0, grafana 3.25.9.
3. `plan`, then review. Expected changes:
   - Creates: the OIDC provider, 4 roles and 4 policy attachments, 8 workspace secrets, 6
     `TFC_AWS_*` variables, and the folder permission.
   - Destroys: 7 variables from the shared set (the two AWS keys, `GRAFANA_AUTH`,
     `GRAFANA_K6_ACCESS_TOKEN`, and the OTLP, Prometheus and database passwords).
   - Updates: the shared set's description. The non-secret variables that stay in the set are
     otherwise unchanged.
   - If the account already has an OIDC provider for `app.terraform.io`, import it rather than
     deleting it.
4. `apply`. This stops for approval: `terraform apply` is in `permissions.ask`.
5. Run one remote `plan` per project and confirm there is no `AccessDenied`. The account
   precondition on `aws_vpc.main` shows that the role belongs to the right account.
6. **Rotate every secret the old design exposed.** HCP keeps earlier state versions of the
   `platform` workspace, and those still contain the old values in plain text. Rotate the IAM user
   keys, `GRAFANA_AUTH`, the k6 token, the OTLP and Prometheus tokens, and `DB_PASSWORD`. Update
   `.env`, then run `direnv allow` and re-apply `platform/`. A changed database password also
   needs `/env up` on `ecs-rds-postgres-pool` to reach RDS. After rotating, delete the old IAM
   access key.
