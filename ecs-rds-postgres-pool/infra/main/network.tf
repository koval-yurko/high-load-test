# Forked from ecs-dynamodb-rps/infra/main/network.tf on 2026-09-21.
# A bug fixed here does not reach the sibling copy; fix both.

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = var.project
  }

  # The account check lives HERE because every other resource in this root module
  # hangs off the VPC, directly or transitively. A precondition on the resource
  # everything depends on fails the PLAN, before a single create is proposed --
  # so a run carrying the wrong credentials shows one error instead of a
  # forty-resource plan against somebody else's account.
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.aws_account_id
      error_message = "Refusing to plan against account ${data.aws_caller_identity.current.account_id}; this project belongs to ${var.aws_account_id}. Check which credentials the run carries."
    }
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = var.project
  }
}

# Public subnets only. Tasks get public IPs so the ECR pull works without a NAT
# gateway (~$32/mo, and the most common teardown survivor).
resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.project}-public-${count.index}"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${var.project}-public"
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "alb" {
  name        = "${var.project}-alb"
  description = "Public ingress for the load balancer"
  vpc_id      = aws_vpc.main.id

  # Grafana Cloud k6 generators arrive from the public internet.
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project}-alb"
  }
}

resource "aws_security_group" "task" {
  name        = "${var.project}-task"
  description = "Tasks accept traffic only from the ALB"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project}-task"
  }
}

# Open to any address on 5432, guarded by the password (var.db_password, from
# DB_PASSWORD in the root .env) and TLS forced by rds.force_ssl -- a deliberate
# lab trade, decision D7 in the infrastructure plan: psql from anywhere during a
# session, no NAT gateway, no per-machine IP file. Public accessibility is what
# avoids the NAT gateway -- both the largest line on the bill and the most common
# teardown survivor.
#
# The one rule also admits the tasks and RDS Proxy, whose ENIs sit in this same
# group (proxy.tf). IF THIS IS EVER NARROWED, add back an ingress from the task
# group AND `self = true`: without the self rule the proxy cannot reach the
# instance, plan and apply both succeed, and the proxy target stays UNAVAILABLE
# once knob 3 is flipped.
resource "aws_security_group" "db" {
  name        = "${var.project}-db"
  description = "Database accepts 5432 from any address; the password and forced TLS guard it"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project}-db"
  }
}
