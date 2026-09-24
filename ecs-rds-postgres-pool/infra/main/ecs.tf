# Forked from ecs-dynamodb-rps/infra/main/ecs.tf on 2026-09-21.
# A bug fixed here does not reach the sibling copy; fix both.

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.project}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_cluster" "main" {
  name = var.project
}

data "aws_iam_policy_document" "assume_ecs_tasks" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.project}-execution"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_tasks.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "task" {
  name               = "${var.project}-task"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_tasks.json
}

# What the service publishes its event-loop utilization under (src/cloudwatch.js).
# Read by the task's environment and the IAM condition below. Nothing in this
# project consumes the metric: its only reader in the sibling was the autoscaling
# alarm, and there is no autoscaler here. It is kept because plan 1's environment
# contract sets METRICS_NAMESPACE; unsetting it would stop the PutMetricData
# calls, and that is a choice for a later plan.
locals {
  metrics_namespace    = var.project
  metrics_service_name = var.project
}

# No table-access statement here: Postgres authenticates with the password in
# DATABASE_URL, not with IAM, so there is nothing to grant at the task-role
# level for the database itself.
data "aws_iam_policy_document" "task_metrics" {
  # PutMetricData supports no resource-level permissions, so resources must be
  # "*"; the cloudwatch:namespace condition is what keeps this task from
  # writing into any other namespace. src/cloudwatch.js is a verbatim fork of
  # the sibling's and publishes the same EventLoopUtilization metric.
  statement {
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [local.metrics_namespace]
    }
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "${var.project}-task-metrics"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_metrics.json
}

# The app container's environment, lifted out of the task definition so
# outputs.tf can publish every entry except DATABASE_URL. The task definition's
# container_definitions prints as (sensitive value) in a plan, because
# DATABASE_URL carries the password; the `app_environment` output is how the
# rest of the contract stays readable before an apply.
locals {
  # Every name here is fixed by plan 1's environment-variable contract
  # (service/src/config.js). A typo is not a validate error -- it is a default
  # silently standing in for the value Terraform meant to set.
  app_environment = [
    { name = "PORT", value = tostring(var.container_port) },
    { name = "AWS_REGION", value = data.aws_region.current.region },

    # The whole connection, password included. local.db_host is what knob 3
    # switches between the instance and the proxy (proxy.tf).
    { name = "DATABASE_URL", value = local.database_url },
    { name = "DB_SSL", value = "require" },

    # KNOB 1.
    { name = "POOL_MAX", value = tostring(var.pool_size) },
    { name = "POOL_CONNECTION_TIMEOUT_MS", value = tostring(var.pool_connection_timeout_ms) },

    # config.js's flag() is `env[key] === '1'`, and its num() treats '' as absent.
    # "0" would read as truthy to anyone skimming this and is not what the service
    # checks, so false is the empty string.
    { name = "MIGRATE_ON_BOOT", value = var.migrate_on_boot ? "1" : "" },
    { name = "SEED_ON_BOOT", value = var.seed_on_boot ? "1" : "" },
    { name = "SEED_ROWS", value = tostring(var.seed_rows) },
    { name = "SEED_FEEDS", value = tostring(var.seed_feeds) },

    { name = "FEED_PAGE_SIZE", value = tostring(var.feed_page_size) },

    # THE CALIBRATED COST KNOB. 0 until plan 3 measures it.
    { name = "REPORT_SCAN_ROWS", value = tostring(var.report_scan_rows) },
    { name = "REPORT_SLEEP_MS", value = tostring(var.report_sleep_ms) },

    { name = "OTLP_ENDPOINT", value = "http://collector.${aws_service_discovery_private_dns_namespace.internal.name}:4318" },
    { name = "METRICS_NAMESPACE", value = local.metrics_namespace },
    { name = "OTEL_SERVICE_NAME", value = local.metrics_service_name },

    # OTEL_SERVICE_INSTANCE_ID is DELIBERATELY ABSENT. The service resolves it from
    # the ECS task metadata endpoint; its last-resort fallback is
    # local-${process.pid}, and Node is pid 1 in every container. Setting a
    # constant here would collapse every task onto one series -- the exact failure
    # the attribute exists to prevent. It is an escape hatch, not something to wire.
  ]
}

resource "aws_ecs_task_definition" "app" {
  family                   = var.project
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "app"
    image     = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
    essential = true

    portMappings = [{
      containerPort = var.container_port
      protocol      = "tcp"
    }]

    # src/server.js flushes OpenTelemetry inside the server.close() callback, and
    # keepAliveTimeout is 65s. ECS's default stopTimeout is 30s, which can SIGKILL
    # the task mid-drain and lose the final export -- the very interval a
    # deploy or a scale-in is most likely to land in. 120s is the Fargate maximum.
    stopTimeout = var.stop_timeout_seconds

    environment = local.app_environment

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "app"
      }
    }
  }])
}

resource "aws_ecs_service" "app" {
  name            = var.project
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  # Deliberately no ignore_changes on desired_count. This project's measurement
  # depends on desired_count being a fixed number Terraform owns, so every run
  # is one deterministic configuration -- there is no autoscaler here to
  # disagree with it.
  desired_count = var.desired_count
  launch_type   = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "app"
    container_port   = var.container_port
  }

  # A task that will not pass the ALB health check is retried forever by default,
  # and `terraform apply` returns success while the old task definition is still
  # what is serving. The circuit breaker stops the deployment instead, and
  # rollback puts the last known-good task definition back -- so a bad image is a
  # failed apply, which is what it should look like.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.http]
}
