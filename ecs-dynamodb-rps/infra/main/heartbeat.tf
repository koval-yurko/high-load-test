# The idle population for the SLI, replacing Grafana Synthetic Monitoring.
#
# SM was the original design (2026-08-29 spec). It is not usable here: the SM
# tenant is disabled at the Grafana Cloud ACCOUNT level, and re-enabling it needs
# a third credential issued from a portal we are deliberately not depending on.
# The premise the SLI needs is only that traffic exists between load tests -- not
# that a Grafana probe produces it -- so the same job is done inside AWS by
# EventBridge Scheduler invoking a one-file Lambda once a minute.
#
# Cost is negligible next to the ALB and the two Fargate tasks: ~43k invocations
# a month at 128 MB and well under a second each, comfortably inside the Lambda
# free tier, plus 43k scheduler invocations. Turn it off with
# heartbeat_enabled = false when the environment is up but idle for days.

# Built from the source tree at plan time, so there is no build step and nothing
# generated is committed. The zip lands in .terraform/ -- writing it back into
# the source tree would make `git status` dirty on every plan and, worse, feed
# the previous zip into the next hash.
data "archive_file" "heartbeat" {
  type        = "zip"
  source_dir  = "${path.module}/../../heartbeat"
  output_path = "${path.module}/.terraform/heartbeat.zip"
}

resource "aws_iam_role" "heartbeat" {
  name               = "${var.project}-heartbeat"
  assume_role_policy = data.aws_iam_policy_document.assume_lambda.json
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

# Logs only. The function talks to the ALB over the public internet and touches
# no AWS API, so it needs nothing else.
resource "aws_iam_role_policy_attachment" "heartbeat_basic" {
  role       = aws_iam_role.heartbeat.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Declared, not left to Lambda's implicit creation: an implicitly created log
# group is not in state, survives `terraform destroy`, and bills forever.
resource "aws_cloudwatch_log_group" "heartbeat" {
  name              = "/aws/lambda/${var.project}-heartbeat"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "heartbeat" {
  function_name = "${var.project}-heartbeat"
  role          = aws_iam_role.heartbeat.arn
  runtime       = "nodejs22.x"
  handler       = "index.handler"

  filename         = data.archive_file.heartbeat.output_path
  source_code_hash = data.archive_file.heartbeat.output_base64sha256

  # Deliberately NOT in the VPC. The ALB is internet-facing, so a VPC attachment
  # would buy nothing and cost ENI provisioning on every cold start -- and would
  # need a NAT gateway to reach anything else.
  timeout     = 30
  memory_size = 128

  environment {
    variables = {
      BASE_URL = "http://${aws_lb.main.dns_name}"
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.heartbeat_basic,
    aws_cloudwatch_log_group.heartbeat,
  ]
}

# Scheduler, not an EventBridge rule: rate(1 minute) is the same either way, but
# the schedule is a single resource with no target/permission pair to keep in
# sync, and it can be disabled without being destroyed.
resource "aws_iam_role" "heartbeat_scheduler" {
  name               = "${var.project}-heartbeat-scheduler"
  assume_role_policy = data.aws_iam_policy_document.assume_scheduler.json
}

data "aws_iam_policy_document" "assume_scheduler" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "heartbeat_invoke" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.heartbeat.arn]
  }
}

resource "aws_iam_role_policy" "heartbeat_scheduler" {
  name   = "${var.project}-heartbeat-invoke"
  role   = aws_iam_role.heartbeat_scheduler.id
  policy = data.aws_iam_policy_document.heartbeat_invoke.json
}

resource "aws_scheduler_schedule" "heartbeat" {
  count = var.heartbeat_enabled ? 1 : 0

  name                = "${var.project}-heartbeat"
  schedule_expression = var.heartbeat_rate

  # OFF, not a window: the point is an evenly spaced population. Letting the
  # scheduler smear invocations across a window would put gaps in the SLI ratio
  # that look like the service went quiet.
  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.heartbeat.arn
    role_arn = aws_iam_role.heartbeat_scheduler.arn
  }
}
