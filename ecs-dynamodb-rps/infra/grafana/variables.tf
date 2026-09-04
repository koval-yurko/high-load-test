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
