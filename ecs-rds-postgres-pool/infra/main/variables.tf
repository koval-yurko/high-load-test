# Forked from ecs-dynamodb-rps/infra/main/variables.tf on 2026-09-21.
# A bug fixed here does not reach the sibling copy; fix both.
variable "project" {
  description = "Project name. Also the AWS Project tag and the commit scope. Do not change."
  type        = string
  default     = "ecs-rds-postgres-pool"
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

variable "feed_page_size" {
  description = "Items per feed page. Frozen at 20 for continuity with the sibling project; no RCU coefficient applies here."
  type        = number
  default     = 20
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
  description = "Collector task memory (MiB). A starting point, not a measured size: the collector only receives OTLP and forwards it, and the batch processor's unsent samples are what it holds."
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

variable "instance_class" {
  description = "RDS instance class. db.t4g.micro is deliberate: its ~112 connection ceiling is what knob 2 aims at, and a larger class raises that ceiling along with memory, which takes the proxy phase's point away."
  type        = string
  default     = "db.t4g.micro"
}

variable "allocated_storage" {
  description = "gp3 storage in GiB. This sizes the disk, not the measurement -- seed_rows governs the working set."
  type        = number
  default     = 20
}

variable "db_name" {
  type    = string
  default = "app"
}

variable "db_username" {
  type    = string
  default = "app"
}

variable "db_password" {
  description = "The database master password (plan decision D7). From DB_PASSWORD in the root .env, delivered to remote runs by the shared HCP variable set (platform/tfc.tf) -- never in a tfvars file. It is the only thing guarding a port open to the internet (network.tf), and it goes into DATABASE_URL verbatim, hence the rules below."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[A-Za-z0-9_.~-]{20,128}$", var.db_password))
    error_message = "db_password must be 20-128 characters from A-Z a-z 0-9 _ . ~ - : long enough to face the internet, and URL-safe because it is interpolated into DATABASE_URL. Generate one with: openssl rand -hex 24"
  }
}

variable "pool_size" {
  description = "KNOB 1. Pool.max in the service. The baseline is 5, which is what makes the pool bind before the database does; knob 1 releases it to 25."
  type        = number
  default     = 5
}

variable "pool_connection_timeout_ms" {
  description = "How long a request waits for a connection before failing, so a saturated pool produces 5xx the availability objective catches rather than an unbounded queue visible only as latency. NO DEFAULT ON PURPOSE (plan decision D5): the right value is the heavy class threshold plus a margin, and that threshold does not exist until plan 3. dev.tfvars carries a labelled placeholder until then."
  type        = number
}

variable "proxy_enabled" {
  description = "KNOB 3. Creates the RDS Proxy, its Secrets Manager secret and its IAM role, and switches the service's database host to the proxy endpoint. Roughly 40% of the idle bill while on -- run it last and destroy it promptly."
  type        = bool
  default     = false
}

variable "seed_rows" {
  description = "A MEASUREMENT PARAMETER. seed_rows x ~1 KB must stay inside shared_buffers (about a quarter of the instance's 1 GiB), or a fast query becomes random reads from gp3 and the first run of a session differs from the second by an order of magnitude."
  type        = number
  default     = 50000
}

variable "seed_feeds" {
  type    = number
  default = 16
}

variable "report_scan_rows" {
  description = "THE CALIBRATED COST KNOB: how many rows the heavy route aggregates over. 0 means the aggregate returns immediately, so an uncalibrated environment never runs a workload nobody chose. Plan 3's calibration sets it."
  type        = number
  default     = 0
}

variable "report_sleep_ms" {
  description = "THE SECOND HALF OF THE CALIBRATED KNOB: how long the heavy route's single statement waits, in milliseconds, beside the CPU cost report_scan_rows sets. The two are separate because the pool must bind while the database still has CPU headroom, and a purely CPU-bound hold puts 5 connections at ~2.5x this instance's 2 vCPUs before the pool of 5 ever binds (plan 3, decision D1). 0 means uncalibrated: pg_sleep(0) returns immediately."
  type        = number
  default     = 0
}

variable "migrate_on_boot" {
  description = "Runs prisma migrate deploy at container start. Safe on every task: Prisma Migrate takes a Postgres advisory lock, so a rolling deploy does not race itself."
  type        = bool
  default     = true
}

variable "seed_on_boot" {
  description = "Runs the seed at container start. NOT idempotent and NOT lock-guarded: posts has no unique constraint beyond its primary key, so two tasks booting with this set insert twice the rows and a redeploy doubles them again. One task, one shot, then back to false."
  type        = bool
  default     = false
}

variable "max_connections_alert" {
  description = "DatabaseConnections above this fires the ceiling rule. Derived, not measured: knob 2 runs 25 x 4 = 100 connections against an instance ceiling ESTIMATED at ~112 from RDS's default formula (RDS derives the max_connections default from the instance class's memory). Confirm the real ceiling with SHOW max_connections on the instance before knob 2, and re-derive this from it."
  type        = number
  default     = 100
}

variable "proxy_borrow_latency_threshold" {
  description = "Fires the borrow-latency rule above this value. NULL BY DEFAULT ON PURPOSE: the metric's unit is not reliably documented -- AWS gives a sibling proxy metric in microseconds while community reports discuss borrow latency in milliseconds, and a 1000x error is silent and looks like a spectacular result. Confirm the unit in the CloudWatch console on the real proxy, then set this. Knob 3 refuses to plan until it is set."
  type        = number
  default     = null
}
