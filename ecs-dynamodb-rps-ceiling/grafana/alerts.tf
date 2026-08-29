# GENERATED from slo.yaml by /slo. Do not edit by hand.
#
# Alerts on error-budget BURN RATE, not the raw SLI — a latency alert that fires on every
# momentary spike gets muted within a week and then protects nothing. Two windows per SLO,
# each derived from its objective's sustainable failure rate (1 - objective):
#   fast burn — budget consumed ~14.4x the sustainable rate, sustained 1h -> page
#   slow burn — budget consumed ~6x   the sustainable rate, sustained 6h -> ticket
#
# slo.yaml SLOs and their sustainable failure rates:
#   latency-classes  primary objective 99.0%  -> sustainable miss rate 1.000% (0.01)
#   latency-classes  tail    objective 99.9%  -> sustainable miss rate 0.100% (0.001)
#   availability             objective 99.9%  -> sustainable error rate 0.100% (0.001)
#
# ---------------------------------------------------------------------------------------------
# PRECONDITION — these rules cannot fire against a `k6 cloud run`. Read before relying on them.
# ---------------------------------------------------------------------------------------------
#
# Every query below reads `slo_met`, `slo_met_tail`, and `http_req_failed` from the Prometheus/
# Mimir datasource `var.k6_prometheus_datasource_uid`. Those series only exist there if a k6 run
# was started with `-o experimental-prometheus-rw` (the `K6_PROMETHEUS_RW_*` variables in the
# root `.env` configure that output) — that is, a LOCAL `k6 run`. `k6 cloud run` sends results to
# the Grafana Cloud k6 app instead, never to Prometheus, so a cloud run produces no data these
# rules can see and they will sit in `no_data_state = "OK"` for the whole run, silently.
#
# `/loadtest` and `/env` do not currently invoke `-o experimental-prometheus-rw` for local runs
# either — wiring cloud-run metrics (or local-run remote-write) into this datasource so these
# rules actually fire is UNRESOLVED. Do not assume attainment because no alert fired.
#
# Label selector: every query below is scoped with `{project="ecs-dynamodb-rps-ceiling"}` so it
# does not aggregate other tests sharing this Grafana Cloud stack. That label is NOT emitted by
# the k6 scripts (they are frozen — see CLAUDE.md/the project plan — and carry only `class`/
# `kind` tags). It must be added at invocation time, without editing the scripts, via:
#   k6 run -o experimental-prometheus-rw --tag project=ecs-dynamodb-rps-ceiling k6/<profile>.js
# Omitting `--tag project=...` on the run makes every query below match zero series (not other
# projects' data) — fail-closed, not silent cross-contamination, but still worth getting right.

variable "grafana_folder_uid" {
  description = "Folder UID the ecs-dynamodb-rps-ceiling alert rules live in."
  type        = string
}

variable "k6_prometheus_datasource_uid" {
  description = "UID of the Grafana Cloud Prometheus/Mimir datasource k6 test-run metrics are remote-written to."
  type        = string
}

# ---------------------------------------------------------------------------
# latency-classes: PRIMARY (objective 99.0%, sustainable miss rate 1.000%)
# ---------------------------------------------------------------------------

resource "grafana_rule_group" "latency_classes_primary_fastburn" {
  name             = "ecs-dynamodb-rps-ceiling / latency-classes primary / fast burn"
  folder_uid       = var.grafana_folder_uid
  interval_seconds = 60

  rule {
    name      = "latency-classes primary burn rate >= 14.4x over 1h"
    condition = "C"
    for       = "5m"

    data {
      ref_id         = "A"
      datasource_uid = var.k6_prometheus_datasource_uid
      query_type     = "instant"
      relative_time_range {
        from = 3600
        to   = 0
      }
      # miss rate = 1 - slo_met, averaged over the last hour
      model = jsonencode({
        expr = "1 - avg_over_time(slo_met{project=\"ecs-dynamodb-rps-ceiling\"}[1h])"
      })
    }

    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      query_type     = "threshold"
      relative_time_range {
        from = 3600
        to   = 0
      }
      # 14.4 * sustainable(1.0%) = 14.40% sustained for 1h
      model = jsonencode({
        type       = "threshold"
        expression = "A"
        conditions = [{ evaluator = { type = "gt", params = [0.144] } }]
      })
    }

    no_data_state  = "OK"
    exec_err_state = "Error"

    annotations = {
      summary     = "latency-classes primary (99.0% objective) burning error budget ~14.4x sustainable over 1h."
      computation = "sustainable miss rate = 1 - 0.990 = 1.000%; fast-burn threshold = 14.4 * 1.000% = 14.40%"
    }
    labels = {
      severity = "page"
      slo      = "latency-classes-primary"
    }
  }
}

