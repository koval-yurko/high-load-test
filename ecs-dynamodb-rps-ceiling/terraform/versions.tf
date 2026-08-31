terraform {
  required_version = ">= 1.9"

  # Organization and workspace come from TF_CLOUD_ORGANIZATION / TF_WORKSPACE,
  # so no environment-specific value is committed here.
  #
  # The workspace runs in REMOTE execution mode, so credentials live in HCP
  # rather than in a developer's shell (spec S11/S12). Two settings on the
  # workspace are load-bearing and invisible from this file:
  #
  #   execution-mode    = "remote"
  #   working-directory = "terraform"
  #
  # The working directory is not cosmetic. A CLI-driven remote run uploads the
  # directory the working directory is relative TO -- with it set, that root is
  # ecs-dynamodb-rps-ceiling/, so file("${path.module}/../grafana/...") resolves.
  # Unset, the upload root is terraform/ itself, ../grafana does not exist in the
  # run, and both collector.tf and grafana.tf fail with "no file exists at
  # ./../grafana/...". A ../grafana module source would fail the same way.
  # ../.terraformignore keeps node_modules and the service code out of that upload.
  cloud {}

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    grafana = {
      source  = "grafana/grafana"
      version = "~> 3.0"
    }
    # Zips heartbeat/ at plan time so the Lambda has no build step.
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}

# Region comes from AWS_REGION in the global .env.
provider "aws" {
  default_tags {
    tags = {
      Project = var.project
    }
  }
}

data "aws_region" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}
