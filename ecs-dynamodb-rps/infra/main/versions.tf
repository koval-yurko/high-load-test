terraform {
  # Matches the workspace pin platform/tfc.tf sets (terraform_version = "~> 1.14.0")
  # and the README's verified version -- local is 1.14.0, the remote runner 1.14.9.
  required_version = "~> 1.14.0"

  # Organization and workspace come from TF_CLOUD_ORGANIZATION / TF_WORKSPACE,
  # so no environment-specific value is committed here.
  #
  # The workspace runs in REMOTE execution mode, so credentials live in HCP
  # rather than in a developer's shell (spec S11/S12). Two settings on the
  # workspace are load-bearing and invisible from this file -- platform/ owns the
  # workspace and sets both:
  #
  #   execution-mode    = "remote"
  #   working-directory = "infra/main"
  #
  # The working directory is not cosmetic. A CLI-driven remote run uploads the
  # directory the working directory is relative TO -- with it set to infra/main,
  # that upload root is ecs-dynamodb-rps/, and everything this root module reaches
  # for outside its own directory resolves inside the run: the module sources
  # ../grafana and ../k6, file("${path.module}/../grafana/...") in collector.tf,
  # and the archive_file that zips ../../heartbeat so the Lambda has no build
  # step. Unset, the upload root would be infra/main/ itself, none of those paths
  # would exist in the run, and it would fail with "no file exists at
  # ./../grafana/..." -- a ../grafana module source fails the same way.
  # ecs-dynamodb-rps/.terraformignore, which sits at that upload root, keeps
  # node_modules and the service code out of the upload.
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
    # Project is what the teardown sweep queries. ManagedBy says, to a human
    # reading the console, that nothing here should be edited by hand. Workspace
    # names the state that owns the resource -- without it an orphan the sweep
    # finds tells you which project it belongs to but not which state to look in,
    # and this repo will have several workspaces under one account.
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
      Workspace = var.project
    }
  }
}

data "aws_region" "current" {}

# Feeds the account precondition on aws_vpc.main in network.tf. A run carrying
# another account's credentials must fail the plan, not quietly propose a second
# copy of this environment somewhere nobody is looking for it.
data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}