resource "grafana_rule_group" "latency_classes_primary_slowburn" {
  name             = "ecs-dynamodb-rps-ceiling / latency-classes primary / slow burn"
  folder_uid       = var.grafana_folder_uid
  interval_seconds = 60

  rule {
    name      = "latency-classes primary burn rate >= 6x over 6h"
    condition = "C"
    for       = "30m"

    data {
      ref_id         = "A"
      datasource_uid = var.k6_prometheus_datasource_uid
      query_type     = "instant"
      relative_time_range {
        from = 21600
        to   = 0
      }
      model = jsonencode({
        expr = "1 - avg_over_time(slo_met{project=\"ecs-dynamodb-rps-ceiling\"}[6h])"
      })
    }

    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      query_type     = "threshold"
      relative_time_range {
        from = 21600
        to   = 0
      }
      # 6 * sustainable(1.0%) = 6.00% sustained for 6h
      model = jsonencode({
        type       = "threshold"
        expression = "A"
        conditions = [{ evaluator = { type = "gt", params = [0.06] } }]
      })
    }

    no_data_state  = "OK"
    exec_err_state = "Error"

    annotations = {
      summary     = "latency-classes primary (99.0% objective) burning error budget ~6x sustainable over 6h."
      computation = "sustainable miss rate = 1 - 0.990 = 1.000%; slow-burn threshold = 6 * 1.000% = 6.00%"
    }
    labels = {
      severity = "ticket"
      slo      = "latency-classes-primary"
    }
  }
}

# ---------------------------------------------------------------------------
# latency-classes: TAIL (objective 99.9%, sustainable miss rate 0.100%)
# ---------------------------------------------------------------------------

resource "grafana_rule_group" "latency_classes_tail_fastburn" {
  name             = "ecs-dynamodb-rps-ceiling / latency-classes tail / fast burn"
  folder_uid       = var.grafana_folder_uid
  interval_seconds = 60

  rule {
    name      = "latency-classes tail burn rate >= 14.4x over 1h"
    condition = "C"
    for       = "5m"

    data {
      ref_id         = "A"
      datasource_uid = var.k6_prometheus_datasource_uid
      query_type     = "instant"
      relative_time_range {
        from = 3600
        to   = 0
      }
      model = jsonencode({
        expr = "1 - avg_over_time(slo_met_tail{project=\"ecs-dynamodb-rps-ceiling\"}[1h])"
      })
    }

    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      query_type     = "threshold"
      relative_time_range {
        from = 3600
        to   = 0
      }
      # 14.4 * sustainable(0.100%) = 1.44% sustained for 1h
      model = jsonencode({
        type       = "threshold"
        expression = "A"
        conditions = [{ evaluator = { type = "gt", params = [0.0144] } }]
      })
    }

    no_data_state  = "OK"
    exec_err_state = "Error"

    annotations = {
      summary     = "latency-classes tail (99.9% objective) burning error budget ~14.4x sustainable over 1h."
      computation = "sustainable miss rate = 1 - 0.999 = 0.100%; fast-burn threshold = 14.4 * 0.100% = 1.44%"
    }
    labels = {
      severity = "page"
      slo      = "latency-classes-tail"
    }
  }
}

