# One variable per value that leaves .env for HCP. Sensitive ones are marked;
# nothing required has a default, AND every required string is validated non-empty:
# .envrc exports TF_VAR_x="${X:-}", so a value missing from .env arrives as "" rather
# than unset, and without the validation an apply would overwrite a working
# credential in HCP with an empty string (platform security review, 2026-09-24).

variable "tfc_organization" {
  type        = string
  description = "Terraform Cloud organization name. From TF_CLOUD_ORGANIZATION via .envrc -- the same value the cloud block reads, so the provider can never write into a different org than the one holding this stack's state. No default: the org name stays out of committed files, as versions.tf intends."

  validation {
    condition     = length(trimspace(var.tfc_organization)) > 0
    error_message = "tfc_organization is empty: set TF_CLOUD_ORGANIZATION in the root .env and run direnv allow."
  }
}

variable "tfc_project_name" {
  type        = string
  description = "Terraform Cloud project name. Shared by every workspace this stack manages."
  default     = "high-load-test"
}

# --- Non-secret values every project workspace gets, via the shared variable set ---
# Fed by TF_VAR_* from .envrc; never defaulted.

variable "aws_region" {
  type        = string
  description = "AWS region, forwarded into the shared variable set as AWS_REGION."

  validation {
    condition     = length(trimspace(var.aws_region)) > 0
    error_message = "aws_region is empty: set AWS_REGION in the root .env and run direnv allow."
  }
}

variable "aws_account_id" {
  type        = string
  description = "AWS account id, forwarded into the shared variable set as the aws_account_id Terraform variable. Also checked against the caller identity before this stack creates anything in AWS (aws.tf)."

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be the 12-digit AWS account id: set AWS_ACCOUNT_ID in the root .env and run direnv allow."
  }
}

variable "grafana_url" {
  type        = string
  description = "Grafana Cloud stack URL, forwarded into the shared variable set as GRAFANA_URL."

  validation {
    condition     = length(trimspace(var.grafana_url)) > 0
    error_message = "grafana_url is empty: set GRAFANA_URL in the root .env and run direnv allow."
  }
}

variable "grafana_stack_id" {
  type        = string
  description = "Grafana Cloud stack id, forwarded into the shared variable set as GRAFANA_STACK_ID."

  validation {
    condition     = length(trimspace(var.grafana_stack_id)) > 0
    error_message = "grafana_stack_id is empty: set GRAFANA_STACK_ID in the root .env and run direnv allow."
  }
}

variable "grafana_otlp_endpoint" {
  type        = string
  description = "Grafana Cloud OTLP gateway endpoint, forwarded as the grafana_otlp_endpoint Terraform variable."

  validation {
    condition     = length(trimspace(var.grafana_otlp_endpoint)) > 0
    error_message = "grafana_otlp_endpoint is empty: set GRAFANA_OTLP_ENDPOINT in the root .env and run direnv allow."
  }
}

variable "grafana_otlp_username" {
  type        = string
  description = "Grafana Cloud OTLP gateway username (numeric instance id), forwarded as the grafana_otlp_username Terraform variable."

  validation {
    condition     = length(trimspace(var.grafana_otlp_username)) > 0
    error_message = "grafana_otlp_username is empty: set GRAFANA_OTLP_USERNAME in the root .env and run direnv allow."
  }
}

variable "grafana_prom_url" {
  type        = string
  description = "Grafana Cloud Prometheus remote-write URL, forwarded as the grafana_prom_url Terraform variable."

  validation {
    condition     = length(trimspace(var.grafana_prom_url)) > 0
    error_message = "grafana_prom_url is empty: set K6_PROMETHEUS_RW_SERVER_URL in the root .env and run direnv allow."
  }
}

variable "grafana_prom_username" {
  type        = string
  description = "Grafana Cloud Prometheus remote-write username (numeric instance id), forwarded as the grafana_prom_username Terraform variable."

  validation {
    condition     = length(trimspace(var.grafana_prom_username)) > 0
    error_message = "grafana_prom_username is empty: set K6_PROMETHEUS_RW_USERNAME in the root .env and run direnv allow."
  }
}

