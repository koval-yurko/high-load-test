# The Grafana Cloud k6 project per repo project, and the limits on each.
#
# Moved here from ecs-dynamodb-rps-ceiling/grafana/k6.tf (design spec section 7.2):
# in that project's own state the project was CREATED and DESTROYED alongside the
# AWS resources, so its id rotated on every apply and K6_CLOUD_PROJECT_ID plus the
# .../a/k6-app/projects/<id> README links rotted every time. Owning it here instead
# makes the id STABLE across `/env down` + `/env up` -- the project, and its run
# history, now survive a teardown. Each repo project's own Terraform reads the id
# back with a data source rather than creating it.
#
# Named after the repo project (each.key, e.g. "ecs-dynamodb-rps"), not
# "high-load-test" -- deliberate, so a second scenario gets its own k6 project.
resource "grafana_k6_project" "project" {
  for_each = local.projects
  name     = each.key
}

# READ THIS BEFORE CHANGING vu_max_per_test. It is NOT the cap that rejects the
# load profiles. Uploading stress.js (1200 preAllocatedVUs) fails with:
#
#   (400/E2004) The Virtual User (VU) count for this test (400 VUs) exceeds the
#   maximum allowed for your project (100 VUs).
#
# ...while the project's actual vu_max_per_test is 25000, as an import of the
# previous hand-made project proved. The 100 is enforced somewhere else -- an
# organization or subscription cap, not this object -- so RAISING THIS NUMBER
# WILL NOT FIX THE UPLOAD. Find the real source before touching it.
#
# All four attributes are set explicitly and deliberately. Three of them are not
# things this project cares about, but an unset optional attribute is sent as
# null and RESETS the live value: a first draft of this file managed only
# vu_max_per_test and planned to wipe duration_max_per_test (18000),
# vu_browser_max_per_test (1000) and vuh_max_per_month (50000). The k6 Cloud REST
# API exposes no endpoint that reads limits back, so these values cannot be
# re-derived from a live project -- do not edit them blind.
#
# Auth: GRAFANA_K6_ACCESS_TOKEN and GRAFANA_STACK_ID, read from the developer's
# shell (.envrc's TF_VAR_* aliases) -- this stack runs local execution, not HCP
# workspace variables, so a local .env is what reaches this run.
resource "grafana_k6_project_limits" "project" {
  for_each   = local.projects
  project_id = grafana_k6_project.project[each.key].id

  vu_max_per_test         = var.k6_vu_max_per_test
  vu_browser_max_per_test = var.k6_vu_browser_max_per_test
  vuh_max_per_month       = var.k6_vuh_max_per_month
  duration_max_per_test   = var.k6_duration_max_per_test
}
