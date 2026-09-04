# A module that uses grafana_* resources or data sources must name the provider
# source itself. Without this Terraform infers "hashicorp/grafana", which does not
# exist, and `init` fails before it can inherit the root's grafana provider
# configuration.
terraform {
  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "~> 3.0"
    }
  }
}