# --- Secrets, written per workspace (tfc.tf, local.secrets) ------------------
# Only the workspaces that list a secret in local.projects receive it, and it is
# written with the write-only value_wo, so it never lands in this stack's state.
# There are no AWS keys here any more: remote runs assume a role through OIDC
# (aws.tf), and the IAM user keys in .env never leave the machine.

variable "grafana_auth" {
  type        = string
  sensitive   = true
  description = "Grafana Cloud service-account token, written as GRAFANA_AUTH to the project workspaces that list it."

  validation {
    condition     = length(trimspace(var.grafana_auth)) > 0
    error_message = "grafana_auth is empty: set GRAFANA_AUTH in the root .env and run direnv allow."
  }
}

variable "grafana_k6_access_token" {
  type        = string
  sensitive   = true
  description = "Grafana Cloud k6 access token, written as GRAFANA_K6_ACCESS_TOKEN to the project workspaces that list it."

  validation {
    condition     = length(trimspace(var.grafana_k6_access_token)) > 0
    error_message = "grafana_k6_access_token is empty: set GRAFANA_K6_ACCESS_TOKEN in the root .env and run direnv allow."
  }
}

variable "grafana_otlp_password" {
  type        = string
  sensitive   = true
  description = "Grafana Cloud OTLP gateway access policy token, written as the grafana_otlp_password Terraform variable to the project workspaces that list it."

  validation {
    condition     = length(trimspace(var.grafana_otlp_password)) > 0
    error_message = "grafana_otlp_password is empty: set GRAFANA_OTLP_PASSWORD in the root .env and run direnv allow."
  }
}

variable "grafana_prom_password" {
  type        = string
  sensitive   = true
  description = "Grafana Cloud Prometheus remote-write password, written as the grafana_prom_password Terraform variable to the project workspaces that list it."

  validation {
    condition     = length(trimspace(var.grafana_prom_password)) > 0
    error_message = "grafana_prom_password is empty: set K6_PROMETHEUS_RW_PASSWORD in the root .env and run direnv allow."
  }
}

# The k6 project limits that used to be declared here moved with the k6 project into
# each project's own infra/k6 module on 2026-09-14 (see
# docs/superpowers/specs/2026-09-14-ecs-dynamodb-rps-k6-project-ownership-design.md).

variable "db_password" {
  type        = string
  sensitive   = true
  description = "Database master password for ecs-rds-postgres-pool, from DB_PASSWORD in the root .env, written to that workspace only as the db_password Terraform variable."

  validation {
    condition     = length(trimspace(var.db_password)) > 0
    error_message = "db_password is empty: set DB_PASSWORD in the root .env and run direnv allow."
  }
}

# --- Grafana folder permissions (grafana.tf) ----------------------------------

variable "grafana_service_account_id" {
  type        = string
  description = "Numeric id of the Grafana service account whose token is GRAFANA_AUTH (Administration > Users and access > Service accounts; the id is the number in the account's URL). From GRAFANA_SERVICE_ACCOUNT_ID via .envrc. It is granted Admin on the high-load-test folder, which is how Terraform keeps managing the project folders under it once the Editor role is reduced to View."

  validation {
    condition     = can(regex("^[0-9]+$", var.grafana_service_account_id))
    error_message = "grafana_service_account_id must be the numeric service account id (not its name): set GRAFANA_SERVICE_ACCOUNT_ID in the root .env and run direnv allow."
  }
}

# --- Who can use the project workspaces, and who hears about it (tfc.tf) ------

variable "team_project_access" {
  type        = map(string)
  default     = {}
  description = "Team name => access level on the TFC project (read, write, maintain, admin). Anyone who can queue a plan on a project workspace can read what that workspace is given, so this map IS the list of who can read its Grafana tokens and assume its plan role. Empty means organization owners only -- the only team on the Free tier."

  validation {
    condition     = alltrue([for a in values(var.team_project_access) : contains(["read", "write", "maintain", "admin"], a)])
    error_message = "team_project_access values must be one of: read, write, maintain, admin."
  }
}

variable "run_notification_email" {
  type        = string
  default     = ""
  description = "Email of an organization member to notify when a run is created, needs attention or errors on any project workspace -- a plan nobody expected is the visible sign of someone reading a workspace's credentials. From TFC_NOTIFICATION_EMAIL via .envrc. Empty disables the notifications."
}
