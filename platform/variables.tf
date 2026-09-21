# One variable per value that leaves .env for HCP. Sensitive ones are marked;
# secrets have no default, so a missing TF_VAR_* fails loudly instead of running
# with an empty string.

variable "tfc_organization" {
  type        = string
  description = "Terraform Cloud organization name."
  default     = "failwin"
}

variable "tfc_project_name" {
  type        = string
  description = "Terraform Cloud project name. Shared by every workspace this stack manages."
  default     = "high-load-test"
}

# --- What every project workspace needs, via the shared variable set --------
# Fed by TF_VAR_* from .envrc; never defaulted.

variable "aws_access_key_id" {
  type        = string
  sensitive   = true
  description = "AWS access key id, forwarded into the shared variable set as AWS_ACCESS_KEY_ID."
}

variable "aws_secret_access_key" {
  type        = string
  sensitive   = true
  description = "AWS secret access key, forwarded into the shared variable set as AWS_SECRET_ACCESS_KEY."
}

variable "aws_region" {
  type        = string
  description = "AWS region, forwarded into the shared variable set as AWS_REGION."
}

variable "aws_account_id" {
  type        = string
  description = "AWS account id, forwarded into the shared variable set as the aws_account_id Terraform variable."
}

variable "grafana_url" {
  type        = string
  description = "Grafana Cloud stack URL, forwarded into the shared variable set as GRAFANA_URL."
}

variable "grafana_auth" {
  type        = string
  sensitive   = true
  description = "Grafana Cloud service-account token, forwarded into the shared variable set as GRAFANA_AUTH."
}

variable "grafana_k6_access_token" {
  type        = string
  sensitive   = true
  description = "Grafana Cloud k6 access token, forwarded into the shared variable set as GRAFANA_K6_ACCESS_TOKEN."
}

variable "grafana_stack_id" {
  type        = string
  description = "Grafana Cloud stack id, forwarded into the shared variable set as GRAFANA_STACK_ID."
}

variable "grafana_otlp_endpoint" {
  type        = string
  description = "Grafana Cloud OTLP gateway endpoint, forwarded as the grafana_otlp_endpoint Terraform variable."
}

variable "grafana_otlp_username" {
  type        = string
  description = "Grafana Cloud OTLP gateway username (numeric instance id), forwarded as the grafana_otlp_username Terraform variable."
}

variable "grafana_otlp_password" {
  type        = string
  sensitive   = true
  description = "Grafana Cloud OTLP gateway access policy token, forwarded as the grafana_otlp_password Terraform variable."
}

variable "grafana_prom_url" {
  type        = string
  description = "Grafana Cloud Prometheus remote-write URL, forwarded as the grafana_prom_url Terraform variable."
}

variable "grafana_prom_username" {
  type        = string
  description = "Grafana Cloud Prometheus remote-write username (numeric instance id), forwarded as the grafana_prom_username Terraform variable."
}

variable "grafana_prom_password" {
  type        = string
  sensitive   = true
  description = "Grafana Cloud Prometheus remote-write password, forwarded as the grafana_prom_password Terraform variable."
}

# The k6 project limits that used to be declared here moved with the k6 project into
# each project's own infra/k6 module on 2026-09-14 (see
# docs/superpowers/specs/2026-09-14-ecs-dynamodb-rps-k6-project-ownership-design.md).

variable "db_password" {
  type        = string
  sensitive   = true
  description = "Database master password for ecs-rds-postgres-pool, from DB_PASSWORD in the root .env, forwarded as the db_password Terraform variable."
}
