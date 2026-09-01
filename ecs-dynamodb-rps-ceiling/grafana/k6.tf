# Grafana Cloud k6 project limits, adopted from the live project on 2026-09-01.
#
# READ THIS BEFORE CHANGING vu_max_per_test. It is NOT the cap that rejects the
# load profiles. Uploading stress.js (1200 preAllocatedVUs) fails with:
#
#   (400/E2004) The Virtual User (VU) count for this test (400 VUs) exceeds the
#   maximum allowed for your project (100 VUs).
#
# ...while this project's actual vu_max_per_test is 25000, as the import proved.
# The 100 is enforced somewhere else -- an organization or subscription cap, not
# this object -- so RAISING THIS NUMBER WILL NOT FIX THE UPLOAD. Find the real
# source before touching it.
#
# All four attributes are set explicitly and deliberately. Three of them are not
# things this project cares about, but an unset optional attribute is sent as
# null and RESETS the live value: a first draft of this file managed only
# vu_max_per_test and planned to wipe duration_max_per_test (18000),
# vu_browser_max_per_test (1000) and vuh_max_per_month (50000). The k6 Cloud REST
# API exposes no endpoint that reads limits back, so an import is the only way to
# see what is actually set -- do not edit these blind.
#
# Auth: GRAFANA_K6_ACCESS_TOKEN and GRAFANA_STACK_ID, both workspace environment
# variables in HCP (remote execution means a local .env never reaches the run).
resource "grafana_k6_project_limits" "this" {
  project_id = var.k6_project_id

  vu_max_per_test         = var.k6_vu_max_per_test
  vu_browser_max_per_test = var.k6_vu_browser_max_per_test
  vuh_max_per_month       = var.k6_vuh_max_per_month
  duration_max_per_test   = var.k6_duration_max_per_test
}
