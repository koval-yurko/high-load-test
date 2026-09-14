terraform {
  required_version = "~> 1.14.0"

  # Every root module in this repo names its own workspace here rather than taking
  # it from TF_WORKSPACE (CLAUDE.md, .env.example) -- this one is no longer the
  # exception it once was. It also pins the TFC project, because this is the stack
  # that CREATES that project: it cannot depend on TF_CLOUD_PROJECT pointing at it.
  cloud {
    workspaces {
      project = "high-load-test"
      name    = "platform"
    }
  }

  required_providers {
    # Verified against hashicorp/tfe 0.80.0 (2026-09-03): tfe_project_variable_set,
    # tfe_variable_set, tfe_variable (variable_set_id) and tfe_workspace_settings all
    # exist; tfe_workspace.execution_mode is deprecated in favour of
    # tfe_workspace_settings.execution_mode, and terraform_version still accepts a
    # constraint string ("~> 1.14.0"), not only an exact version.
    tfe = {
      source  = "hashicorp/tfe"
      version = "~> 0.80"
    }
    grafana = {
      source  = "grafana/grafana"
      version = "~> 3.0"
    }
  }
}

# TFE_TOKEN from the shell (.envrc aliases it from TF_TOKEN_app_terraform_io).
provider "tfe" {
  organization = var.tfc_organization
}

# GRAFANA_URL / GRAFANA_AUTH from the shell, for the shared folder. This stack creates no
# k6 resources any more; it only FORWARDS GRAFANA_K6_ACCESS_TOKEN and GRAFANA_STACK_ID into
# the variable set, where each project's remote run uses them to create its own k6
# project. Local execution is the point: this stack creates the credentials the remote
# workspaces run with, so it cannot itself run remotely.
provider "grafana" {}
