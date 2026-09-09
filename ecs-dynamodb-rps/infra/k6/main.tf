# The Grafana Cloud k6 project for this scenario is CREATED IN platform/, not
# here, and it survives /env down. That is the whole point of this module being a
# lookup: the project's numeric id used to change on every apply, and two things
# had to be chased after each one with nothing warning when they weren't --
# K6_CLOUD_PROJECT_ID in the root .env, and the .../a/k6-app/projects/<id> links
# in the project README. A stable id makes both a one-time setting.
#
# grafana_k6_projects (plural) is the only lookup BY NAME the provider offers;
# grafana_k6_project (singular) takes an id, which is exactly the value this
# module exists to avoid hardcoding. Verified against grafana/grafana 3.25.9:
# `name` is the optional filter, `projects` is a computed list of objects each
# carrying id, name, grafana_folder_uid, is_default, created, updated.
#
# If platform/ has not been applied there is no project by this name, the list is
# empty, and the PLAN FAILS at the k6_project_id output in outputs.tf: one() of an
# empty list is null, and reading .id off it raises "Attempt to get attribute from
# null value" (checked in `terraform console`). That failure is the guard, not a
# bug -- an empty id would otherwise be written into K6_CLOUD_PROJECT_ID and every
# `k6 cloud run` would upload into nothing. The fix when it fires is to apply the
# platform stack first:
#
#   terraform -chdir=platform apply
#
# one() also errors if more than one project carries this name, which is the other
# thing worth failing on.
#
# The three load profiles in tests/ are NOT managed here (grafana_k6_load_test takes
# a single script string, and all three import from tests/lib/, so managing them as
# code needs a bundler first). They are uploaded by ../../scripts/upload-k6.sh,
# which also bakes BASE_URL and RATE into each archive with -e -- the k6 app's own
# settings page has no provider resource and no API at all, so that page is a
# fallback that must merely not contradict the upload.
#
# Auth: GRAFANA_K6_ACCESS_TOKEN and GRAFANA_STACK_ID, both delivered by the
# workspace variable set platform/ manages (remote execution means a local .env
# never reaches the run).
data "grafana_k6_projects" "this" {
  name = var.project
}
