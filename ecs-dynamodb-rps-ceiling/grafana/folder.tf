# Moved here from terraform/grafana.tf when grafana/ became a module; see the
# `moved` blocks there. path.module now resolves to grafana/, so the ../grafana
# prefix the root module needed is gone.
resource "grafana_folder" "project" {
  title = var.project
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
      }
    )
  )
}
