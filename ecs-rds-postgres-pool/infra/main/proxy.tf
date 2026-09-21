# proxy.tf
# KNOB 3. Everything here is count-gated, so it exists in code and costs nothing
# until var.proxy_enabled flips -- which is what keeps plan 4 free of
# implementation work.
#
# The pre-registered expectation, written before any run so a null result is a
# published result rather than a disappointment: against four long-lived ECS
# tasks holding warm pools, connection count at the instance falls well below
# knob 2's level and session pinning stays near zero; p95 rises by a millisecond
# or two from the extra hop; SLO attainment is unchanged or marginally worse
# UNLESS knob 2 actually breached the connection ceiling, in which case
# availability recovers -- and that is the whole finding.

# RDS Proxy accepts only Secrets Manager, not SSM. recovery_window_in_days = 0 is
# MANDATORY in a lab destroyed daily: the default 7-30 day window makes the next
# apply fail with "a secret with this name is scheduled for deletion".
resource "aws_secretsmanager_secret" "db" {
  count                   = var.proxy_enabled ? 1 : 0
  name                    = "${var.project}-db"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "db" {
  count     = var.proxy_enabled ? 1 : 0
  secret_id = aws_secretsmanager_secret.db[0].id
  secret_string = jsonencode({
    username = var.db_username
    password = var.db_password
  })
}

data "aws_iam_policy_document" "proxy_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "proxy" {
  count              = var.proxy_enabled ? 1 : 0
  name               = "${var.project}-proxy"
  assume_role_policy = data.aws_iam_policy_document.proxy_assume.json
}

resource "aws_iam_role_policy" "proxy" {
  count = var.proxy_enabled ? 1 : 0
  role  = aws_iam_role.proxy[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = aws_secretsmanager_secret.db[0].arn
    }]
  })
}

# The proxy writes its logs to /aws/rds/proxy/<proxy name>. Left to itself, RDS
# creates that group implicitly: untagged (so the Project tag sweep never finds
# it) and never-expiring (so it survives teardown and bills forever). Declaring
# it first, with retention, is the same guard rds.tf puts on the instance's
# postgresql log group. The path is to be confirmed at the first knob-3 apply;
# declaring it costs nothing while the proxy is off.
resource "aws_cloudwatch_log_group" "proxy" {
  count             = var.proxy_enabled ? 1 : 0
  name              = "/aws/rds/proxy/${var.project}"
  retention_in_days = var.log_retention_days
}

resource "aws_db_proxy" "main" {
  count                  = var.proxy_enabled ? 1 : 0
  name                   = var.project
  engine_family          = "POSTGRESQL"
  role_arn               = aws_iam_role.proxy[0].arn
  vpc_subnet_ids         = aws_subnet.public[*].id
  vpc_security_group_ids = [aws_security_group.db.id]
  require_tls            = true

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = aws_secretsmanager_secret.db[0].arn
  }

  depends_on = [aws_cloudwatch_log_group.proxy]
}

resource "aws_db_proxy_default_target_group" "main" {
  count         = var.proxy_enabled ? 1 : 0
  db_proxy_name = aws_db_proxy.main[0].name
}

resource "aws_db_proxy_target" "main" {
  count                  = var.proxy_enabled ? 1 : 0
  db_proxy_name          = aws_db_proxy.main[0].name
  target_group_name      = aws_db_proxy_default_target_group.main[0].name
  db_instance_identifier = aws_db_instance.main.identifier
}

locals {
  # THE SWITCH. Releasing knob 3 is an edit to dev.tfvars and an apply -- no code
  # change, no image rebuild, no redeploy. src/pool.js trusts both certificate
  # chains this can lead to (the RDS CA for the instance, Amazon's public roots
  # for the proxy), so flipping it cannot fail TLS.
  db_host = var.proxy_enabled ? aws_db_proxy.main[0].endpoint : aws_db_instance.main.address

  # The password is interpolated here rather than injected as a container secret
  # because the service takes one DATABASE_URL and nothing else. It therefore
  # lands in the task definition, readable by anyone with
  # ecs:DescribeTaskDefinition. Acceptable in a lab whose database holds
  # generated rows and is destroyed daily; not acceptable anywhere else, which is
  # why this comment exists rather than being absent.
  database_url = "postgresql://${var.db_username}:${var.db_password}@${local.db_host}:5432/${var.db_name}"
}
