# Forked from ecs-dynamodb-rps/infra/main/collector.tf on 2026-09-21.
# A bug fixed here does not reach the sibling copy; fix both.

# One collector for the cluster, not a sidecar per task. Fargate's CPU limit is
# per TASK, so a sidecar would draw on the app task's own allocation -- the very
# CPU the measurement attributes to the service -- and would run once per task,
# so knob 2's four tasks would mean four collectors.
#
# This diverges from Grafana's documented ECS pattern, which is a sidecar in each
# application task definition. The divergence is deliberate, and it costs two
# things the sidecar would not need: the OTLP receiver is reached over the VPC
# rather than loopback, so it needs the Cloud Map record below and a
# security-group rule, and Alloy must run with --stability.level=experimental for
# the native OTLP receiver path. Decided for the sibling project in
# docs/superpowers/specs/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection-design.md
# (its decision on a cluster gateway collector, and its section on diverging
# from Grafana's pattern); the reasoning carries over unchanged.

resource "aws_service_discovery_private_dns_namespace" "internal" {
  name        = "${var.project}.local"
  description = "Service discovery for the metrics collector"
  vpc         = aws_vpc.main.id
}

resource "aws_service_discovery_service" "collector" {
  name = "collector"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.internal.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }
}

resource "aws_security_group" "collector" {
  name        = "${var.project}-collector"
  description = "Collector accepts OTLP only from the app tasks"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 4317
    to_port         = 4318
    protocol        = "tcp"
    security_groups = [aws_security_group.task.id]
  }

  # Outbound to Grafana Cloud. No NAT gateway exists, so the task carries a
  # public IP and egresses through the internet gateway.
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project}-collector"
  }
}

resource "aws_cloudwatch_log_group" "collector" {
  name              = "/ecs/${var.project}-collector"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "collector_task" {
  name               = "${var.project}-collector-task"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_tasks.json
}

# No CloudWatch-read policy here. The sibling's collector scraped DynamoDB's
# SuccessfulRequestLatency to subtract the datastore's own server-side clock
# from the service's db histogram; Postgres publishes no equivalent per-
# operation server-side latency, so there is nothing to poll and the task role
# grants nothing beyond what pipeline 1 (OTLP forwarding) needs -- which is
# nothing at all, since it authenticates outbound with the OTLP credentials in
# its container environment, not with IAM.

# Grafana Cloud OTLP write token, held in SSM and pulled by ECS at task start.
# The value still lives in Terraform Cloud state, as every sensitive variable
# does; what this removes is the copy in the task definition that any ECS
# reader could see. Standard-tier SecureString parameters are free, and the
# default aws/ssm key lets SSM decrypt on the caller's behalf, so no
# kms:Decrypt grant is needed.
resource "aws_ssm_parameter" "otlp_password" {
  name  = "/${var.project}/collector/otlp_password"
  type  = "SecureString"
  value = var.grafana_otlp_password
}

# The EXECUTION role fetches secrets, not the task role: ECS resolves `secrets`
# before the container exists, using the role it pulls the image with.
data "aws_iam_policy_document" "collector_secrets" {
  statement {
    actions = ["ssm:GetParameters"]
    resources = [
      aws_ssm_parameter.otlp_password.arn,
    ]
  }
}

resource "aws_iam_role_policy" "execution_collector_secrets" {
  name   = "${var.project}-collector-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.collector_secrets.json
}

locals {
  # OTTL statements, one per route template, generated from slo.yaml by
  # `npm run slo:generate`. Sorted so the rendered config is stable across plans
  # and a diff means a real change.
  alloy_class_statements = join("\n", [
    for template, class in jsondecode(file("${path.module}/../grafana/classmap.json")) :
    format("      `set(attributes[\"class\"], \"%s\") where attributes[\"http.route\"] == \"%s\"`,", class, template)
  ])

  alloy_config = templatefile("${path.module}/../grafana/alloy.alloy.tftpl", {
    class_statements = local.alloy_class_statements
    region           = data.aws_region.current.region
    project          = var.project
  })
}

resource "aws_ecs_task_definition" "collector" {
  family                   = "${var.project}-collector"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.collector_cpu
  memory                   = var.collector_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.collector_task.arn

  container_definitions = jsonencode([{
    name      = "alloy"
    image     = var.alloy_image
    essential = true

    # Alloy does not read ALLOY_CONFIG_CONTENT itself. This is Grafana's own
    # documented ECS pattern: write the variable to a file, then exec.
    # --stability.level=experimental is REQUIRED for the native OTLP receiver
    # path, not a nicety.
    entryPoint = ["/bin/sh", "-c"]
    command = [
      "printenv ALLOY_CONFIG_CONTENT > /tmp/config.alloy && exec /bin/alloy run --stability.level=experimental --server.http.listen-addr=0.0.0.0:12345 /tmp/config.alloy"
    ]

    # The batch processor holds unsent samples until its next flush. On SIGTERM
    # Alloy drains it; the 30s ECS default can cut that short and the
    # loss lands in the same measurement window the app's flush is protecting.
    stopTimeout = var.stop_timeout_seconds

    portMappings = [
      { containerPort = 4317, protocol = "tcp" },
      { containerPort = 4318, protocol = "tcp" },
    ]

    environment = [
      { name = "ALLOY_CONFIG_CONTENT", value = local.alloy_config },
      { name = "OTLP_ENDPOINT", value = var.grafana_otlp_endpoint },
      { name = "OTLP_USERNAME", value = var.grafana_otlp_username },
    ]

    # The write token, injected by ECS at task start from SSM. As a plain
    # `environment` entry it was readable by anyone with
    # ecs:DescribeTaskDefinition. `sensitive = true` on the variable protects the
    # plan output and nothing else.
    secrets = [
      { name = "OTLP_PASSWORD", valueFrom = aws_ssm_parameter.otlp_password.arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.collector.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "alloy"
      }
    }
  }])
}

resource "aws_ecs_service" "collector" {
  name            = "${var.project}-collector"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.collector.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.collector.id]
    assign_public_ip = true
  }

  service_registries {
    registry_arn = aws_service_discovery_service.collector.arn
  }

  # Same reason as the app service: a collector that crash-loops on a bad Alloy
  # config would otherwise be retried silently while the apply reports success,
  # and the first symptom would be the SLI going flat.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}
