# Forked from ecs-dynamodb-rps/infra/k6/variables.tf on 2026-09-21.
# A bug fixed here does not reach the sibling copy; fix both.
variable "project" {
  description = "Project name. Also the NAME this module gives the Grafana Cloud k6 project it creates."
  type        = string
}

# --- k6 project limits -------------------------------------------------------
# The LIVE values read by importing the hand-made project on 2026-09-01; an unset
# attribute is sent as null and resets the live value, so all four stay explicit
# forever. See the comment on grafana_k6_project_limits in main.tf.

variable "vu_max_per_test" {
  type        = number
  description = "Max virtual users per k6 test."
  default     = 25000
}

variable "vu_browser_max_per_test" {
  type        = number
  description = "Max browser virtual users per k6 test."
  default     = 1000
}

variable "vuh_max_per_month" {
  type        = number
  description = "Max virtual-user-hours per month."
  default     = 50000
}

variable "duration_max_per_test" {
  type        = number
  description = "Max duration (seconds) per k6 test."
  default     = 18000
}
