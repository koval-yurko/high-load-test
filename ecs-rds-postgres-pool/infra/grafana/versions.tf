# Forked from ecs-dynamodb-rps/infra/grafana/versions.tf on 2026-09-21.
# A bug fixed here does not reach the sibling copy; fix both.
# A module that uses grafana_* resources must name the provider source itself.
# Without this Terraform infers "hashicorp/grafana", which does not exist, and
# `init` fails before it can inherit the root's grafana provider configuration.
terraform {
  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "~> 3.0"
    }
  }
}
