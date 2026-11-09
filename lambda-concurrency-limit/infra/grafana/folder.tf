# Forked from ecs-rds-postgres-pool/infra/grafana/folder.tf on 2026-11-09 (the folder part).
# A bug fixed here does not reach the sibling copy; fix both.
# The parent folder is owned by platform/ and found by its fixed title, never by reading its state.
data "grafana_folder" "root" {
  title = "high-load-test"
}

resource "grafana_folder" "project" {
  title             = var.project
  parent_folder_uid = data.grafana_folder.root.uid
}

locals {
  # GENERATED from slo.yaml (npm run slo:generate): objectives, class thresholds, routes, burn.
  slo    = jsondecode(file("${path.module}/slo.json"))
  region = "eu-central-1"
}
