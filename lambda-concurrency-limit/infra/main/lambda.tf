# Terraform owns the function's INFRASTRUCTURE; scripts/deploy-service.sh owns its CODE and moves
# the alias (spec decision 13). So the code and the alias target are ignored below.
#
# publish = true: every configuration change Terraform makes publishes a new version, because a
# version freezes environment, memory and layers. Alias live does not follow it by itself:
# deploy-service.sh --config-only moves it. Published versions are deleted with the function.

data "archive_file" "placeholder" {
  type        = "zip"
  output_path = "${path.module}/placeholder.zip"

  source {
    content  = file("${path.module}/placeholder.js")
    filename = "src/handler.js" # matches handler = "src/handler.handler"
  }
}

# Declared before the function, so Lambda never creates it untagged with no retention.
resource "aws_cloudwatch_log_group" "app" {
  name              = "/aws/lambda/${var.project}"
  retention_in_days = var.log_retention_days
}

# A cold start appears only as "Init Duration" on the REPORT line; there is no Init metric.
# Provisioned environments initialise before any request, so their REPORT lines carry none.
resource "aws_cloudwatch_log_metric_filter" "cold_starts" {
  name           = "${var.project}-cold-starts"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "\"REPORT RequestId\" \"Init Duration\""

  metric_transformation {
    name      = "ColdStarts"
    namespace = var.project
    value     = "1"
    unit      = "Count"
  }
}

data "aws_iam_policy_document" "assume_lambda" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = var.project
  assume_role_policy = data.aws_iam_policy_document.assume_lambda.json
}

data "aws_iam_policy_document" "app" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.app.arn}:*"]
  }
  # Reads only: the load is GET-only, and the seed runs from the laptop with its own credentials.
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.items.arn]
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "app"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}

locals {
  layer_prefix = "arn:aws:lambda:${data.aws_region.current.region}:184161586896:layer"
  # Upstream open-telemetry/opentelemetry-lambda; both checked in eu-central-1 on 2026-11-09.
  otel_layers = [
    "${local.layer_prefix}:opentelemetry-nodejs-${var.otel_layer_version}:1",
    "${local.layer_prefix}:opentelemetry-collector-arm64-${var.otel_layer_version}:1",
  ]

  otel_env = {
    AWS_LAMBDA_EXEC_WRAPPER            = "/opt/otel-handler"
    OPENTELEMETRY_COLLECTOR_CONFIG_URI = "/var/task/collector.yaml"
    OTEL_SERVICE_NAME                  = var.project
    OTEL_TRACES_SAMPLER                = "parentbased_traceidratio"
    OTEL_TRACES_SAMPLER_ARG            = tostring(var.trace_sample_ratio)
    # collector.yaml has a traces pipeline only.
    OTEL_METRICS_EXPORTER = "none"
    OTEL_LOGS_EXPORTER    = "none"
    # Read by collector.yaml as ${env:...}.
    GRAFANA_OTLP_ENDPOINT = var.grafana_otlp_endpoint
    GRAFANA_OTLP_AUTH     = "Basic ${base64encode("${var.grafana_otlp_username}:${var.grafana_otlp_password}")}"
  }

  app_env = merge(
    {
      TABLE_NAME           = aws_dynamodb_table.items.name
      HEAVY_CPU_ITERATIONS = tostring(var.heavy_cpu_iterations)
    },
    var.sdk_max_attempts == null ? {} : { AWS_MAX_ATTEMPTS = tostring(var.sdk_max_attempts) },
    var.otel_enabled ? local.otel_env : {},
  )
}

resource "aws_lambda_function" "app" {
  function_name = var.project
  role          = aws_iam_role.app.arn
  runtime       = "nodejs22.x"
  architectures = ["arm64"]
  handler       = "src/handler.handler"
  memory_size   = var.memory_size
  timeout       = var.timeout_seconds
  publish       = true

  # Always set: a function without reserved concurrency draws from the shared pool.
  reserved_concurrent_executions = var.reserved_concurrency

  filename         = data.archive_file.placeholder.output_path
  source_code_hash = data.archive_file.placeholder.output_base64sha256

  layers = var.otel_enabled ? local.otel_layers : []

  environment {
    variables = local.app_env
  }

  depends_on = [aws_cloudwatch_log_group.app, aws_iam_role_policy.app]

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

resource "aws_lambda_alias" "live" {
  name             = "live"
  function_name    = aws_lambda_function.app.function_name
  function_version = aws_lambda_function.app.version

  lifecycle {
    ignore_changes = [function_version] # deploy-service.sh moves it
  }
}

# Knob 3. Allocation takes 1-2 minutes; the provider waits for READY. Billed per hour while it exists.
resource "aws_lambda_provisioned_concurrency_config" "live" {
  count = var.provisioned_concurrency > 0 ? 1 : 0

  function_name                     = aws_lambda_function.app.function_name
  qualifier                         = aws_lambda_alias.live.name
  provisioned_concurrent_executions = var.provisioned_concurrency
}
