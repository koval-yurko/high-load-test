# Structure forked from ecs-rds-postgres-pool/infra/grafana/saturation.tf on 2026-11-09.
# A bug fixed here does not reach the sibling copy; fix both.
#
# One rule per metric, never math across two queries: CloudWatch publishes sparsely, and $A + $B
# goes NO DATA when one side is empty. no_data_state = "OK": no datapoint means no load.
# A -> reduce -> threshold, because Grafana will not threshold a time series directly.
#
# Availability burn: API Gateway 5XXError Average IS the 5xx fraction (each request is 0 or 1), so
# one metric gives the burn. There is no latency burn rule: no per-request latency exists outside
# k6, which is the only SLI (spec decision 5).
locals {
  # Grafana rejects __dashboardUid__ without __panelId__, and only at apply time (plan cannot see it).
  # Keep both keys in this one map. Panel id 2 is "4xx and 5xx" (id = list index + 1 in dashboard.tf).
  dashboard_link = {
    __dashboardUid__ = grafana_dashboard.main.uid
    __panelId__      = "2"
  }

  budget = 1 - local.slo.availability_objective

  burn_rules = [for k, b in local.slo.burn : {
    name      = "Availability ${k} burn"
    ns        = "AWS/ApiGateway"
    metric    = "5XXError"
    dims      = tomap({ ApiName = var.api_name, Stage = var.stage_name })
    stat      = "Average"
    period    = tostring(b.window_seconds)
    from      = b.window_seconds + 300
    to        = 300 # one full window ending 5 min ago, past CloudWatch's publishing delay
    reducer   = "last"
    threshold = b.factor * local.budget
    for       = k == "fast" ? "2m" : "15m"
    summary   = "The 5xx fraction over ${b.window_seconds / 3600} h is above ${b.factor} x the ${format("%.1f", local.budget * 100)}% budget. A Lambda throttle reaches the client as 500, so read the Throttles panel first."
  }]

  base_rules = [
    {
      name    = "Lambda throttles", ns = "AWS/Lambda", metric = "Throttles", dims = tomap({ FunctionName = var.function_name })
      stat    = "Sum", period = "60", from = 300, to = 0, reducer = "last", threshold = 0, for = "2m"
      summary = "Throttles > 0: the function hit its reserved concurrency. Expected in knob runs past the Erlang B rate; anywhere else it is a finding."
    },
    {
      name    = "Shared pool in danger", ns = "AWS/Lambda", metric = "UnreservedConcurrentExecutions", dims = tomap({})
      stat    = "Maximum", period = "60", from = 300, to = 0, reducer = "last", threshold = var.unreserved_alert, for = "2m"
      summary = "The account's unreserved concurrency in use is above ${var.unreserved_alert} of 352. The metric is account-wide, so other apps can push it up. Check whether a load test of this project is running; if so, stop it and check reserved_concurrency; if not, another app is using the pool."
    },
    {
      name    = "DynamoDB read throttles", ns = "AWS/DynamoDB", metric = "ReadThrottleEvents", dims = tomap({ TableName = var.table_name })
      stat    = "Sum", period = "60", from = 300, to = 0, reducer = "last", threshold = 0, for = "2m"
      summary = "The table throttled reads: the database binds, not concurrency, so a knob run made now is invalid. SDK retries first show as longer Duration."
    },
  ]

  # Data 2 h ago AND the knob still set = provisioned concurrency has been billed for 2 h.
  pc_rules = var.provisioned_concurrency > 0 ? [{
    name    = "Provisioned concurrency left on", ns = "AWS/Lambda", metric = "ProvisionedConcurrencyUtilization"
    dims    = tomap({ FunctionName = var.function_name, Resource = "${var.function_name}:${var.alias_name}" })
    stat    = "Maximum", period = "60", from = 7500, to = 7200, reducer = "count", threshold = 0, for = "0s"
    summary = "Fires when the alias had provisioned-concurrency utilisation data 2 hours ago and the knob is still set (billed per hour). Idle provisioned concurrency with no traffic does not publish the metric, so this rule cannot see it; the README teardown is the backstop. Set provisioned_concurrency = 0 in dev.tfvars and apply."
  }] : []

  rules = concat(local.burn_rules, local.base_rules, local.pc_rules)
}

resource "grafana_rule_group" "main" {
  name             = "${var.project} / concurrency and capacity"
  folder_uid       = grafana_folder.project.uid
  interval_seconds = 60

  dynamic "rule" {
    for_each = local.rules
    content {
      name      = rule.value.name
      condition = "C"
      for       = rule.value.for

      data {
        ref_id         = "A"
        datasource_uid = var.cloudwatch_datasource_uid
        relative_time_range {
          from = rule.value.from
          to   = rule.value.to
        }
        model = jsonencode({
          refId            = "A"
          region           = local.region
          namespace        = rule.value.ns
          metricName       = rule.value.metric
          statistic        = rule.value.stat
          period           = rule.value.period
          dimensions       = rule.value.dims
          metricQueryType  = 0
          metricEditorMode = 0
          matchExact       = true
        })
      }

      data {
        ref_id         = "B"
        datasource_uid = "__expr__"
        query_type     = "reduce"
        relative_time_range {
          from = rule.value.from
          to   = rule.value.to
        }
        model = jsonencode({ refId = "B", type = "reduce", reducer = rule.value.reducer, expression = "A" })
      }

      data {
        ref_id         = "C"
        datasource_uid = "__expr__"
        query_type     = "threshold"
        relative_time_range {
          from = rule.value.from
          to   = rule.value.to
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
        group_by      = ["alertname"]
      }

      annotations = merge({ summary = rule.value.summary }, local.dashboard_link)
      labels = {
        severity = "ticket"
        project  = var.project
      }
    }
  }
}
