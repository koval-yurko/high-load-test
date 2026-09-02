# The Grafana Cloud k6 project for this scenario, and the limits on it.
#
# The project is CREATED here, never imported, so Grafana Cloud assigns a new
# numeric id on every apply and `terraform destroy` takes the project down with
# the AWS resources. Two things must follow that id after each apply, and
# nothing warns when they don't:
#   - K6_CLOUD_PROJECT_ID in the root .env, or `k6 cloud run` uploads into a
#     project that no longer exists;
#   - the .../a/k6-app/projects/<id> links in the project README.
# Read it with: terraform -chdir=terraform output -raw k6_project_id
#
# The three load tests stay uploaded BY HAND. grafana_k6_load_test exists in this
# provider but takes a single script string, and k6/{discovery,constant,stress}.js
# all import from k6/lib/, so managing them as code needs a bundler first. A fresh
# project is therefore empty: re-upload the scripts and set BASE_URL / RATE on the
# settings page, which has no provider resource at all.
#
# Full reasoning: docs/k6-project-as-code.md
resource "grafana_k6_project" "this" {
  name = "high-load-test"
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
# Auth: GRAFANA_K6_ACCESS_TOKEN and GRAFANA_STACK_ID, both workspace environment
# variables in HCP (remote execution means a local .env never reaches the run).
resource "grafana_k6_project_limits" "this" {
  project_id = grafana_k6_project.this.id

  vu_max_per_test         = var.k6_vu_max_per_test
  vu_browser_max_per_test = var.k6_vu_browser_max_per_test
  vuh_max_per_month       = var.k6_vuh_max_per_month
  duration_max_per_test   = var.k6_duration_max_per_test
}
