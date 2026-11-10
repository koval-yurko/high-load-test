variable "project" {
  type = string
}

variable "cloudwatch_datasource_uid" {
  description = "Existing CloudWatch datasource. Its default region is us-east-1, so every query pins eu-central-1."
  type        = string
}

variable "function_name" {
  type = string
}

variable "alias_name" {
  type = string
}

variable "api_name" {
  type = string
}

variable "stage_name" {
  type = string
}

variable "table_name" {
  type = string
}

variable "anonymous_enabled" {
  description = "Adds the rate-limiting row (WAF blocked requests) to the dashboard."
  type        = bool
  default     = false
}

variable "web_acl_name" {
  description = "The WAF web ACL name, a dimension of the BlockedRequests metric. Used only when anonymous_enabled."
  type        = string
  default     = ""
}

variable "reserved_concurrency" {
  description = "Drawn as the ceiling line on the concurrency panel."
  type        = number
}

variable "provisioned_concurrency" {
  description = "The 'left on' rule exists only while this is > 0."
  type        = number
}

variable "unreserved_alert" {
  description = "Account UnreservedConcurrentExecutions above this fires. 50% of the 352 unreserved (read 2026-11-09): the other apps in the account run from that pool, and this project's function always has reserved concurrency, so it should never fire."
  type        = number
  default     = 176
}

variable "alert_contact_point" {
  description = "Name of the EXISTING Grafana contact point. Not managed here; a typo fails at apply."
  type        = string
  default     = "Slack - Kovalchuk & Co"
}
