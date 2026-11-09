# The AWS-side view (spec, "CloudWatch dashboard"): where the Lambda time goes. Not tagged: the
# resource has no tags argument (hashicorp/aws 6.x), so the tag sweep cannot see it; destroy
# deletes it, and the README's teardown checks it by name.
locals {
  region = data.aws_region.current.region
  fn     = aws_lambda_function.app.function_name
  alias  = "${aws_lambda_function.app.function_name}:${aws_lambda_alias.live.name}"
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = var.project
  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 12, height = 8
        properties = {
          title  = "Where the Lambda time goes (avg, alias live)"
          region = local.region
          period = 60
          view   = "timeSeries"
          metrics = [
            ["AWS/Lambda", "Duration", "FunctionName", local.fn, "Resource", local.alias, { id = "d", stat = "Average", label = "Duration" }],
            [".", "PostRuntimeExtensionsDuration", ".", ".", ".", ".", { id = "x", stat = "Average", label = "OTel export (after the response)" }],
            [{ id = "code", expression = "d - x", label = "code's own time" }],
            [{ id = "pct", expression = "100 * x / d", label = "export % of Duration", yAxis = "right" }],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 0, width = 12, height = 8
        properties = {
          title  = "Where the Lambda time goes (p99, alias live)"
          region = local.region
          period = 60
          view   = "timeSeries"
          metrics = [
            ["AWS/Lambda", "Duration", "FunctionName", local.fn, "Resource", local.alias, { stat = "p99", label = "Duration p99" }],
            [".", "PostRuntimeExtensionsDuration", ".", ".", ".", ".", { stat = "p99", label = "OTel export p99" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 8, width = 8, height = 6
        properties = {
          title  = "Concurrency and throttles"
          region = local.region
          period = 60
          view   = "timeSeries"
          metrics = [
            ["AWS/Lambda", "ConcurrentExecutions", "FunctionName", local.fn, { stat = "Maximum" }],
            [".", "Throttles", ".", ".", { stat = "Sum" }],
          ]
          annotations = { horizontal = [{ label = "reserved", value = var.reserved_concurrency }] }
        }
      },
      {
        type = "metric", x = 8, y = 8, width = 8, height = 6
        properties = {
          title   = "Account unreserved concurrency in use (limit 352)"
          region  = local.region
          period  = 60
          view    = "timeSeries"
          metrics = [["AWS/Lambda", "UnreservedConcurrentExecutions", { stat = "Maximum" }]]
        }
      },
      {
        type = "metric", x = 16, y = 8, width = 8, height = 6
        properties = {
          title  = "DynamoDB reads"
          region = local.region
          period = 60
          view   = "timeSeries"
          metrics = [
            ["AWS/DynamoDB", "ConsumedReadCapacityUnits", "TableName", aws_dynamodb_table.items.name, { stat = "Sum" }],
            [".", "ReadThrottleEvents", ".", ".", { stat = "Sum" }],
          ]
        }
      },
    ]
  })
}
