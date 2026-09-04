# The one rule group that names the DATABASE.
#
# Every alert this project had before this file read the same service-side
# signal: the six burn rules in alerts.tf are ratios over
# http_server_request_duration_seconds, and the canary in canary.tf fires on the
# absence of it. So the database SLI -- the thing CLAUDE.md calls first-class for
# a DynamoDB project -- had no alert of its own, and a throttling table announces
# itself only as latency and 5xx: every service-side signal goes red at once, for
# a cause that is not the service. This is what says which.
#
# It reads CloudWatch LIVE rather than the forwarded Prometheus copy. Alloy no
# longer forwards throttle events at all (its DynamoDB block was trimmed to
# SuccessfulRequestLatency), and reading the source removes the collector task
# from the path between "DynamoDB rejected a request" and "someone is told".
#
# TWO RULES, ONE PER METRIC -- and this is the load-bearing part of the file.
# The obvious shape is one rule that alerts on ReadThrottleEvents +
# WriteThrottleEvents, and it is SILENT in exactly the case this exists for.
# CloudWatch publishes these two metrics SPARSELY: a minute with no throttling
# produces no datapoint at all, not a zero. (The zeros that showed up in
# Prometheus were the Alloy exporter filling gaps, not CloudWatch.) Grafana's
# math expression returns NO DATA when either side has no series, so under
# read-only throttling -- measured 2026-09-01 as 5588 read events/min against 0
# write -- the write query is empty, `$A + $B` is empty, no_data_state = "OK"
# swallows it, and nobody is told while the table is refusing a third of the
# load. There is no math across queries anywhere below for that reason; each
# metric gets its own A -> B -> C chain, and each side can fire alone.
#
# Read and write are also different problems -- reads bind near 24 rps on this
# table's capacity model and writes not until ~125 rps -- so two alerts carry more
# information than one anyway. The dashboard's panel 2 plots them as two lines
# for the same reason.
#
# ReadThrottleEvents/WriteThrottleEvents, not ThrottledRequests: ThrottledRequests
# is published only with a TableName+Operation dimension pair and reads 0 at
# instants during sustained throttling -- measured the same day as
# "... 4156, 0, 4153 ..." while the table was rejecting 5588 reads/minute. The two
# event series are published at table level.
#
# The CloudWatch datasource's default region is us-east-1, so every model pins
# eu-central-1 itself -- the same reason every CloudWatch panel does.
#
# WHAT THE TIMING ACTUALLY MEANS. The 300s relative_time_range is a five-minute
# lookback that absorbs CloudWatch's ~2-minute publishing lag -- the same
# reasoning as `length = "300s"` on Alloy's cloudwatch exporter, where a 60s
# window returned empty recent periods that looked like an outage. Because the
# metric is sparse, ONE throttled minute stays the newest datapoint the reduce
# can see for up to five minutes, so a single throttled minute will hold this
# rule pending and then firing for that long. `for = "2m"` therefore does NOT
# mean "two consecutive minutes of throttling" and does not filter out a single
# throttled request -- it filters a single flapping evaluation, and nothing more.
resource "grafana_rule_group" "dynamodb_throttles" {
  name             = "${var.project} / DynamoDB throttling"
  folder_uid       = grafana_folder.project.uid
  interval_seconds = 60

  rule {
    name      = "DynamoDB read throttling"
    condition = "C"
    for       = "2m"

    data {
      ref_id         = "A"
      datasource_uid = var.cloudwatch_datasource_uid
      relative_time_range {
        from = 300
        to   = 0
      }
      model = jsonencode({
        refId            = "A"
        region           = "eu-central-1"
        namespace        = "AWS/DynamoDB"
        metricName       = "ReadThrottleEvents"
        statistic        = "Sum"
        period           = "60"
        dimensions       = { TableName = var.project }
        metricQueryType  = 0
        metricEditorMode = 0
        matchExact       = true
      })
    }

    # A -> B -> C, not A -> C. Grafana's expression pipeline will not apply a
    # threshold straight to a query result -- "looks like time series data, only
    # reduced data can be alerted on" -- and the CloudWatch query returns a
    # series. `last` takes the newest published minute inside the window.
    data {
      ref_id         = "B"
      datasource_uid = "__expr__"
      query_type     = "reduce"
      relative_time_range {
        from = 300
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
        from = 300
        to   = 0
      }
      model = jsonencode({
        refId      = "C"
        type       = "threshold"
        expression = "B"
        conditions = [{ evaluator = { type = "gt", params = [0] } }]
      })
    }

    # No datapoint is not the same as throttling: a table that is not throttling
    # publishes nothing at all, and that is the healthy case. The canary rule in
    # canary.tf is what catches a blind pipeline.
    no_data_state  = "OK"
    exec_err_state = "Error"

    notification_settings {
      contact_point = var.alert_contact_point
      group_by      = ["alertname", "slo"]
    }

    annotations = {
      summary          = "DynamoDB rejected read requests for 2 minutes; every service-side signal is red for a database-side cause until this clears — read this before the latency panels."
      runbook_url      = "https://github.com/koval-yurko/high-load-test/blob/master/ecs-dynamodb-rps/README.md#6-is-it-about-to-break"
      __dashboardUid__ = grafana_dashboard.attribution.uid
      __panelId__      = "2"
    }
    labels = {
      severity = "ticket"
      slo      = "database"
    }
  }

  # The write side, separately. Reads throttle first at this project's request
  # mix, so this one firing while the read rule stays quiet is about write
  # capacity specifically, not the table as a whole.
  rule {
    name      = "DynamoDB write throttling"
    condition = "C"
    for       = "2m"

    data {
      ref_id         = "A"
      datasource_uid = var.cloudwatch_datasource_uid
      relative_time_range {
        from = 300
        to   = 0
      }
      model = jsonencode({
        refId            = "A"
        region           = "eu-central-1"
        namespace        = "AWS/DynamoDB"
        metricName       = "WriteThrottleEvents"
        statistic        = "Sum"
        period           = "60"
        dimensions       = { TableName = var.project }
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
        from = 300
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
        from = 300
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
      summary          = "DynamoDB rejected write requests for 2 minutes; every service-side signal is red for a database-side cause until this clears — read this before the latency panels."
      runbook_url      = "https://github.com/koval-yurko/high-load-test/blob/master/ecs-dynamodb-rps/README.md#6-is-it-about-to-break"
      __dashboardUid__ = grafana_dashboard.attribution.uid
      __panelId__      = "2"
    }
    labels = {
      severity = "ticket"
      slo      = "database"
    }
  }
}
