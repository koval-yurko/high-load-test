# The shared parent folder every project nests its own subfolder under.
#
# uid AND title are both the fixed string "high-load-test", and both stay fixed:
# a project module finds this folder with
# data "grafana_folder" { title = "high-load-test" } instead of reading this
# stack's state -- "projects must not import each other's state" holds.
#
# TITLE, not uid, is what the lookup keys on, and that is forced by the
# provider: in grafana/grafana 3.25.9 the grafana_folder DATA SOURCE takes title
# as its only key and exposes uid as computed-only, so `uid = "high-load-test"`
# on the data source fails the plan with "Value for unconfigurable attribute".
# The uid is still pinned here (rather than left generated) so the folder keeps
# one stable address in URLs and in any future lookup that can take one -- but
# renaming the TITLE below is the breaking change, because
# ecs-dynamodb-rps/infra/grafana/folder.tf hardcodes it.
resource "grafana_folder" "root" {
  uid   = "high-load-test"
  title = "high-load-test"
}

# The folder's whole permission set -- grafana_folder_permission replaces whatever is
# there, and project folders nested under this one inherit it.
#
# Editor is reduced to View: SLOs and alert rules are code (CLAUDE.md, "SLOs are
# code"), so nobody should be able to change the generated rules from the UI. The
# service account behind GRAFANA_AUTH gets Admin on this folder instead, which is
# what lets every project stack keep creating and deleting its own subfolder, rules
# and dashboards whether that account's org role is Editor or Admin. Org Admins keep
# full access regardless (platform security review, 2026-09-24).
resource "grafana_folder_permission" "root" {
  folder_uid = grafana_folder.root.uid

  permissions {
    role       = "Viewer"
    permission = "View"
  }
  permissions {
    role       = "Editor"
    permission = "View"
  }
  permissions {
    user_id    = var.grafana_service_account_id
    permission = "Admin"
  }
}
