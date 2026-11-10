variable "project" {
  description = "Project name. Also the AWS Project tag, the function, table and API name, and the commit scope. Do not change."
  type        = string
  default     = "lambda-concurrency-limit"
}

variable "aws_account_id" {
  description = "The AWS account this project belongs to. From the high-load-test variable set; no default, so a workspace without it fails loudly."
  type        = string
}

variable "expected_region" {
  description = "The only region where the concurrency facts in the spec hold: account limit 400, unreserved 352 (read 2026-11-09). us-east-1 has a limit of 10."
  type        = string
  default     = "eu-central-1"
}

# --- Knobs (spec, "Configuration — every switch") ---------------------------------------------

variable "reserved_concurrency" {
  description = "Knob 2. The function ALWAYS reserves concurrency, so a load test never drains the shared unreserved pool (352; other apps use it). AWS keeps 100 unreserved, so the ceiling is 252. Takes effect at apply; no deploy needed."
  type        = number
  default     = 20
  validation {
    condition     = var.reserved_concurrency >= 1 && var.reserved_concurrency <= 252 && floor(var.reserved_concurrency) == var.reserved_concurrency
    error_message = "reserved_concurrency must be a whole number in 1..252 (352 unreserved minus the 100 AWS keeps). Re-read aws lambda get-account-settings if other apps reserved more."
  }
}

variable "provisioned_concurrency" {
  description = "Knob 3. Provisioned concurrency on alias live; 0 = no resource. Billed per hour while it exists. Takes effect at apply."
  type        = number
  default     = 0
  validation {
    condition     = var.provisioned_concurrency >= 0 && var.provisioned_concurrency <= var.reserved_concurrency && floor(var.provisioned_concurrency) == var.provisioned_concurrency
    error_message = "provisioned_concurrency must be a whole number in 0..reserved_concurrency."
  }
}

variable "user_rate_limit_rps" {
  description = "Knob 1. Per-API-key throttle on the users usage plan (normal-1..4, noisy). 0 = no throttle. Burst is 2 x rate (spec: random arrivals need it). Takes effect at apply."
  type        = number
  default     = 0
  validation {
    condition     = var.user_rate_limit_rps >= 0 && floor(var.user_rate_limit_rps) == var.user_rate_limit_rps
    error_message = "user_rate_limit_rps must be a whole number >= 0."
  }
}

variable "anonymous_enabled" {
  description = "Creates the anonymous tier: /public/* routes without an API key, and a WAF rate-based rule per caller address. The WAF bills while it exists, so leave it false except while measuring."
  type        = bool
  default     = false
}

variable "anonymous_rate_limit" {
  description = "Anonymous tier: requests per address per anonymous_window_seconds before WAF blocks with 429. WAF minimum is 10."
  type        = number
  default     = 100
  validation {
    condition     = var.anonymous_rate_limit >= 10 && floor(var.anonymous_rate_limit) == var.anonymous_rate_limit
    error_message = "anonymous_rate_limit must be a whole number >= 10 (the WAF rate-based rule minimum)."
  }
}

variable "anonymous_window_seconds" {
  description = "Anonymous tier: the WAF evaluation window. WAF allows 60, 120, 300 or 600."
  type        = number
  default     = 60
  validation {
    condition     = contains([60, 120, 300, 600], var.anonymous_window_seconds)
    error_message = "anonymous_window_seconds must be 60, 120, 300 or 600."
  }
}

variable "anonymous_ip_source" {
  description = "Which address the WAF rule counts. \"forwarded\" = the first address in X-Forwarded-For, which THE CLIENT CONTROLS: a real client can dodge the limit by changing the header. It exists only so k6 can act as many callers. \"source\" = the real source address."
  type        = string
  default     = "forwarded"
  validation {
    condition     = contains(["forwarded", "source"], var.anonymous_ip_source)
    error_message = "anonymous_ip_source must be forwarded or source."
  }
}

