# GENERATED from slo.yaml by /slo. Do not edit by hand.
#
# Burn-rate alerting on error budget, not the raw SLI. Both the multipliers and
# the ALERT WINDOWS are derived from slo.yaml's window (7d): the
# familiar 14.4x/1h and 6x/6h encode "2% and 5% of budget" on a 30-day window,
# and against 7d the windows must scale or the same rules silently
# mean something else. Each rule's `computation` annotation shows its own
# arithmetic.
#
# Three objectives, two speeds each: latency-classes primary and tail (the
# per-class threshold ratio, a 5xx counted as a miss), and availability (non-5xx
# over all). The SLI is emitted by the service continuously -- these rules do
# not depend on a k6 run having happened.

resource "grafana_rule_group" "latency_classes_primary_fastburn" {
  name             = "ecs-dynamodb-rps / latency-classes primary / fast burn"
  folder_uid       = grafana_folder.project.uid
  interval_seconds = 60

  rule {
    name      = "latency-classes primary burn rate >= 14.4x over 14m"
    condition = "C"
    for       = "70s"

    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      query_type     = "instant"
      relative_time_range {
        from = 840
        to   = 0
      }
      model = jsonencode({
        // refId is echoed back inside the model by Grafana's API. Omitting it
        // makes every subsequent plan propose removing it -- a perpetual diff
        // that trains a reviewer to skim the one place they must not skim.
        refId = "A"
        // instant, not range. query_type on the data block is NOT this flag: the
        // Prometheus datasource reads these booleans from the model, and without
        // them the rule evaluates over a range and returns a series, which the
        // threshold cannot reduce -- "looks like time series data, only reduced
        // data can be alerted on". Burn rate is already a rate over the window,
        // so one sample at evaluation time is the whole answer.
        instant = true
        range   = false
        expr    = <<-PROMQL
          1 - (
            (
              (histogram_fraction(0, 0.05, sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="fast", http_response_status_code!~"5.."}[14m]))) * histogram_count(sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="fast", http_response_status_code!~"5.."}[14m]))) or vector(0))
            +
              (histogram_fraction(0, 0.2, sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="standard", http_response_status_code!~"5.."}[14m]))) * histogram_count(sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="standard", http_response_status_code!~"5.."}[14m]))) or vector(0))
            +
              (histogram_fraction(0, 0.8, sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="heavy", http_response_status_code!~"5.."}[14m]))) * histogram_count(sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="heavy", http_response_status_code!~"5.."}[14m]))) or vector(0))
            )
            /
            histogram_count(sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy"}[14m])))
          )
        PROMQL
      })
    }

    // A -> B -> C, not A -> C. Grafana's expression pipeline will not apply a
    // threshold straight to a query: even an instant query arrives as a series,
    // and the rule fails with "looks like time series data, only reduced data
    // can be alerted on". The reducer is 'last' because A is already an instant
    // query -- there is exactly one sample to take.
    data {
      ref_id         = "B"
      datasource_uid = "__expr__"
      query_type     = "reduce"
      relative_time_range {
        from = 840
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
        from = 840
        to   = 0
      }
      model = jsonencode({
        refId      = "C"
        type       = "threshold"
        expression = "B"
        conditions = [{ evaluator = { type = "gt", params = [0.72] } }]
      })
    }

    no_data_state  = "OK"
    exec_err_state = "Error"

    // Explicit, not inherited. Without this block the rule reaches whatever the
    // stack's ROOT notification policy names -- a default declared nowhere in
    // this repo, which another project's edit can redirect with no diff here.
    // The contact point is the one the stack already has; nothing is created.
    // group_by adds slo so primary, tail and availability arrive separately.
    notification_settings {
      contact_point = var.alert_contact_point
      group_by      = ["alertname", "slo"]
    }

    // runbook_url and the two __-prefixed keys turn the Slack message into two
    // clicks. __dashboardUid__/__panelId__ are Grafana's own convention, not
    // ours: given both, the alert renders a "View panel" link straight to panel
    // 19, the SLI ratio these rules alert on. __dashboardUid__ is an HCL
    // REFERENCE, not a string -- hardcoding the uid would silently point at a
    // dashboard that no longer exists after a recreate.
    annotations = {
      summary          = "latency-classes primary (95% objective) burning error budget ~14.4x sustainable over 14m."
      computation      = "window 7d; sustainable miss rate = 1 - 0.95 = 5.000%; fast-burn threshold = 14.4 * 5.000% = 72.000%; alert window 14m = 2% of budget"
      runbook_url      = "https://github.com/koval-yurko/high-load-test/blob/master/ecs-dynamodb-rps/README.md#6-is-it-about-to-break"
      __dashboardUid__ = grafana_dashboard.attribution.uid
      __panelId__      = "19"
    }
    labels = {
      severity = "page"
      slo      = "latency-classes-primary"
    }
  }
}