resource "grafana_rule_group" "latency_classes_tail_slowburn" {
  name             = "ecs-dynamodb-rps-ceiling / latency-classes tail / slow burn"
  folder_uid       = var.grafana_folder_uid
  interval_seconds = 60

  rule {
    name      = "latency-classes tail burn rate >= 6x over 6h"
    condition = "C"
    for       = "30m"

    data {
      ref_id         = "A"
      datasource_uid = var.k6_prometheus_datasource_uid
      query_type     = "instant"
      relative_time_range {
        from = 21600
        to   = 0
      }
      model = jsonencode({
        expr = "1 - avg_over_time(slo_met_tail{project=\"ecs-dynamodb-rps-ceiling\"}[6h])"
      })
    }

    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      query_type     = "threshold"
      relative_time_range {
        from = 21600
        to   = 0
      }
      # 6 * sustainable(0.100%) = 0.60% sustained for 6h
      model = jsonencode({
        type       = "threshold"
        expression = "A"
        conditions = [{ evaluator = { type = "gt", params = [0.006] } }]
      })
    }

    no_data_state  = "OK"
    exec_err_state = "Error"

    annotations = {
      summary     = "latency-classes tail (99.9% objective) burning error budget ~6x sustainable over 6h."
      computation = "sustainable miss rate = 1 - 0.999 = 0.100%; slow-burn threshold = 6 * 0.100% = 0.60%"
    }
    labels = {
      severity = "ticket"
      slo      = "latency-classes-tail"
    }
  }
}

# ---------------------------------------------------------------------------
# availability (objective 99.9%, sustainable error rate 0.100%)
# ---------------------------------------------------------------------------

resource "grafana_rule_group" "availability_fastburn" {
  name             = "ecs-dynamodb-rps-ceiling / availability / fast burn"
  folder_uid       = var.grafana_folder_uid
  interval_seconds = 60

  rule {
    name      = "availability burn rate >= 14.4x over 1h"
    condition = "C"
    for       = "5m"

    data {
      ref_id         = "A"
      datasource_uid = var.k6_prometheus_datasource_uid
      query_type     = "instant"
      relative_time_range {
        from = 3600
        to   = 0
      }
      # http_req_failed already counts failures directly
      model = jsonencode({
        expr = "avg_over_time(http_req_failed{project=\"ecs-dynamodb-rps-ceiling\"}[1h])"
      })
    }

    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      query_type     = "threshold"
      relative_time_range {
        from = 3600
        to   = 0
      }
      # 14.4 * sustainable(0.100%) = 1.44% sustained for 1h
      model = jsonencode({
        type       = "threshold"
        expression = "A"
        conditions = [{ evaluator = { type = "gt", params = [0.0144] } }]
      })
    }

    no_data_state  = "OK"
    exec_err_state = "Error"

    annotations = {
      summary     = "availability (99.9% objective) burning error budget ~14.4x sustainable over 1h."
      computation = "sustainable error rate = 1 - 0.999 = 0.100%; fast-burn threshold = 14.4 * 0.100% = 1.44%"
    }
    labels = {
      severity = "page"
      slo      = "availability"
    }
  }
}

resource "grafana_rule_group" "availability_slowburn" {
  name             = "ecs-dynamodb-rps-ceiling / availability / slow burn"
  folder_uid       = var.grafana_folder_uid
  interval_seconds = 60

  rule {
    name      = "availability burn rate >= 6x over 6h"
    condition = "C"
    for       = "30m"

    data {
      ref_id         = "A"
      datasource_uid = var.k6_prometheus_datasource_uid
      query_type     = "instant"
      relative_time_range {
        from = 21600
        to   = 0
      }
      model = jsonencode({
        expr = "avg_over_time(http_req_failed{project=\"ecs-dynamodb-rps-ceiling\"}[6h])"
      })
    }

    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      query_type     = "threshold"
      relative_time_range {
        from = 21600
        to   = 0
      }
      # 6 * sustainable(0.100%) = 0.60% sustained for 6h
      model = jsonencode({
        type       = "threshold"
        expression = "A"
        conditions = [{ evaluator = { type = "gt", params = [0.006] } }]
      })
    }

    no_data_state  = "OK"
    exec_err_state = "Error"

    annotations = {
      summary     = "availability (99.9% objective) burning error budget ~6x sustainable over 6h."
      computation = "sustainable error rate = 1 - 0.999 = 0.100%; slow-burn threshold = 6 * 0.100% = 0.60%"
    }
    labels = {
      severity = "ticket"
      slo      = "availability"
    }
  }
}
