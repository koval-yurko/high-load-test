# Forked from ecs-dynamodb-rps/infra/grafana/variables.tf on 2026-09-21.
# A bug fixed here does not reach the sibling copy; fix both.
variable "project" {
  type = string
}

variable "prometheus_datasource_uid" {
  description = "Grafana Cloud Prometheus datasource holding the service-emitted native histograms."
  type        = string
}

variable "cloudwatch_datasource_uid" {
  description = "Existing CloudWatch datasource, verified against this AWS account. Default region is us-east-1, so panels pin eu-central-1 themselves."
  type        = string
}

# CloudWatch dimension values for the ALB panels. These used to be literal ARN
# suffixes in dashboard.json.tftpl; a destroy + recreate gives both a new suffix
# and every ALB panel went silently empty. The root module passes the live
# attributes, so the dashboard always names the load balancer that exists.
variable "alb_arn_suffix" {
  description = "aws_lb.main.arn_suffix, e.g. app/<name>/<id>. The LoadBalancer dimension."
  type        = string
}

variable "target_group_arn_suffix" {
  description = "aws_lb_target_group.app.arn_suffix, e.g. targetgroup/<name>/<id>. The TargetGroup dimension."
  type        = string
}

# Where the burn-rate and canary rules route. The contact point is NOT managed
# here: it is the one the stack already has, and Grafana rejects a rule whose
# contact point does not exist, so a typo fails at apply rather than at 3am.
variable "alert_contact_point" {
  description = "Name of the EXISTING Grafana contact point the alert rules route to."
  type        = string
  default     = "Slack - Kovalchuk & Co"
}

variable "proxy_enabled" {
  description = "Mirrors the root module's knob 3. The two proxy rules exist only while the proxy does, so they do not sit in NO DATA permanently."
  type        = bool
}

variable "max_connections_alert" {
  description = "DatabaseConnections above this fires the ceiling rule. Derived, not measured: knob 2 runs 25 x 4 = 100 connections against an instance ceiling ESTIMATED at ~112 from RDS's default formula (RDS derives the max_connections default from the instance class's memory). Confirm the real ceiling with SHOW max_connections on the instance before knob 2, and re-derive this from it."
  type        = number
}

variable "proxy_borrow_latency_threshold" {
  description = "Fires the borrow-latency rule above this value. NULL BY DEFAULT ON PURPOSE: the metric's unit is not reliably documented -- AWS gives a sibling proxy metric in microseconds while community reports discuss borrow latency in milliseconds, and a 1000x error is silent and looks like a spectacular result. Confirm the unit in the CloudWatch console on the real proxy, then set this. Knob 3 refuses to plan until it is set."
  type        = number
  default     = null
}
