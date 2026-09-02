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

variable "k6_project_id" {
  description = "Grafana Cloud k6 project holding this scenario's uploaded load tests."
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

# Defaults are the LIVE values, read by importing the existing object on
# 2026-09-01. Changing one changes the real limit -- these are not placeholders.
variable "k6_vu_max_per_test" {
  description = "Max concurrent VUs one test may request. NOT the cap behind the E2004 upload rejection -- see grafana/k6.tf."
  type        = number
  default     = 25000
}

variable "k6_vu_browser_max_per_test" {
  description = "Max concurrent browser VUs per test. Unused by this project; set so it is not reset to null."
  type        = number
  default     = 1000
}

variable "k6_vuh_max_per_month" {
  description = "Monthly virtual-user-hour allowance. Spec section 10 names VU-hours as the binding budget for how often the load runs can be repeated."
  type        = number
  default     = 50000
}

variable "k6_duration_max_per_test" {
  description = "Max duration of a single test, seconds. Discovery ramps for 900s, well inside this."
  type        = number
  default     = 18000
}
