# Forked from ecs-dynamodb-rps/infra/grafana/canary.tf on 2026-09-21.
# A bug fixed here does not reach the sibling copy; fix both.
#
# The one rule that fires on SILENCE.
#
# Every burn rule in alerts.tf sets no_data_state = "OK", which is right for a
# burn rule: no traffic is not a burn. But the SLI's existence depends on the
# heartbeat Lambda, the service's OTLP export, the Alloy collector and Grafana
# Cloud ingest. If any of them stops, all the burn rules go quiet and the
# dashboard goes flat -- and both read as healthy. heartbeat_enabled = false
# produces the same picture on purpose. This rule is what separates "quiet"
# from "blind".
#
# absent_over_time returns 1 when the selector matched NOTHING in the window and
# an empty result otherwise, so no_data_state = "OK" is correct here too: no
# data from this query means the SLI series exists. Ten minutes is ten heartbeats,
# so one slow beat cannot trip it. Silence this rule deliberately (a mute timing)
# when the heartbeat is turned off; do not delete it.
#
# An empty panel and a healthy system look identical, and this project's entire
# deliverable is a before/after table read off these panels. A run that produced
# no data, mistaken for a run that produced good numbers, is the worst outcome
# available -- worse than a failed run, which at least announces itself.
resource "grafana_rule_group" "sli_absent" {
  name             = "${var.project} / SLI absent"
  folder_uid       = grafana_folder.project.uid
  interval_seconds = 60

  rule {
    name      = "no SLI samples for 10m"
    condition = "C"
    for       = "0s"

    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      query_type     = "instant"
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId   = "A"
        instant = true
        range   = false
        expr    = "absent_over_time(http_server_request_duration_seconds{job=\"${var.project}\", class=~\"fast|standard|heavy\"}[10m])"
      })
    }

    data {
      ref_id         = "B"
      datasource_uid = "__expr__"
      query_type     = "reduce"
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId      = "B"
        type       = "reduce"
        reducer    = "last"
        expression = "A"
      })
    }

    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      query_type     = "threshold"
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId      = "C"
        type       = "threshold"
        expression = "B"
        conditions = [{ evaluator = { type = "gt", params = [0] } }]
      })
    }

    no_data_state  = "OK"
    exec_err_state = "Error"

    notification_settings {
      contact_point = var.alert_contact_point
      group_by      = ["alertname", "slo"]
    }

    annotations = {
      summary = "No SLI samples for 10 minutes. The heartbeat, the app's OTLP export, the collector task or Grafana Cloud ingest has stopped; the burn-rate rules are blind until this clears."
    }
    labels = {
      severity = "ticket"
      slo      = "pipeline"
    }
  }
}