resource "grafana_rule_group" "latency_classes_tail_fastburn" {
  name             = "ecs-dynamodb-rps / latency-classes tail / fast burn"
  folder_uid       = grafana_folder.project.uid
  interval_seconds = 60

  rule {
    name      = "latency-classes tail burn rate >= 14.4x over 14m"
    condition = "C"
    for       = "70s"

    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      query_type     = "instant"
      relative_time_range {
        from = 840
        to   = 0
      }
      model = jsonencode({
        // refId is echoed back inside the model by Grafana's API. Omitting it
        // makes every subsequent plan propose removing it -- a perpetual diff
        // that trains a reviewer to skim the one place they must not skim.
        refId = "A"
        // instant, not range. query_type on the data block is NOT this flag: the
        // Prometheus datasource reads these booleans from the model, and without
        // them the rule evaluates over a range and returns a series, which the
        // threshold cannot reduce -- "looks like time series data, only reduced
        // data can be alerted on". Burn rate is already a rate over the window,
        // so one sample at evaluation time is the whole answer.
        instant = true
        range   = false
        expr    = <<-PROMQL
          1 - (
            (
              (histogram_fraction(0, 0.15, sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="fast", http_response_status_code!~"5.."}[14m]))) * histogram_count(sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="fast", http_response_status_code!~"5.."}[14m]))) or vector(0))
            +
              (histogram_fraction(0, 0.6, sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="standard", http_response_status_code!~"5.."}[14m]))) * histogram_count(sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="standard", http_response_status_code!~"5.."}[14m]))) or vector(0))
            +
              (histogram_fraction(0, 2.4, sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="heavy", http_response_status_code!~"5.."}[14m]))) * histogram_count(sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="heavy", http_response_status_code!~"5.."}[14m]))) or vector(0))
            )
            /
            histogram_count(sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy"}[14m])))
          )
        PROMQL
      })
    }

    // A -> B -> C, not A -> C. Grafana's expression pipeline will not apply a
    // threshold straight to a query: even an instant query arrives as a series,
    // and the rule fails with "looks like time series data, only reduced data
    // can be alerted on". The reducer is 'last' because A is already an instant
    // query -- there is exactly one sample to take.
    data {
      ref_id         = "B"
      datasource_uid = "__expr__"
      query_type     = "reduce"
      relative_time_range {
        from = 840
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
        from = 840
        to   = 0
      }
      model = jsonencode({
        refId      = "C"
        type       = "threshold"
        expression = "B"
        conditions = [{ evaluator = { type = "gt", params = [0.144] } }]
      })
    }

    no_data_state  = "OK"
    exec_err_state = "Error"

    // Explicit, not inherited. Without this block the rule reaches whatever the
    // stack's ROOT notification policy names -- a default declared nowhere in
    // this repo, which another project's edit can redirect with no diff here.
    // The contact point is the one the stack already has; nothing is created.
    // group_by adds slo so primary, tail and availability arrive separately.
    notification_settings {
      contact_point = var.alert_contact_point
      group_by      = ["alertname", "slo"]
    }

    // runbook_url and the two __-prefixed keys turn the Slack message into two
    // clicks. __dashboardUid__/__panelId__ are Grafana's own convention, not
    // ours: given both, the alert renders a "View panel" link straight to panel
    // 19, the SLI ratio these rules alert on. __dashboardUid__ is an HCL
    // REFERENCE, not a string -- hardcoding the uid would silently point at a
    // dashboard that no longer exists after a recreate.
    annotations = {
      summary          = "latency-classes tail (99% objective) burning error budget ~14.4x sustainable over 14m."
      computation      = "window 7d; sustainable miss rate = 1 - 0.99 = 1.000%; fast-burn threshold = 14.4 * 1.000% = 14.400%; alert window 14m = 2% of budget"
      runbook_url      = "https://github.com/koval-yurko/high-load-test/blob/master/ecs-dynamodb-rps/README.md#6-is-it-about-to-break"
      __dashboardUid__ = grafana_dashboard.attribution.uid
      __panelId__      = "19"
    }
    labels = {
      severity = "page"
      slo      = "latency-classes-tail"
    }
  }
}

