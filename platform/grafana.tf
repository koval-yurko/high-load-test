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
