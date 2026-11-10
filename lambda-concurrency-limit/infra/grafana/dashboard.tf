# Every panel reads CloudWatch: the function emits no service-side metrics, and the SLI is k6 only
# (spec decision 5). The k6 app holds the per-user view (API Gateway has no per-key metric).
locals {
  api   = { ApiName = var.api_name, Stage = var.stage_name }
  fn    = { FunctionName = var.function_name }
  alias = { FunctionName = var.function_name, Resource = "${var.function_name}:${var.alias_name}" }
  table = { TableName = var.table_name }

  method = { for c, r in local.slo.class_route : c => merge(local.api, { Method = "GET", Resource = r }) }

  # A section is a Grafana row; each inner list is one line of panels that share the full width.
  # Panel ids count up through the data panels in this order. alerts.tf links to id 2 ("4xx and 5xx"),
  # so keep that panel second.
  sections = concat([
    { title = "1 · Traffic and API Gateway latency", lines = [[
      { title = "1 · Requests", unit = "short", threshold = null, targets = [
        { ns = "AWS/ApiGateway", metric = "Count", stat = "Sum", dims = tomap(local.api) },
      ] },
      { title = "1 · 4xx (incl. per-user 429) and 5xx (incl. Lambda throttles)", unit = "short", threshold = null, targets = [
        { ns = "AWS/ApiGateway", metric = "4XXError", stat = "Sum", dims = tomap(local.api) },
        { ns = "AWS/ApiGateway", metric = "5XXError", stat = "Sum", dims = tomap(local.api) },
      ] },
      { title = "1 · Latency vs IntegrationLatency p95 (difference = overhead o)", unit = "ms", threshold = null, targets = [
        { ns = "AWS/ApiGateway", metric = "Latency", stat = "p95", dims = tomap(local.api) },
        { ns = "AWS/ApiGateway", metric = "IntegrationLatency", stat = "p95", dims = tomap(local.api) },
      ] },
    ]] },
    { title = "2 · SLO", lines = [
      [
        { title = "2 · 5xx fraction vs the availability budget", unit = "percentunit", threshold = 1 - local.slo.availability_objective, targets = [
          { ns = "AWS/ApiGateway", metric = "5XXError", stat = "Average", dims = tomap(local.api) },
        ] },
      ],
      [for c in ["fast", "standard", "heavy"] : {
        title = "2 · ${c} ${local.slo.class_route[c]} p95 vs threshold", unit = "ms", threshold = local.slo.class_threshold_ms[c], targets = [
          { ns = "AWS/ApiGateway", metric = "Latency", stat = "p95", dims = tomap(local.method[c]) },
        ]
      }],
    ] },
    { title = "3 · Lambda concurrency", lines = [[
      { title = "3 · ConcurrentExecutions vs reserved", unit = "short", threshold = var.reserved_concurrency, targets = [
        { ns = "AWS/Lambda", metric = "ConcurrentExecutions", stat = "Maximum", dims = tomap(local.fn) },
      ] },
      { title = "3 · Throttles (not in Invocations or Errors)", unit = "short", threshold = null, targets = [
        { ns = "AWS/Lambda", metric = "Throttles", stat = "Sum", dims = tomap(local.fn) },
      ] },
      { title = "3 · Account UnreservedConcurrentExecutions (shared pool)", unit = "short", threshold = var.unreserved_alert, targets = [
        { ns = "AWS/Lambda", metric = "UnreservedConcurrentExecutions", stat = "Maximum", dims = tomap({}) },
      ] },
    ]] },
    { title = "4 · Function duration and cold starts", lines = [[
      { title = "4 · Duration and OTel export (avg, p99)", unit = "ms", threshold = null, targets = [
        { ns = "AWS/Lambda", metric = "Duration", stat = "Average", dims = tomap(local.alias) },
        { ns = "AWS/Lambda", metric = "Duration", stat = "p99", dims = tomap(local.alias) },
        { ns = "AWS/Lambda", metric = "PostRuntimeExtensionsDuration", stat = "Average", dims = tomap(local.alias) },
        { ns = "AWS/Lambda", metric = "PostRuntimeExtensionsDuration", stat = "p99", dims = tomap(local.alias) },
      ] },
      { title = "4 · Cold starts (REPORT lines with Init Duration)", unit = "short", threshold = null, targets = [
        { ns = var.project, metric = "ColdStarts", stat = "Sum", dims = tomap({}) },
      ] },
    ]] },
    { title = "5 · Provisioned concurrency", lines = [[
      { title = "5 · Provisioned concurrency", unit = "short", threshold = null, targets = [
        { ns = "AWS/Lambda", metric = "ProvisionedConcurrencyUtilization", stat = "Maximum", dims = tomap(local.alias) },
        { ns = "AWS/Lambda", metric = "ProvisionedConcurrencySpilloverInvocations", stat = "Sum", dims = tomap(local.alias) },
      ] },
    ]] },
    { title = "6 · DynamoDB", lines = [[
      { title = "6 · DynamoDB read capacity (Sum per minute)", unit = "short", threshold = null, targets = [
        { ns = "AWS/DynamoDB", metric = "ConsumedReadCapacityUnits", stat = "Sum", dims = tomap(local.table) },
        { ns = "AWS/DynamoDB", metric = "ProvisionedReadCapacityUnits", stat = "Average", dims = tomap(local.table) },
      ] },
      { title = "6 · DynamoDB ReadThrottleEvents", unit = "short", threshold = null, targets = [
        { ns = "AWS/DynamoDB", metric = "ReadThrottleEvents", stat = "Sum", dims = tomap(local.table) },
      ] },
      { title = "6 · DynamoDB SuccessfulRequestLatency", unit = "ms", threshold = null, targets = [
        { ns = "AWS/DynamoDB", metric = "SuccessfulRequestLatency", stat = "Average", dims = tomap(merge(local.table, { Operation = "GetItem" })) },
        { ns = "AWS/DynamoDB", metric = "SuccessfulRequestLatency", stat = "Average", dims = tomap(merge(local.table, { Operation = "Query" })) },
      ] },
    ]] },
    ], [for _ in range(var.anonymous_enabled ? 1 : 0) : {
      # Last, so the panel ids above (alerts.tf links to id 2) do not move.
      title = "7 · Rate limiting", lines = [[
        { title = "7 · WAF blocked requests (anonymous tier)", unit = "short", threshold = null, targets = [
          { ns = "AWS/WAFV2", metric = "BlockedRequests", stat = "Sum", dims = tomap({ WebACL = var.web_acl_name, Rule = "anonymous-per-ip", Region = local.region }) },
        ] },
        { title = "7 · WAF allowed vs blocked (whole web ACL; blocked share = limit working)", unit = "short", threshold = null, targets = [
          { ns = "AWS/WAFV2", metric = "AllowedRequests", stat = "Sum", dims = tomap({ WebACL = var.web_acl_name, Rule = "ALL", Region = local.region }) },
          { ns = "AWS/WAFV2", metric = "BlockedRequests", stat = "Sum", dims = tomap({ WebACL = var.web_acl_name, Rule = "ALL", Region = local.region }) },
        ] },
      ]]
  }])

  # One entry per row header (panels = []) and per line of panels, top to bottom.
  entries = flatten([for s in local.sections : concat(
    [{ header = s.title, panels = [] }],
    [for l in s.lines : { header = null, panels = l }],
  )])
  entry_y    = [for i, e in local.entries : sum(concat([0], [for j, k in local.entries : k.header == null ? 8 : 1 if j < i]))]
  entry_pid0 = [for i, e in local.entries : sum(concat([0], [for j, k in local.entries : length(k.panels) if j < i]))]

  datasource = { type = "cloudwatch", uid = var.cloudwatch_datasource_uid }

  dashboard_panels = concat(
    [for i, e in local.entries : {
      id        = 100 + i
      type      = "row"
      title     = e.header
      collapsed = false
      gridPos   = { h = 1, w = 24, x = 0, y = local.entry_y[i] }
      panels    = []
    } if e.header != null],
    flatten([for i, e in local.entries : [for j, p in e.panels : {
      id         = local.entry_pid0[i] + j + 1
      type       = "timeseries"
      title      = p.title
      datasource = local.datasource
      gridPos    = { h = 8, w = 24 / length(e.panels), x = j * 24 / length(e.panels), y = local.entry_y[i] }
      fieldConfig = {
        defaults = {
          unit   = p.unit
          custom = { thresholdsStyle = { mode = p.threshold == null ? "off" : "line" } }
          thresholds = {
            mode  = "absolute"
            steps = concat([{ color = "green", value = null }], p.threshold == null ? [] : [{ color = "red", value = p.threshold }])
          }
        }
        overrides = []
      }
      targets = [for k, t in p.targets : {
        refId            = substr("ABCDEFGH", k, 1)
        datasource       = local.datasource
        region           = local.region
        namespace        = t.ns
        metricName       = t.metric
        statistic        = t.stat
        dimensions       = t.dims
        matchExact       = true
        period           = "60"
        label            = "${t.metric} ${t.stat}"
        queryMode        = "Metrics"
        metricQueryType  = 0
        metricEditorMode = 0
      }]
    }]]),
  )
}

resource "grafana_dashboard" "main" {
  folder = grafana_folder.project.uid
  config_json = jsonencode({
    uid           = var.project
    title         = var.project
    timezone      = "utc"
    refresh       = "1m"
    schemaVersion = 39
    time          = { from = "now-1h", to = "now" }
    panels        = local.dashboard_panels
  })
}
