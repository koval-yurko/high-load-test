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

  # Pinned to the patch level, not the major: this stack runs LOCALLY with every
  # credential in the repo in its environment, so a provider upgrade is code that
  # runs next to all of them. The lockfile holds today's versions; the narrow
  # constraint makes `init -upgrade` a deliberate edit here rather than a silent
  # jump (platform security review, 2026-09-24).
  required_providers {
    # Verified against hashicorp/tfe 0.80.0 (2026-09-03): tfe_project_variable_set,
    # tfe_variable_set, tfe_variable (variable_set_id) and tfe_workspace_settings all
    # exist; tfe_workspace.execution_mode is deprecated in favour of
    # tfe_workspace_settings.execution_mode, and terraform_version still accepts a
    # constraint string ("~> 1.14.0"), not only an exact version. Re-verified
    # 2026-09-24: tfe_variable has the write-only value_wo + value_wo_version pair.
    tfe = {
      source  = "hashicorp/tfe"
      version = "~> 0.80.0"
    }
    grafana = {
      source  = "grafana/grafana"
      version = "~> 3.25.0"
    }
    # The HCP Terraform OIDC provider and the per-workspace run roles (aws.tf).
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.66.0"
    }
  }
}

# TFE_TOKEN from the shell (.envrc aliases it from TF_TOKEN_app_terraform_io).
provider "tfe" {
  organization = var.tfc_organization
}

# GRAFANA_URL / GRAFANA_AUTH from the shell, for the shared folder. This stack creates no
# k6 resources any more; it only hands GRAFANA_K6_ACCESS_TOKEN and GRAFANA_STACK_ID to the
# project workspaces, where each project's remote run uses them to create its own k6
# project. Local execution is the point: this stack creates the credentials the remote
# workspaces run with, so it cannot itself run remotely.
provider "grafana" {}

# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION from the shell -- the IAM user
# keys in the root .env, which since 2026-09-24 never leave the machine: remote runs get
# short-lived role credentials through the OIDC provider in aws.tf instead.
provider "aws" {
  default_tags {
    # Not a project, so not swept by /env down -- these resources are long-lived like
    # the rest of this stack. The tag still says where they come from.
    tags = {
      Project   = "platform"
      ManagedBy = "terraform"
      Workspace = "platform"
    }
  }
}
