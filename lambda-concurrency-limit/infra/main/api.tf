# REST API (v1) on purpose: per-client throttling through usage plans exists only on REST APIs
# (spec decision 1). Explicit resources, not {proxy+}: the handler routes on event.resource.

locals {
  users = ["normal-1", "normal-2", "normal-3", "normal-4", "noisy"]
}

resource "aws_api_gateway_rest_api" "app" {
  name           = var.project
  api_key_source = "HEADER" # x-api-key, sent by infra/k6/tests/lib/request.js

  endpoint_configuration {
    types = ["REGIONAL"]
  }
}

resource "aws_api_gateway_resource" "items" {
  rest_api_id = aws_api_gateway_rest_api.app.id
  parent_id   = aws_api_gateway_rest_api.app.root_resource_id
  path_part   = "items"
}

resource "aws_api_gateway_resource" "items_pk" {
  rest_api_id = aws_api_gateway_rest_api.app.id
  parent_id   = aws_api_gateway_resource.items.id
  path_part   = "{pk}"
}

resource "aws_api_gateway_resource" "items_sk" {
  rest_api_id = aws_api_gateway_rest_api.app.id
  parent_id   = aws_api_gateway_resource.items_pk.id
  path_part   = "{sk}"
}

resource "aws_api_gateway_resource" "feeds" {
  rest_api_id = aws_api_gateway_rest_api.app.id
  parent_id   = aws_api_gateway_rest_api.app.root_resource_id
  path_part   = "feeds"
}

resource "aws_api_gateway_resource" "feeds_pk" {
  rest_api_id = aws_api_gateway_rest_api.app.id
  parent_id   = aws_api_gateway_resource.feeds.id
  path_part   = "{pk}"
}

resource "aws_api_gateway_resource" "reports" {
  rest_api_id = aws_api_gateway_rest_api.app.id
  parent_id   = aws_api_gateway_rest_api.app.root_resource_id
  path_part   = "reports"
}

resource "aws_api_gateway_resource" "reports_pk" {
  rest_api_id = aws_api_gateway_rest_api.app.id
  parent_id   = aws_api_gateway_resource.reports.id
  path_part   = "{pk}"
}

locals {
  # class -> the leaf resource of its route (slo.yaml)
  routes = {
    fast     = aws_api_gateway_resource.items_sk.id
    standard = aws_api_gateway_resource.feeds_pk.id
    heavy    = aws_api_gateway_resource.reports_pk.id
  }
}

# The anonymous tier: a keyless copy of each route under /public (spec section 4.1). A usage plan
# counts a call only when the method needs a key, and a method that does not ignores any key sent,
# so the keyless routes are separate resources. The handler strips the /public prefix.
locals {
  anon = var.anonymous_enabled ? 1 : 0
}

resource "aws_api_gateway_resource" "public" {
  count       = local.anon
  rest_api_id = aws_api_gateway_rest_api.app.id
  parent_id   = aws_api_gateway_rest_api.app.root_resource_id
  path_part   = "public"
}

resource "aws_api_gateway_resource" "public_items" {
  count       = local.anon
  rest_api_id = aws_api_gateway_rest_api.app.id
  parent_id   = aws_api_gateway_resource.public[0].id
  path_part   = "items"
}

resource "aws_api_gateway_resource" "public_items_pk" {
  count       = local.anon
  rest_api_id = aws_api_gateway_rest_api.app.id
  parent_id   = aws_api_gateway_resource.public_items[0].id
  path_part   = "{pk}"
}

resource "aws_api_gateway_resource" "public_items_sk" {
  count       = local.anon
  rest_api_id = aws_api_gateway_rest_api.app.id
  parent_id   = aws_api_gateway_resource.public_items_pk[0].id
  path_part   = "{sk}"
}

resource "aws_api_gateway_resource" "public_feeds" {
  count       = local.anon
  rest_api_id = aws_api_gateway_rest_api.app.id
  parent_id   = aws_api_gateway_resource.public[0].id
  path_part   = "feeds"
}

resource "aws_api_gateway_resource" "public_feeds_pk" {
  count       = local.anon
  rest_api_id = aws_api_gateway_rest_api.app.id
  parent_id   = aws_api_gateway_resource.public_feeds[0].id
  path_part   = "{pk}"
}

resource "aws_api_gateway_resource" "public_reports" {
  count       = local.anon
  rest_api_id = aws_api_gateway_rest_api.app.id
  parent_id   = aws_api_gateway_resource.public[0].id
  path_part   = "reports"
}

resource "aws_api_gateway_resource" "public_reports_pk" {
  count       = local.anon
  rest_api_id = aws_api_gateway_rest_api.app.id
  parent_id   = aws_api_gateway_resource.public_reports[0].id
  path_part   = "{pk}"
}

locals {
  public_routes = var.anonymous_enabled ? {
    fast     = aws_api_gateway_resource.public_items_sk[0].id
    standard = aws_api_gateway_resource.public_feeds_pk[0].id
    heavy    = aws_api_gateway_resource.public_reports_pk[0].id
  } : {}
}

