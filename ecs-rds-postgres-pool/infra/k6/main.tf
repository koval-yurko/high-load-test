# Forked from ecs-dynamodb-rps/infra/k6/main.tf on 2026-09-21.
# A bug fixed here does not reach the sibling copy; fix both.
# The Grafana Cloud k6 project for this scenario, CREATED HERE and destroyed with
# the environment by /env down. Named after the repo project (var.project), so a
# second scenario gets its own k6 project and its own id.
#
# It lived in platform/ from 2026-09-03 to 2026-09-14 so that its numeric id stayed
# stable across teardowns. That stability was only ever needed because the id was
# COPIED -- into K6_CLOUD_PROJECT_ID in the root .env and into README links -- and
# nothing updated the copies. The copies are gone: every reader asks
# `terraform output -json` for k6_project_id at the moment of use, so a new id per
# apply costs nothing. Full reasoning:
# docs/superpowers/specs/2026-09-14-ecs-dynamodb-rps-k6-project-ownership-design.md
#
# What IS lost on every teardown: the load tests uploaded into the project and its
# cloud run history. Accepted -- results.md is the record, and /loadtest --compare
# reads it rather than the cloud. After every /env up, re-upload the profiles:
#
#   ./scripts/upload-k6.sh
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
# never reaches the run). Before this resource moved here those two variables only
# fed a read; they are now what creates and deletes a project.
resource "grafana_k6_project" "this" {
  name = var.project
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
# COMMIT THIS FILE BEFORE ANY APPLY FROM A WORKTREE. On 2026-09-01 a task sent
# vuh_max_per_month from 50000 to null without the resource appearing in its plan:
# the HCP workspace is shared between the main checkout and every worktree, the k6
# file was untracked in the worktree that ran, and the configuration that run
# uploaded did not contain this resource at all. A remote run applies whatever
# directory it was handed, so the defence is the commit, not vigilance.
resource "grafana_k6_project_limits" "this" {
  project_id = grafana_k6_project.this.id

  vu_max_per_test         = var.vu_max_per_test
  vu_browser_max_per_test = var.vu_browser_max_per_test
  vuh_max_per_month       = var.vuh_max_per_month
  duration_max_per_test   = var.duration_max_per_test
}