resource "grafana_rule_group" "availability_fastburn" {
  name             = "ecs-dynamodb-rps / availability / fast burn"
  folder_uid       = grafana_folder.project.uid
  interval_seconds = 60

  rule {
    name      = "availability burn rate >= 14.4x over 14m"
    condition = "C"
    for       = "70s"

    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      query_type     = "instant"
      relative_time_range {
        from = 840
        to   = 0
      }
      model = jsonencode({
        // refId is echoed back inside the model by Grafana's API. Omitting it
        // makes every subsequent plan propose removing it -- a perpetual diff
        // that trains a reviewer to skim the one place they must not skim.
        refId = "A"
        // instant, not range. query_type on the data block is NOT this flag: the
        // Prometheus datasource reads these booleans from the model, and without
        // them the rule evaluates over a range and returns a series, which the
        // threshold cannot reduce -- "looks like time series data, only reduced
        // data can be alerted on". Burn rate is already a rate over the window,
        // so one sample at evaluation time is the whole answer.
        instant = true
        range   = false
        expr    = <<-PROMQL
          1 - (
            (histogram_count(sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", http_response_status_code!~"5.."}[14m]))) or vector(0))
            /
            histogram_count(sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy"}[14m])))
          )
        PROMQL
      })
    }

    // A -> B -> C, not A -> C. Grafana's expression pipeline will not apply a
    // threshold straight to a query: even an instant query arrives as a series,
    // and the rule fails with "looks like time series data, only reduced data
    // can be alerted on". The reducer is 'last' because A is already an instant
    // query -- there is exactly one sample to take.
    data {
      ref_id         = "B"
      datasource_uid = "__expr__"
      query_type     = "reduce"
      relative_time_range {
        from = 840
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
        from = 840
        to   = 0
      }
      model = jsonencode({
        refId      = "C"
        type       = "threshold"
        expression = "B"
        conditions = [{ evaluator = { type = "gt", params = [0.0144] } }]
      })
    }

    no_data_state  = "OK"
    exec_err_state = "Error"

    // Explicit, not inherited. Without this block the rule reaches whatever the
    // stack's ROOT notification policy names -- a default declared nowhere in
    // this repo, which another project's edit can redirect with no diff here.
    // The contact point is the one the stack already has; nothing is created.
    // group_by adds slo so primary, tail and availability arrive separately.
    notification_settings {
      contact_point = var.alert_contact_point
      group_by      = ["alertname", "slo"]
    }

    // runbook_url and the two __-prefixed keys turn the Slack message into two
    // clicks. __dashboardUid__/__panelId__ are Grafana's own convention, not
    // ours: given both, the alert renders a "View panel" link straight to panel
    // 19, the SLI ratio these rules alert on. __dashboardUid__ is an HCL
    // REFERENCE, not a string -- hardcoding the uid would silently point at a
    // dashboard that no longer exists after a recreate.
    annotations = {
      summary          = "availability (99.9% objective) burning error budget ~14.4x sustainable over 14m."
      computation      = "window 7d; sustainable miss rate = 1 - 0.9990000000000001 = 0.100%; fast-burn threshold = 14.4 * 0.100% = 1.440%; alert window 14m = 2% of budget"
      runbook_url      = "https://github.com/koval-yurko/high-load-test/blob/master/ecs-dynamodb-rps/README.md#6-is-it-about-to-break"
      __dashboardUid__ = grafana_dashboard.attribution.uid
      __panelId__      = "19"
    }
    labels = {
      severity = "page"
      slo      = "availability"
    }
  }
}

resource "grafana_rule_group" "latency_classes_primary_slowburn" {
  name             = "ecs-dynamodb-rps / latency-classes primary / slow burn"
  folder_uid       = grafana_folder.project.uid
  interval_seconds = 60

  rule {
    name      = "latency-classes primary burn rate >= 6x over 84m"
    condition = "C"
    for       = "7m"

    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      query_type     = "instant"
      relative_time_range {
        from = 5040
        to   = 0
      }
      model = jsonencode({
        // refId is echoed back inside the model by Grafana's API. Omitting it
        // makes every subsequent plan propose removing it -- a perpetual diff
        // that trains a reviewer to skim the one place they must not skim.
        refId = "A"
        // instant, not range. query_type on the data block is NOT this flag: the
        // Prometheus datasource reads these booleans from the model, and without
        // them the rule evaluates over a range and returns a series, which the
        // threshold cannot reduce -- "looks like time series data, only reduced
        // data can be alerted on". Burn rate is already a rate over the window,
        // so one sample at evaluation time is the whole answer.
        instant = true
        range   = false
        expr    = <<-PROMQL
          1 - (
            (
              (histogram_fraction(0, 0.05, sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="fast", http_response_status_code!~"5.."}[84m]))) * histogram_count(sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="fast", http_response_status_code!~"5.."}[84m]))) or vector(0))
            +
              (histogram_fraction(0, 0.2, sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="standard", http_response_status_code!~"5.."}[84m]))) * histogram_count(sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="standard", http_response_status_code!~"5.."}[84m]))) or vector(0))
            +
              (histogram_fraction(0, 0.8, sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="heavy", http_response_status_code!~"5.."}[84m]))) * histogram_count(sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="heavy", http_response_status_code!~"5.."}[84m]))) or vector(0))
            )
            /
            histogram_count(sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy"}[84m])))
          )
        PROMQL
      })
    }

    // A -> B -> C, not A -> C. Grafana's expression pipeline will not apply a
    // threshold straight to a query: even an instant query arrives as a series,
    // and the rule fails with "looks like time series data, only reduced data
    // can be alerted on". The reducer is 'last' because A is already an instant
    // query -- there is exactly one sample to take.
    data {
      ref_id         = "B"
      datasource_uid = "__expr__"
      query_type     = "reduce"
      relative_time_range {
        from = 5040
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
        from = 5040
        to   = 0
      }
      model = jsonencode({
        refId      = "C"
        type       = "threshold"
        expression = "B"
        conditions = [{ evaluator = { type = "gt", params = [0.3] } }]
      })
    }

    no_data_state  = "OK"
    exec_err_state = "Error"

    // Explicit, not inherited. Without this block the rule reaches whatever the
    // stack's ROOT notification policy names -- a default declared nowhere in
    // this repo, which another project's edit can redirect with no diff here.
    // The contact point is the one the stack already has; nothing is created.
    // group_by adds slo so primary, tail and availability arrive separately.
    notification_settings {
      contact_point = var.alert_contact_point
      group_by      = ["alertname", "slo"]
    }

    // runbook_url and the two __-prefixed keys turn the Slack message into two
    // clicks. __dashboardUid__/__panelId__ are Grafana's own convention, not
    // ours: given both, the alert renders a "View panel" link straight to panel
    // 19, the SLI ratio these rules alert on. __dashboardUid__ is an HCL
    // REFERENCE, not a string -- hardcoding the uid would silently point at a
    // dashboard that no longer exists after a recreate.
    annotations = {
      summary          = "latency-classes primary (95% objective) burning error budget ~6x sustainable over 84m."
      computation      = "window 7d; sustainable miss rate = 1 - 0.95 = 5.000%; slow-burn threshold = 6 * 5.000% = 30.000%; alert window 84m = 5% of budget"
      runbook_url      = "https://github.com/koval-yurko/high-load-test/blob/master/ecs-dynamodb-rps/README.md#6-is-it-about-to-break"
      __dashboardUid__ = grafana_dashboard.attribution.uid
      __panelId__      = "19"
    }
    labels = {
      severity = "ticket"
      slo      = "latency-classes-primary"
    }
  }
}

