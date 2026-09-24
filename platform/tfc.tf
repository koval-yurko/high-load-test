# The Terraform Cloud project, one workspace per repo project, the shared
# variable set attached to the project, and the variables in it.

resource "tfe_project" "this" {
  name = var.tfc_project_name
}

# The platform workspace manages itself. execution_mode lives on
# tfe_workspace_settings (below), not on this resource -- execution_mode on
# tfe_workspace itself is deprecated as of hashicorp/tfe 0.80.0.
resource "tfe_workspace" "platform" {
  name        = "platform"
  project_id  = tfe_project.this.id
  description = "Owns the TFC project, the project workspaces, the shared variable set, the shared Grafana folder. See docs/superpowers/specs/2026-09-02-ecs-dynamodb-rps-restructure-design.md section 6; each project's k6 project lives in that project's own stack."
  tag_names   = ["high-load-test", "platform"]
}

# Local execution, so this workspace never drifts back to remote. HCP creates
# every new workspace in remote mode on init; Task 7 Step 1 switches it before
# the first plan, and this resource manages it thereafter.
resource "tfe_workspace_settings" "platform" {
  workspace_id   = tfe_workspace.platform.id
  execution_mode = "local"
}

locals {
  # One entry per repo project directory. Adding a project is adding an entry here --
  # which creates its TFC workspace, its two AWS run roles (aws.tf) and its secrets.
  # It no longer creates the k6 project: that is in the project's own infra/k6 module,
  # created and destroyed with the environment.
  #
  # `secrets` is the least-privilege list: a workspace receives exactly the secrets
  # named here and no others (keys of local.secrets below). Before 2026-09-24 every
  # secret sat in the project-wide variable set, so every workspace -- and every
  # future one -- received all of them, db_password included.
  projects = {
    "ecs-dynamodb-rps" = {
      working_directory = "infra/main"
      secrets           = ["GRAFANA_AUTH", "GRAFANA_K6_ACCESS_TOKEN", "grafana_otlp_password", "grafana_prom_password"]
    }
    "ecs-rds-postgres-pool" = {
      working_directory = "infra/main"
      secrets           = ["GRAFANA_AUTH", "GRAFANA_K6_ACCESS_TOKEN", "grafana_otlp_password", "db_password"]
    }
  }
}

resource "tfe_workspace" "project" {
  for_each = local.projects

  name              = each.key
  project_id        = tfe_project.this.id
  working_directory = each.value.working_directory
  terraform_version = "~> 1.14.0" # Tier 1.3 -- matches both roots' required_version (~> 1.14.0) and the README
  auto_apply        = false
  queue_all_runs    = false
  description       = "Scenario ${each.key}. Root module at ${each.key}/${each.value.working_directory}; the upload root is ${each.key}/ so ../grafana, ../k6 and ../../heartbeat resolve."
  tag_names         = ["high-load-test", each.key]
}

# execution_mode lives here, not on tfe_workspace.project, for the same
# deprecation reason as the platform workspace above.
resource "tfe_workspace_settings" "project" {
  for_each = local.projects

  workspace_id   = tfe_workspace.project[each.key].id
  execution_mode = "remote"
}

# Non-secret values only. Attached to the project, so every workspace -- including
# ones added later -- inherits them; that is fine for a region or an endpoint, and it
# is exactly why no secret may live here (see local.secrets below).
resource "tfe_variable_set" "shared" {
  name        = "high-load-test"
  description = "Non-secret settings and endpoints every project workspace needs. Values come from the root .env via TF_VAR_*. Secrets are per workspace and AWS credentials come from OIDC -- see platform/tfc.tf."
}

resource "tfe_project_variable_set" "shared" {
  project_id      = tfe_project.this.id
  variable_set_id = tfe_variable_set.shared.id
}

locals {
  env_vars = {
    AWS_REGION       = var.aws_region
    GRAFANA_URL      = var.grafana_url
    GRAFANA_STACK_ID = var.grafana_stack_id
  }
  tf_vars = {
    aws_account_id        = var.aws_account_id
    grafana_otlp_endpoint = var.grafana_otlp_endpoint
    grafana_otlp_username = var.grafana_otlp_username
    grafana_prom_url      = var.grafana_prom_url
    grafana_prom_username = var.grafana_prom_username
  }
}

resource "tfe_variable" "env" {
  for_each = local.env_vars

  key             = each.key
  value           = each.value
  category        = "env"
  variable_set_id = tfe_variable_set.shared.id
}

resource "tfe_variable" "terraform" {
  for_each = local.tf_vars

  key             = each.key
  value           = each.value
  category        = "terraform"
  variable_set_id = tfe_variable_set.shared.id
}

