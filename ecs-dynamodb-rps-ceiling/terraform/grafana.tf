# CLAUDE.md requires alert rules and SLO definitions to live under the project's
# grafana/. Terraform cannot include a .tf from outside the root module, so
# grafana/ IS a module. Auth still comes from GRAFANA_URL / GRAFANA_AUTH in the
# environment -- never a token in a .tf or .tfvars file.
provider "grafana" {}

module "grafana" {
  source = "../grafana"

  project                   = var.project
  prometheus_datasource_uid = var.prometheus_datasource_uid
  cloudwatch_datasource_uid = var.cloudwatch_datasource_uid
  k6_project_id             = var.k6_project_id
}

# The folder and dashboard were declared here before grafana/ became a module.
# `moved` relocates them in state with no manual `terraform state mv`.
#
# These are NOT no-ops. The plan that introduced them assumed the resources might
# never have been applied -- Task 11's apply created both, and `terraform state
# list` shows grafana_folder.project and grafana_dashboard.attribution at the
# ROOT module. The moved blocks are load-bearing: get them wrong and the folder
# is destroyed and recreated, orphaning the dashboard.
moved {
  from = grafana_folder.project
  to   = module.grafana.grafana_folder.project
}

moved {
  from = grafana_dashboard.attribution
  to   = module.grafana.grafana_dashboard.attribution
}