resource "grafana_rule_group" "latency_classes_tail_slowburn" {
  name             = "ecs-dynamodb-rps / latency-classes tail / slow burn"
  folder_uid       = grafana_folder.project.uid
  interval_seconds = 60

  rule {
    name      = "latency-classes tail burn rate >= 6x over 84m"
    condition = "C"
    for       = "7m"

    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      query_type     = "instant"
      relative_time_range {
        from = 5040
        to   = 0
      }
      model = jsonencode({
        // refId is echoed back inside the model by Grafana's API. Omitting it
        // makes every subsequent plan propose removing it -- a perpetual diff
        // that trains a reviewer to skim the one place they must not skim.
        refId = "A"
        // instant, not range. query_type on the data block is NOT this flag: the
        // Prometheus datasource reads these booleans from the model, and without
        // them the rule evaluates over a range and returns a series, which the
        // threshold cannot reduce -- "looks like time series data, only reduced
        // data can be alerted on". Burn rate is already a rate over the window,
        // so one sample at evaluation time is the whole answer.
        instant = true
        range   = false
        expr    = <<-PROMQL
          1 - (
            (
              (histogram_fraction(0, 0.15, sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="fast", http_response_status_code!~"5.."}[84m]))) * histogram_count(sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="fast", http_response_status_code!~"5.."}[84m]))) or vector(0))
            +
              (histogram_fraction(0, 0.6, sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="standard", http_response_status_code!~"5.."}[84m]))) * histogram_count(sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="standard", http_response_status_code!~"5.."}[84m]))) or vector(0))
            +
              (histogram_fraction(0, 2.4, sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="heavy", http_response_status_code!~"5.."}[84m]))) * histogram_count(sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", class="heavy", http_response_status_code!~"5.."}[84m]))) or vector(0))
            )
            /
            histogram_count(sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy"}[84m])))
          )
        PROMQL
      })
    }

    // A -> B -> C, not A -> C. Grafana's expression pipeline will not apply a
    // threshold straight to a query: even an instant query arrives as a series,
    // and the rule fails with "looks like time series data, only reduced data
    // can be alerted on". The reducer is 'last' because A is already an instant
    // query -- there is exactly one sample to take.
    data {
      ref_id         = "B"
      datasource_uid = "__expr__"
      query_type     = "reduce"
      relative_time_range {
        from = 5040
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
        from = 5040
        to   = 0
      }
      model = jsonencode({
        refId      = "C"
        type       = "threshold"
        expression = "B"
        conditions = [{ evaluator = { type = "gt", params = [0.06] } }]
      })
    }

    no_data_state  = "OK"
    exec_err_state = "Error"

    // Explicit, not inherited. Without this block the rule reaches whatever the
    // stack's ROOT notification policy names -- a default declared nowhere in
    // this repo, which another project's edit can redirect with no diff here.
    // The contact point is the one the stack already has; nothing is created.
    // group_by adds slo so primary, tail and availability arrive separately.
    notification_settings {
      contact_point = var.alert_contact_point
      group_by      = ["alertname", "slo"]
    }

    // runbook_url and the two __-prefixed keys turn the Slack message into two
    // clicks. __dashboardUid__/__panelId__ are Grafana's own convention, not
    // ours: given both, the alert renders a "View panel" link straight to panel
    // 19, the SLI ratio these rules alert on. __dashboardUid__ is an HCL
    // REFERENCE, not a string -- hardcoding the uid would silently point at a
    // dashboard that no longer exists after a recreate.
    annotations = {
      summary          = "latency-classes tail (99% objective) burning error budget ~6x sustainable over 84m."
      computation      = "window 7d; sustainable miss rate = 1 - 0.99 = 1.000%; slow-burn threshold = 6 * 1.000% = 6.000%; alert window 84m = 5% of budget"
      runbook_url      = "https://github.com/koval-yurko/high-load-test/blob/master/ecs-dynamodb-rps/README.md#6-is-it-about-to-break"
      __dashboardUid__ = grafana_dashboard.attribution.uid
      __panelId__      = "19"
    }
    labels = {
      severity = "ticket"
      slo      = "latency-classes-tail"
    }
  }
}

