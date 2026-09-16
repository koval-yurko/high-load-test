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
# Read by the task's environment, the IAM condition below and the alarm in
# alerts.tf: a mismatched namespace or dimension matches no metric and sits in
# INSUFFICIENT_DATA forever, without an error anywhere.
locals {
  metrics_namespace    = var.project
  metrics_service_name = var.project
}

data "aws_iam_policy_document" "table_access" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:BatchWriteItem"]
    resources = [aws_dynamodb_table.items.arn]
  }

  # PutMetricData supports no resource-level permissions, so resources must be
  # "*"; the cloudwatch:namespace condition is what keeps this task from
  # writing into any other namespace. Not gated by elu_scaling_enabled:
  # publishing changes no behaviour. (Lives in the policy still named
  # "table-access" -- renaming it would replace the policy for a cosmetic
  # reason.)
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
  name   = "${var.project}-table-access"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.table_access.json
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

    environment = concat([
      { name = "PORT", value = tostring(var.container_port) },
      { name = "TABLE_NAME", value = aws_dynamodb_table.items.name },
      { name = "AWS_REGION", value = data.aws_region.current.region },
      { name = "PBKDF2_ITERATIONS", value = tostring(var.pbkdf2_iterations) },
      { name = "FEED_PAGE_SIZE", value = tostring(var.feed_page_size) },
      { name = "OTLP_ENDPOINT", value = "http://collector.${aws_service_discovery_private_dns_namespace.internal.name}:4318" },
      # Sets the publisher on (src/config.js: absent => no publisher). Set
      # explicitly rather than relying on the service's defaults, because the
      # alarm in alerts.tf must match these values exactly. OTEL_SERVICE_NAME
      # is also the OTel service.name; its value equals the service's default.
      { name = "METRICS_NAMESPACE", value = local.metrics_namespace },
      { name = "OTEL_SERVICE_NAME", value = local.metrics_service_name },
      ],
      # The service sheds only when this variable is present (src/config.js).
      var.shedding_enabled ? [
        { name = "SHED_ELU_THRESHOLD", value = tostring(var.shed_elu_threshold) },
      ] : [],
    )

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
  # Deliberately no ignore_changes on desired_count. When this value and the
  # Application Auto Scaling floor (autoscaling.tf min_capacity) disagree,
  # Auto Scaling wins silently -- it adjusts desired_count outside Terraform
  # and the next plan shows no diff. min_capacity derives from
  # var.desired_count instead of a separate variable so there is one number
  # instead of two that can drift.
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
