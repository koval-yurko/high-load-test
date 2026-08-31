# Moved here from terraform/grafana.tf when grafana/ became a module; see the
# `moved` blocks there. path.module now resolves to grafana/, so the ../grafana
# prefix the root module needed is gone.
resource "grafana_folder" "project" {
  title = var.project
}

resource "grafana_dashboard" "attribution" {
  folder = grafana_folder.project.uid
  config_json = templatefile("${path.module}/dashboard.json.tftpl",
    jsondecode(file("${path.module}/queries.json"))
  )
}