resource "grafana_rule_group" "availability_slowburn" {
  name             = "ecs-dynamodb-rps / availability / slow burn"
  folder_uid       = grafana_folder.project.uid
  interval_seconds = 60

  rule {
    name      = "availability burn rate >= 6x over 84m"
    condition = "C"
    for       = "7m"

    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      query_type     = "instant"
      relative_time_range {
        from = 5040
        to   = 0
      }
      model = jsonencode({
        // refId is echoed back inside the model by Grafana's API. Omitting it
        // makes every subsequent plan propose removing it -- a perpetual diff
        // that trains a reviewer to skim the one place they must not skim.
        refId = "A"
        // instant, not range. query_type on the data block is NOT this flag: the
        // Prometheus datasource reads these booleans from the model, and without
        // them the rule evaluates over a range and returns a series, which the
        // threshold cannot reduce -- "looks like time series data, only reduced
        // data can be alerted on". Burn rate is already a rate over the window,
        // so one sample at evaluation time is the whole answer.
        instant = true
        range   = false
        expr    = <<-PROMQL
          1 - (
            (histogram_count(sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy", http_response_status_code!~"5.."}[84m]))) or vector(0))
            /
            histogram_count(sum(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps", http_route!~"/healthz", class=~"fast|standard|heavy"}[84m])))
          )
        PROMQL
      })
    }

    // A -> B -> C, not A -> C. Grafana's expression pipeline will not apply a
    // threshold straight to a query: even an instant query arrives as a series,
    // and the rule fails with "looks like time series data, only reduced data
    // can be alerted on". The reducer is 'last' because A is already an instant
    // query -- there is exactly one sample to take.
    data {
      ref_id         = "B"
      datasource_uid = "__expr__"
      query_type     = "reduce"
      relative_time_range {
        from = 5040
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
        from = 5040
        to   = 0
      }
      model = jsonencode({
        refId      = "C"
        type       = "threshold"
        expression = "B"
        conditions = [{ evaluator = { type = "gt", params = [0.006] } }]
      })
    }

    no_data_state  = "OK"
    exec_err_state = "Error"

    // Explicit, not inherited. Without this block the rule reaches whatever the
    // stack's ROOT notification policy names -- a default declared nowhere in
    // this repo, which another project's edit can redirect with no diff here.
    // The contact point is the one the stack already has; nothing is created.
    // group_by adds slo so primary, tail and availability arrive separately.
    notification_settings {
      contact_point = var.alert_contact_point
      group_by      = ["alertname", "slo"]
    }

    // runbook_url and the two __-prefixed keys turn the Slack message into two
    // clicks. __dashboardUid__/__panelId__ are Grafana's own convention, not
    // ours: given both, the alert renders a "View panel" link straight to panel
    // 19, the SLI ratio these rules alert on. __dashboardUid__ is an HCL
    // REFERENCE, not a string -- hardcoding the uid would silently point at a
    // dashboard that no longer exists after a recreate.
    annotations = {
      summary          = "availability (99.9% objective) burning error budget ~6x sustainable over 84m."
      computation      = "window 7d; sustainable miss rate = 1 - 0.9990000000000001 = 0.100%; slow-burn threshold = 6 * 0.100% = 0.600%; alert window 84m = 5% of budget"
      runbook_url      = "https://github.com/koval-yurko/high-load-test/blob/master/ecs-dynamodb-rps/README.md#6-is-it-about-to-break"
      __dashboardUid__ = grafana_dashboard.attribution.uid
      __panelId__      = "19"
    }
    labels = {
      severity = "ticket"
      slo      = "availability"
    }
  }
}
