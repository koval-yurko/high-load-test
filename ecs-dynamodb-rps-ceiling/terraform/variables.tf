variable "project" {
  description = "Project name. Also the AWS Project tag and the commit scope. Do not change."
  type        = string
  default     = "ecs-dynamodb-rps-ceiling"
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

variable "autoscaling_min" {
  type    = number
  default = 1
}

variable "autoscaling_max" {
  type    = number
  default = 4
}

variable "autoscaling_cpu_target" {
  type    = number
  default = 60
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
