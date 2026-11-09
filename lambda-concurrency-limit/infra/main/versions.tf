# Forked from ecs-rds-postgres-pool/infra/main/versions.tf on 2026-11-09.
# A bug fixed here does not reach the sibling copy; fix both.
#
# The workspace is named here, never in the shell. It runs in REMOTE execution mode with working
# directory infra/main, both set by platform/tfc.tf: the upload root is then
# lambda-concurrency-limit/, so ../grafana and ../k6 resolve inside the run. The sibling's copy of
# this file explains the failure when they do not.
terraform {
  required_version = "~> 1.14.0"

  cloud {
    workspaces {
      name = "lambda-concurrency-limit"
    }
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    grafana = {
      source  = "grafana/grafana"
      version = "~> 3.0"
    }
    # Zips placeholder.js at plan time, so the first apply needs no build step.
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}

# Region comes from AWS_REGION (the shared variable set; eu-central-1). The preconditions on
# aws_dynamodb_table.items refuse any other region or account.
provider "aws" {
  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
      Workspace = var.project
    }
  }
}

data "aws_region" "current" {}

data "aws_caller_identity" "current" {}
