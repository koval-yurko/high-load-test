# Everything observable about this project is declared in two sibling modules,
# because Terraform cannot include a .tf from outside its root module and
# CLAUDE.md requires the dashboards, SLO definitions and alert rules to live
# under the project rather than inline in the infrastructure root:
#
#   ../grafana  folder, dashboard, SLO, burn-rate rules, the throttle rule
#   ../k6       looks up the Grafana Cloud k6 project platform/ owns
#
# Both resolve only because the workspace's working directory is infra/main, so
# the run's upload root is ecs-dynamodb-rps/ -- see the comment in versions.tf.
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
}

# Read-only: the k6 project is created by platform/ and outlives /env down, so
# this module finds it by name and never manages it.
module "k6" {
  source = "../k6"

  project = var.project
}
