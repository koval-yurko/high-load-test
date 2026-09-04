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
  description = "Owns the TFC project, the project workspaces, the shared variable set, the shared Grafana folder and the k6 projects. See docs/superpowers/specs/2026-09-02-ecs-dynamodb-rps-restructure-design.md section 6."
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
  # One entry per repo project directory. Adding a project is adding a line here.
  projects = {
    "ecs-dynamodb-rps" = { working_directory = "infra/main" }
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

resource "tfe_variable_set" "shared" {
  name        = "high-load-test"
  description = "Credentials and endpoints every project workspace needs. Values come from the root .env via TF_VAR_*; this is the only copy in HCP."
}

resource "tfe_project_variable_set" "shared" {
  project_id      = tfe_project.this.id
  variable_set_id = tfe_variable_set.shared.id
}

locals {
  env_vars = {
    AWS_ACCESS_KEY_ID       = { value = var.aws_access_key_id, sensitive = true }
    AWS_SECRET_ACCESS_KEY   = { value = var.aws_secret_access_key, sensitive = true }
    AWS_REGION              = { value = var.aws_region, sensitive = false }
    GRAFANA_URL             = { value = var.grafana_url, sensitive = false }
    GRAFANA_AUTH            = { value = var.grafana_auth, sensitive = true }
    GRAFANA_K6_ACCESS_TOKEN = { value = var.grafana_k6_access_token, sensitive = true }
    GRAFANA_STACK_ID        = { value = var.grafana_stack_id, sensitive = false }
  }
  tf_vars = {
    aws_account_id        = { value = var.aws_account_id, sensitive = false }
    grafana_otlp_endpoint = { value = var.grafana_otlp_endpoint, sensitive = false }
    grafana_otlp_username = { value = var.grafana_otlp_username, sensitive = false }
    grafana_otlp_password = { value = var.grafana_otlp_password, sensitive = true }
    grafana_prom_url      = { value = var.grafana_prom_url, sensitive = false }
    grafana_prom_username = { value = var.grafana_prom_username, sensitive = false }
    grafana_prom_password = { value = var.grafana_prom_password, sensitive = true }
  }
}

resource "tfe_variable" "env" {
  for_each = local.env_vars

  key             = each.key
  value           = each.value.value
  category        = "env"
  sensitive       = each.value.sensitive
  variable_set_id = tfe_variable_set.shared.id
}

resource "tfe_variable" "terraform" {
  for_each = local.tf_vars

  key             = each.key
  value           = each.value.value
  category        = "terraform"
  sensitive       = each.value.sensitive
  variable_set_id = tfe_variable_set.shared.id
}

# Deliberately absent: GRAFANA_SM_ACCESS_TOKEN (unused since the heartbeat
# replaced Synthetic Monitoring) and read_capacity / write_capacity (they
# duplicate dev.tfvars and outrank it in a remote run) -- Tier 1.7. Task 7
# Step 4 deletes the workspace-level copies.
