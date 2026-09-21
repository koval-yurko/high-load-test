# Forked from ecs-dynamodb-rps/infra/grafana/folder.tf on 2026-09-21.
# A bug fixed here does not reach the sibling copy; fix both.
# The parent folder is owned by platform/ and found by a FIXED literal -- a
# string, not a state read, so this project stays independent of the platform
# state ("projects must not import each other's state").
#
# The lookup key is `title`, not `uid`, and that is forced: in grafana/grafana
# 3.25.9 the grafana_folder DATA SOURCE takes title as its only required argument
# and exposes uid as computed-only, so `uid = "high-load-test"` fails the plan
# with "Value for unconfigurable attribute". platform/ sets the root folder's uid
# AND title to the same string, so the two keys name the same folder today -- but
# a rename of the title there would break this lookup, which is why it is
# hardcoded in one place and referenced nowhere else.
data "grafana_folder" "root" {
  title = "high-load-test"
}

# One folder per project, nested under it. Everything this module creates --
# dashboard, and later the SLO, burn and saturation rules -- lands inside, so /env down
# followed by /env up leaves the shared parent alone.
resource "grafana_folder" "project" {
  title             = var.project
  parent_folder_uid = data.grafana_folder.root.uid
}

# The template takes the generated query set PLUS the two datasource uids. The
# uids used to be string literals repeated 44 times inside the JSON, while these
# variables sat declared, passed in by terraform/grafana.tf, and read only by
# alerts.tf and slo.tf -- so the one file that pins a datasource per panel was
# the one file ignoring them. A hardcoded uid also breaks silently if the stack
# is ever rebuilt, because the panel keeps pointing at a datasource that is gone.
resource "grafana_dashboard" "attribution" {
  folder = grafana_folder.project.uid
  config_json = templatefile("${path.module}/dashboard.json.tftpl",
    merge(
      jsondecode(file("${path.module}/queries.json")),
      {
        cloudwatch_datasource_uid = var.cloudwatch_datasource_uid
        prometheus_datasource_uid = var.prometheus_datasource_uid
        # CloudWatch dimension values. Literal ARN suffixes here broke on every
        # recreate; the ECS and RDS names are stable but come from the same
        # variable the resources are named from, for the same reason.
        alb_arn_suffix          = var.alb_arn_suffix
        target_group_arn_suffix = var.target_group_arn_suffix
        project                 = var.project
      }
    )
  )
}
