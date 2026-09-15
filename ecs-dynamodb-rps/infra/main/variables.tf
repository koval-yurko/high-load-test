variable "project" {
  description = "Project name. Also the AWS Project tag and the commit scope. Do not change."
  type        = string
  default     = "ecs-dynamodb-rps"
}

variable "aws_account_id" {
  description = "The AWS account this project belongs to. Checked against the credentials the run actually carries, by the precondition on aws_vpc.main. No default on purpose -- the value comes from the `high-load-test` variable set in HCP, so a workspace that is not attached to it fails loudly instead of skipping the check."
  type        = string
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "container_port" {
  type    = number
  default = 8080
}

variable "task_cpu" {
  description = "Fargate CPU units. 256 = 0.25 vCPU = 250ms of CPU per second."
  type        = number
  default     = 256
}

variable "task_memory" {
  type    = number
  default = 512
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "read_capacity" {
  description = "Provisioned RCU. Derived from slo.yaml via the capacity model; never guessed."
  type        = number
}

variable "write_capacity" {
  description = "Provisioned WCU. Derived from slo.yaml via the capacity model; never guessed."
  type        = number
}

variable "pbkdf2_iterations" {
  description = "CPU cost knob. Calibrated so the service ceiling lands at ~70% of the DB ceiling."
  type        = number
  default     = 0
}

variable "feed_page_size" {
  description = "Items per Query. Frozen at 20 — it sets the 2.5 RCU feed coefficient."
  type        = number
  default     = 20
}

variable "autoscaling_enabled" {
  type    = bool
  default = false
}

variable "autoscaling_max" {
  type    = number
  default = 15
}

variable "autoscaling_cpu_target" {
  type    = number
  default = 60
}

variable "requests_scaling_enabled" {
  description = "Gates the second (ALBRequestCountPerTarget) autoscaling policy on top of autoscaling_enabled. Default off: the baseline stress run (spike-response plan Task 4) must measure the CPU-only policy alone, and the Change 1 re-measure (Task 6) flips only this flag so the before/after comparison changes exactly one knob."
  type        = bool
  default     = false
}

variable "elu_scaling_enabled" {
  description = "Gates the event-loop-utilization alarm and step-scaling policy (Change 2) on top of autoscaling_enabled. Default off: the baseline and Change 1 runs must not have it, and the Change 2 re-measure (spike-response plan Task 8) flips only this flag. The ELU publisher, its IAM statement and its env vars are NOT gated -- publishing changes no scaling behaviour."
  type        = bool
  default     = false
}

variable "autoscaling_rps_target" {
  description = <<-EOT
    ALBRequestCountPerTarget target value, in requests per target per MINUTE
    (not per second) -- 6,000 = 100 rps/task. Run 8554820 only brackets
    per-task capacity between 100 and 200 rps/task; 6,000 is the conservative
    (100 rps/task) end of that bracket, chosen because it is unmeasured.
    Correction signal: the steady-state task count in the spike-response
    plan's Task 6 run -- if the fleet settles well under the traffic it
    should take, raise this value.
  EOT
  type        = number
  default     = 6000
}

variable "image_tag" {
  type    = string
  default = "latest"
}

variable "log_retention_days" {
  description = "Short. An implicitly-created log group survives destroy and bills forever."
  type        = number
  default     = 1
}

variable "collector_cpu" {
  description = "Collector task CPU units. Separate from the app task -- the whole point of a gateway collector is that it never draws on the app's 256."
  type        = number
  default     = 256
}

variable "collector_memory" {
  description = "Collector task memory (MiB). A starting point, not a measured size: YACE's CloudWatch polling is the memory risk."
  type        = number
  default     = 512
}

variable "alloy_image" {
  description = "Pinned. 'latest' would make the collector's behaviour change without a commit."
  type        = string
  default     = "grafana/alloy:v1.10.0"
}

variable "grafana_otlp_endpoint" {
  description = "Grafana Cloud OTLP gateway URL, e.g. https://otlp-gateway-<zone>.grafana.net/otlp"
  type        = string
}

variable "grafana_otlp_username" {
  description = "Grafana Cloud OTLP instance ID."
  type        = string
}

variable "grafana_otlp_password" {
  description = "Grafana Cloud access policy token, metrics:write scope only."
  type        = string
  sensitive   = true
}

variable "grafana_prom_url" {
  description = "Grafana Cloud Prometheus remote-write URL (the existing K6_PROMETHEUS_RW_SERVER_URL)."
  type        = string
}

variable "grafana_prom_username" {
  description = "Grafana Cloud Prometheus instance ID."
  type        = string
}

variable "grafana_prom_password" {
  description = "Grafana Cloud Prometheus password."
  type        = string
  sensitive   = true
}

variable "prometheus_datasource_uid" {
  description = "Grafana Cloud Prometheus datasource UID. Passed to the grafana module."
  type        = string
  default     = "grafanacloud-prom"
}

variable "cloudwatch_datasource_uid" {
  description = "Existing CloudWatch datasource, verified against this AWS account on 2026-08-30. Its defaultRegion is us-east-1, so every panel pins eu-central-1 itself."
  type        = string
  default     = "a4139e7c-dc84-47c8-b90b-d710ec0fe3fb"
}

variable "stop_timeout_seconds" {
  description = "Seconds ECS waits after SIGTERM before SIGKILL. The default (30s) can cut the app's server.close() drain short and lose the final OTLP flush; 120s is the Fargate maximum."
  type        = number
  default     = 120
}

variable "heartbeat_enabled" {
  description = "Whether EventBridge Scheduler invokes the heartbeat Lambda. On, the SLI has an idle population between load tests and burn-rate alerts can fire; off, the class ratio is no-data while nothing runs. Costs ~43k invocations/month, inside the Lambda free tier -- turn it off only when the environment will sit up and idle for days."
  type        = bool
  default     = true
}

variable "heartbeat_rate" {
  description = "Schedule expression for the heartbeat. One beat per minute is the cheapest rate that still gives every burn window a population; faster buys resolution the SLO does not need, slower leaves gaps that read as an outage."
  type        = string
  default     = "rate(1 minute)"
}