# --- Secrets: per workspace, write-only ---------------------------------------
#
# value_wo is never written to this stack's state or shown in a plan, so the
# `platform` workspace's state no longer holds a copy of every credential in the
# repo. The cost is that Terraform cannot see a changed value, so value_wo_version
# must change with it: it is the first 48 bits of the value's SHA-256, which
# changes whenever .env does and reveals nothing usable about a high-entropy token
# or a 20+ character password. Re-apply platform/ after editing .env, as before.
locals {
  secrets = {
    GRAFANA_AUTH            = { category = "env", value = var.grafana_auth }
    GRAFANA_K6_ACCESS_TOKEN = { category = "env", value = var.grafana_k6_access_token }
    grafana_otlp_password   = { category = "terraform", value = var.grafana_otlp_password }
    grafana_prom_password   = { category = "terraform", value = var.grafana_prom_password }
    # ecs-rds-postgres-pool's database password (its plan, decision D7).
    db_password = { category = "terraform", value = var.db_password }
  }

  # "<project>/<key>" => { project, key }. Built from local.projects alone, so no
  # sensitive value reaches for_each.
  workspace_secrets = merge([
    for name, p in local.projects : {
      for key in p.secrets : "${name}/${key}" => { project = name, key = key }
    }
  ]...)
}

resource "tfe_variable" "secret" {
  for_each = local.workspace_secrets

  key              = each.value.key
  category         = local.secrets[each.value.key].category
  value_wo         = local.secrets[each.value.key].value
  value_wo_version = parseint(substr(sha256(local.secrets[each.value.key].value), 0, 12), 16)
  sensitive        = true
  workspace_id     = tfe_workspace.project[each.value.project].id
}

# --- AWS: dynamic provider credentials ----------------------------------------
#
# The three env vars that make an HCP run assume a role through OIDC instead of
# reading static keys. The plan phase gets the read-only role, the apply phase the
# admin one (aws.tf) -- so a speculative plan, which anyone with plan permission
# can queue with arbitrary configuration, cannot change anything in the account.
locals {
  aws_auth_keys = ["TFC_AWS_PROVIDER_AUTH", "TFC_AWS_PLAN_ROLE_ARN", "TFC_AWS_APPLY_ROLE_ARN"]
}

resource "tfe_variable" "aws_auth" {
  for_each = {
    for pair in setproduct(keys(local.projects), local.aws_auth_keys) :
    "${pair[0]}/${pair[1]}" => { project = pair[0], key = pair[1] }
  }

  key      = each.value.key
  category = "env"
  value = {
    TFC_AWS_PROVIDER_AUTH  = "true"
    TFC_AWS_PLAN_ROLE_ARN  = aws_iam_role.run["${each.value.project}/plan"].arn
    TFC_AWS_APPLY_ROLE_ARN = aws_iam_role.run["${each.value.project}/apply"].arn
  }[each.value.key]
  workspace_id = tfe_workspace.project[each.value.project].id
}

# --- Who can queue runs -------------------------------------------------------
#
# A plan runs whatever configuration it is given, with whatever the workspace
# holds, so plan permission on a project workspace is read access to its secrets.
# Kept in code so that list is reviewable; empty means org owners only.
data "tfe_team" "access" {
  for_each = var.team_project_access

  name = each.key
}

resource "tfe_team_project_access" "this" {
  for_each = var.team_project_access

  team_id    = data.tfe_team.access[each.key].id
  project_id = tfe_project.this.id
  access     = each.value
}

# --- Run notifications --------------------------------------------------------
#
# run:created is the one that matters: a plan nobody started is how a credential
# read through a workspace would show up. Off when run_notification_email is "".
data "tfe_organization_membership" "notify" {
  count = var.run_notification_email == "" ? 0 : 1

  email        = var.run_notification_email
  organization = var.tfc_organization
}

resource "tfe_notification_configuration" "runs" {
  for_each = var.run_notification_email == "" ? {} : local.projects

  name             = "run-activity"
  enabled          = true
  destination_type = "email"
  email_user_ids   = [data.tfe_organization_membership.notify[0].user_id]
  triggers         = ["run:created", "run:needs_attention", "run:errored"]
  workspace_id     = tfe_workspace.project[each.key].id
}

# Deliberately absent: GRAFANA_SM_ACCESS_TOKEN (unused since the heartbeat
# replaced Synthetic Monitoring) and read_capacity / write_capacity (they
# duplicate dev.tfvars and outrank it in a remote run) -- Tier 1.7. Task 7
# Step 4 deletes the workspace-level copies. And since 2026-09-24,
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY: replaced by the OIDC roles above.
