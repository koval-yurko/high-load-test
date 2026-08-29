terraform {
  required_version = ">= 1.9"

  # Organization and workspace come from TF_CLOUD_ORGANIZATION / TF_WORKSPACE,
  # so no environment-specific value is committed here.
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
