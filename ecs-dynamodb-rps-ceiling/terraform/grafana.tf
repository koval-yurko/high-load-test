# Grafana resources for this project's dashboards/alerts, per CLAUDE.md: "SLOs are code —
# Grafana dashboards, SLO definitions, and alert rules are checked in under the project's
# grafana/ and applied via Terraform (Grafana provider)."
#
# Provider auth comes from the GRAFANA_URL / GRAFANA_AUTH environment variables (sourced from
# the root .env) — never hardcode a token here or in a .tfvars file. The empty provider block
# below is intentional: the grafana provider reads those two env vars itself.
provider "grafana" {}

resource "grafana_folder" "project" {
  title = var.project
}

resource "grafana_dashboard" "attribution" {
  folder      = grafana_folder.project.uid
  config_json = file("${path.module}/../grafana/dashboard.json")
}

# alerts.tf is deliberately NOT wired in here yet — it declares its own variables
# (grafana_folder_uid, k6_prometheus_datasource_uid) and its rules have an unresolved
# precondition (see the comment block at the top of grafana/alerts.tf): they require k6
# metrics reaching the grafanacloud-prom datasource, which today means a local `k6 run -o
# experimental-prometheus-rw`, not `k6 cloud run`. Wire it in once that path is resolved.
