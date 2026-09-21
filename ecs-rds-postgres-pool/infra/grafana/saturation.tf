# Structure forked from ecs-dynamodb-rps/infra/grafana/throttles.tf on 2026-09-21.
# A bug fixed here does not reach the sibling copy; fix both.
#
# The one rule group that names the DATABASE (and, under knob 3, the proxy in
# front of it). The service-side SLO signals say that something is slow or
# failing; these say whether the cause is the database -- so a red latency panel
# is read against the thing that is actually saturated.
#
# Ported from the sibling's DynamoDB throttle rules for their STRUCTURE, not
# their metrics. Three properties of that file are load-bearing and every rule
# below keeps them:
#
#   ONE RULE PER METRIC, never a math expression across two queries. CloudWatch
#   publishes these sparsely -- a quiet minute produces no datapoint, not a zero
#   -- and a combined `$A + $B` goes NO DATA the moment either side is empty,
#   which is exactly during the incident it was meant to catch.
#
#   no_data_state = "OK". No datapoint means no load, which is healthy.
#
#   A 300s lookback against a 60s period, reduced with `last` rather than an
#   average, to absorb CloudWatch's publishing lag. (The credit rule is the one
#   exception -- see its entry below.) Because the metrics are
#   sparse, one bad minute stays the newest datapoint for up to five minutes, so
#   `for = "2m"` filters a single flapping evaluation, not a single bad minute.
#
# The CloudWatch datasource's default region is us-east-1, so every query pins
# eu-central-1 itself -- the same reason every CloudWatch panel does.
#
# WHY THE CREDIT RULE WATCHES THE SURPLUS BALANCE. RDS T-class instances run in
# unlimited credit mode, and that cannot be changed from Terraform -- the
# attribute does not exist on aws_db_instance at all. In unlimited mode an empty
# CPUCreditBalance does not throttle the CPU; the instance starts SPENDING
# surplus credits instead, and CPUSurplusCreditBalance > 0 is exactly that
# moment -- the event that disqualifies a run: the instance ran past its burst
# budget, and its CPU during that run is not the CPU of the next one. A threshold
# on CPUCreditBalance would be a number picked out of the air. And not
# CPUSurplusCreditsCharged: that only goes non-zero when spent surplus outlives
# 24h of earning, or at stop/termination, so on a lab instance destroyed daily
# it stays 0 through the very event this rule exists for.
#
# GATING THE PROXY RULES. Rules live inside the one rule-group resource, so they
# cannot each take a `count`. The rule list is built in a local that appends the
# two proxy rules only while var.proxy_enabled is true -- otherwise they would
# sit in NO DATA (read as OK) permanently against a proxy that does not exist.
locals {
  database_rules = [
    {
      name        = "Database CPU saturated"
      metric_name = "DBLoadRelativeToNumVCPUs"
      dimensions  = { DBInstanceIdentifier = var.project }
      statistic   = "Average"
      period      = "60"
      lookback    = 300
      threshold   = 1
      panel_id    = "25"
      summary     = "DBLoadRelativeToNumVCPUs has been above 1 for 2 minutes: more sessions are runnable than the instance has vCPUs. The database is the constraint -- read this before blaming the pool or the service."
    },
    {
      name        = "Connections near the ceiling"
      metric_name = "DatabaseConnections"
      dimensions  = { DBInstanceIdentifier = var.project }
      statistic   = "Maximum"
      period      = "60"
      lookback    = 300
      threshold   = var.max_connections_alert
      panel_id    = "26"
      summary     = "DatabaseConnections is above max_connections_alert. Past the instance's real ceiling a new connection gets FATAL: sorry, too many clients already, which is a 5xx that burns the availability budget."
    },
    {
      name        = "Burst credits exhausted"
      metric_name = "CPUSurplusCreditBalance"
      dimensions  = { DBInstanceIdentifier = var.project }
      statistic   = "Maximum"
      # Credit metrics publish every 5 minutes: a 300s window against period 60
      # is usually empty, and no_data_state = "OK" would silence the rule.
      period    = "300"
      lookback  = 600
      threshold = 0
      panel_id  = "27"
      summary   = "The instance is spending surplus CPU credits: it ran past its burst budget, so its CPU during this run is not the CPU of the next one. The run is not comparable -- discard it."
    },
  ]

  # No proxy panel exists on the dashboard, so these link to the dashboard
  # alone (panel_id = null drops __panelId__ below).
  proxy_rules = [
    {
      name        = "Proxy borrow latency high"
      metric_name = "DatabaseConnectionsBorrowLatency"
      dimensions  = { ProxyName = var.project }
      statistic   = "Average"
      period      = "60"
      lookback    = 300
      threshold   = var.proxy_borrow_latency_threshold
      panel_id    = null
      summary     = "RDS Proxy borrow latency is above proxy_borrow_latency_threshold: requests are waiting on the proxy for a backend connection."
    },
    {
      name        = "Proxy sessions pinned"
      metric_name = "DatabaseConnectionsCurrentlySessionPinned"
      dimensions  = { ProxyName = var.project }
      statistic   = "Maximum"
      period      = "60"
      lookback    = 300
      threshold   = 0
      panel_id    = null
      summary     = "RDS Proxy has pinned sessions. A proxy with everything pinned is a passthrough measuring nothing -- the knob 3 run is not measuring multiplexing."
    },
  ]

  saturation_rules = concat(local.database_rules, var.proxy_enabled ? local.proxy_rules : [])
}