variable "otel_enabled" {
  description = "OTel layers and wrapper on or off. Frozen into the published version: run deploy-service.sh --config-only after the apply."
  type        = bool
  default     = true
}

variable "trace_sample_ratio" {
  description = "OTEL_TRACES_SAMPLER_ARG. Frozen into the published version: deploy-service.sh --config-only after the apply."
  type        = number
  default     = 1
  validation {
    condition     = var.trace_sample_ratio >= 0 && var.trace_sample_ratio <= 1
    error_message = "trace_sample_ratio must be in 0..1."
  }
}

variable "otel_layer_version" {
  description = "Upstream open-telemetry/opentelemetry-lambda release, in the layer-name form (0_24_0). Frozen into the published version."
  type        = string
  default     = "0_24_0"
}

variable "memory_size" {
  description = "MB. Lambda gives CPU in proportion to memory, so this moves Duration. Frozen into the published version."
  type        = number
  default     = 512
  validation {
    condition     = var.memory_size >= 128 && var.memory_size <= 10240
    error_message = "memory_size must be in 128..10240."
  }
}

variable "heavy_cpu_iterations" {
  description = "CPU loop iterations on the heavy route (iterations, not ms, so memory changes show). Set in phase 0. Frozen into the published version."
  type        = number
  default     = 0
}

variable "sdk_max_attempts" {
  description = "AWS_MAX_ATTEMPTS for the bundled SDK (3.1164.0: default 3, standard mode). null = unset, the SDK default. Exploration only. Frozen into the published version."
  type        = number
  default     = null
}

variable "timeout_seconds" {
  description = "Function timeout. Below API Gateway's 29 s integration timeout. Frozen into the published version: run deploy-service.sh --config-only after the apply."
  type        = number
  default     = 10
}

variable "billing_mode" {
  description = "DynamoDB. PAY_PER_REQUEST for every comparison run; PROVISIONED is exploration. Provisioned -> on-demand at most 4 times in a rolling 24 h."
  type        = string
  default     = "PAY_PER_REQUEST"
  validation {
    condition     = contains(["PAY_PER_REQUEST", "PROVISIONED"], var.billing_mode)
    error_message = "billing_mode must be PAY_PER_REQUEST or PROVISIONED."
  }
}

variable "read_capacity" {
  description = "RCU when billing_mode = PROVISIONED (ignored otherwise). Decreases: 4 available, +1 per hour, 27 per day, so step upward."
  type        = number
  default     = 100
}

variable "write_capacity" {
  description = "WCU when billing_mode = PROVISIONED (ignored otherwise). The load writes nothing; the seed runs on-demand."
  type        = number
  default     = 5
}

variable "max_read_request_units" {
  description = "On-demand maximum read throughput (on_demand_throughput). null = no maximum. Exploration only."
  type        = number
  default     = null
}

variable "log_retention_days" {
  type    = number
  default = 7
}

# --- Grafana and OTLP (values from the shared variable set) ----------------------------------

variable "grafana_otlp_endpoint" {
  description = "Grafana Cloud OTLP gateway URL, e.g. https://otlp-gateway-<zone>.grafana.net/otlp. The collector's otlphttp exporter appends /v1/traces."
  type        = string
}

variable "grafana_otlp_username" {
  description = "Grafana Cloud OTLP instance ID."
  type        = string
}

variable "grafana_otlp_password" {
  description = "Grafana Cloud access policy token with traces:write. Reaches the function as GRAFANA_OTLP_AUTH (spec: accepted for a lab)."
  type        = string
  sensitive   = true
}

variable "cloudwatch_datasource_uid" {
  description = "Existing Grafana CloudWatch datasource, verified for this AWS account on 2026-08-30 (the siblings use it). Its default region is us-east-1, so every query pins eu-central-1."
  type        = string
  default     = "a4139e7c-dc84-47c8-b90b-d710ec0fe3fb"
}
