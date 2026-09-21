# Forked from ecs-dynamodb-rps/infra/main/grafana.tf on 2026-09-21.
# A bug fixed here does not reach the sibling copy; fix both.
# Everything observable about this project is declared in two sibling modules,
# because Terraform cannot include a .tf from outside its root module and
# CLAUDE.md requires the dashboards, SLO definitions and alert rules to live
# under the project rather than inline in the infrastructure root:
#
#   ../grafana  folder, dashboard, the saturation rules (saturation.tf, which
#               need no SLO threshold) and the canary; the SLO and burn-rate
#               rules join it once slo.yaml's class thresholds exist
#   ../k6       the Grafana Cloud k6 project and its limits
#
# Both resolve only because the workspace's working directory is infra/main, so
# the run's upload root is ecs-rds-postgres-pool/ -- see the comment in versions.tf.
# Auth still comes from GRAFANA_URL / GRAFANA_AUTH in the environment (the
# workspace's variable set) -- never a token in a .tf or .tfvars file.
provider "grafana" {}

module "grafana" {
  source = "../grafana"

  project                   = var.project
  prometheus_datasource_uid = var.prometheus_datasource_uid
  cloudwatch_datasource_uid = var.cloudwatch_datasource_uid

  # The dashboard's ALB panels take their CloudWatch dimensions from the live
  # resources. Hardcoded suffixes went silently empty on every recreate.
  alb_arn_suffix          = aws_lb.main.arn_suffix
  target_group_arn_suffix = aws_lb_target_group.app.arn_suffix

  # Saturation rules (saturation.tf). The two proxy rules follow knob 3, and
  # the module refuses to plan knob 3 until the borrow-latency threshold is set.
  proxy_enabled                  = var.proxy_enabled
  max_connections_alert          = var.max_connections_alert
  proxy_borrow_latency_threshold = var.proxy_borrow_latency_threshold
}

# Creates this project's k6 project, so /env down destroys it -- along with the
# load tests uploaded into it and its run history. Re-upload after every /env up.
module "k6" {
  source = "../k6"

  project = var.project
}