resource "grafana_rule_group" "saturation" {
  name             = "${var.project} / database saturation"
  folder_uid       = grafana_folder.project.uid
  interval_seconds = 60

  dynamic "rule" {
    for_each = local.saturation_rules
    content {
      name      = rule.value.name
      condition = "C"
      for       = "2m"

      data {
        ref_id         = "A"
        datasource_uid = var.cloudwatch_datasource_uid
        relative_time_range {
          from = rule.value.lookback
          to   = 0
        }
        model = jsonencode({
          refId            = "A"
          region           = "eu-central-1"
          namespace        = "AWS/RDS"
          metricName       = rule.value.metric_name
          statistic        = rule.value.statistic
          period           = rule.value.period
          dimensions       = rule.value.dimensions
          metricQueryType  = 0
          metricEditorMode = 0
          matchExact       = true
        })
      }

      # A -> B -> C, not A -> C. Grafana will not apply a threshold straight to
      # a time series; `last` takes the newest published minute in the window.
      data {
        ref_id         = "B"
        datasource_uid = "__expr__"
        query_type     = "reduce"
        relative_time_range {
          from = rule.value.lookback
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
          from = rule.value.lookback
          to   = 0
        }
        model = jsonencode({
          refId      = "C"
          type       = "threshold"
          expression = "B"
          conditions = [{ evaluator = { type = "gt", params = [rule.value.threshold] } }]
        })
      }

      no_data_state  = "OK"
      exec_err_state = "Error"

      notification_settings {
        contact_point = var.alert_contact_point
        group_by      = ["alertname", "slo"]
      }

      annotations = merge(
        {
          summary          = rule.value.summary
          __dashboardUid__ = grafana_dashboard.attribution.uid
        },
        rule.value.panel_id == null ? {} : { __panelId__ = rule.value.panel_id },
      )
      labels = {
        severity = "ticket"
        slo      = "database"
      }
    }
  }

  lifecycle {
    precondition {
      condition     = !var.proxy_enabled || var.proxy_borrow_latency_threshold != null
      error_message = "proxy_enabled is true but proxy_borrow_latency_threshold is unset. Confirm the unit of DatabaseConnectionsBorrowLatency in the CloudWatch console on the real proxy first -- a 1000x unit error is silent and looks like a spectacular result."
    }
  }
}