resource "aws_api_gateway_method" "public" {
  for_each = local.public_routes

  rest_api_id      = aws_api_gateway_rest_api.app.id
  resource_id      = each.value
  http_method      = "GET"
  authorization    = "NONE"
  api_key_required = false # the anonymous tier; the WAF rule limits it per address
}

resource "aws_api_gateway_integration" "public" {
  for_each = local.public_routes

  rest_api_id             = aws_api_gateway_rest_api.app.id
  resource_id             = each.value
  http_method             = aws_api_gateway_method.public[each.key].http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = aws_lambda_alias.live.invoke_arn
}

resource "aws_api_gateway_method" "get" {
  for_each = local.routes

  rest_api_id      = aws_api_gateway_rest_api.app.id
  resource_id      = each.value
  http_method      = "GET"
  authorization    = "NONE"
  api_key_required = true # identifies the test user; AWS: not authentication
}

resource "aws_api_gateway_integration" "get" {
  for_each = local.routes

  rest_api_id             = aws_api_gateway_rest_api.app.id
  resource_id             = each.value
  http_method             = aws_api_gateway_method.get[each.key].http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  # The alias, never $LATEST: deploy-service.sh moves live, and provisioned concurrency sits on it.
  uri = aws_lambda_alias.live.invoke_arn
}

resource "aws_lambda_permission" "api" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.app.function_name
  qualifier     = aws_lambda_alias.live.name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.app.execution_arn}/*/GET/*"
}

resource "aws_api_gateway_deployment" "app" {
  rest_api_id = aws_api_gateway_rest_api.app.id

  # A REST API serves a snapshot; a route change needs a new deployment.
  triggers = {
    redeployment = sha1(jsonencode([
      local.routes,
      [for m in aws_api_gateway_method.get : m.id],
      [for i in aws_api_gateway_integration.get : i.id],
      aws_api_gateway_gateway_response.throttled.response_parameters,
      [for m in aws_api_gateway_method.public : m.id],
      [for i in aws_api_gateway_integration.public : i.id],
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_api_gateway_stage" "dev" {
  rest_api_id   = aws_api_gateway_rest_api.app.id
  deployment_id = aws_api_gateway_deployment.app.id
  stage_name    = "dev"
}

# Per-method CloudWatch metrics, so Latency is visible per route (the Grafana SLO row). Billed as
# custom metrics, cents per session. Logging stays off: it needs the account-wide API Gateway
# CloudWatch role, and the account is shared with other apps.
resource "aws_api_gateway_method_settings" "all" {
  rest_api_id = aws_api_gateway_rest_api.app.id
  stage_name  = aws_api_gateway_stage.dev.stage_name
  method_path = "*/*"

  settings {
    metrics_enabled = true
  }
}

resource "aws_api_gateway_api_key" "user" {
  for_each = toset(concat(local.users, ["load"]))

  name = "${var.project}-${each.key}"
}

# Knob 1. AWS: usage plan throttling is best-effort, not a hard limit; the knob 1 run measures how
# far it leaks. Throttle is per API key.
resource "aws_api_gateway_usage_plan" "users" {
  name = "${var.project}-users"

  api_stages {
    api_id = aws_api_gateway_rest_api.app.id
    stage  = aws_api_gateway_stage.dev.stage_name
  }

  dynamic "throttle_settings" {
    for_each = var.user_rate_limit_requests > 0 ? [1] : []
    content {
      # A token bucket: the full allowance can arrive at once (burst), then it refills evenly over the window.
      rate_limit  = var.user_rate_limit_requests / var.user_rate_limit_window_seconds
      burst_limit = var.user_rate_limit_requests
    }
  }
}

# A throttled request gets 429 from API Gateway whichever limit it crossed (usage plan or stage).
# The header marks it as a limit working; k6 counts only marked 429s as rate limited
# (infra/k6/tests/lib/tier.js). A Lambda or DynamoDB capacity problem is a 500, never a 429.
resource "aws_api_gateway_gateway_response" "throttled" {
  rest_api_id   = aws_api_gateway_rest_api.app.id
  response_type = "THROTTLED"
  status_code   = "429"

  response_parameters = {
    "gatewayresponse.header.x-throttle" = "'apigw'"
  }
}

# The load user drives discovery, constant and spike. Never throttled: those profiles measure the
# function's concurrency, not the usage plan.
resource "aws_api_gateway_usage_plan" "load" {
  name = "${var.project}-load"

  api_stages {
    api_id = aws_api_gateway_rest_api.app.id
    stage  = aws_api_gateway_stage.dev.stage_name
  }
}

resource "aws_api_gateway_usage_plan_key" "user" {
  for_each = toset(local.users)

  key_id        = aws_api_gateway_api_key.user[each.key].id
  key_type      = "API_KEY"
  usage_plan_id = aws_api_gateway_usage_plan.users.id
}

resource "aws_api_gateway_usage_plan_key" "load" {
  key_id        = aws_api_gateway_api_key.user["load"].id
  key_type      = "API_KEY"
  usage_plan_id = aws_api_gateway_usage_plan.load.id
}
