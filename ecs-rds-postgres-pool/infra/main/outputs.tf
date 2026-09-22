# Forked from ecs-dynamodb-rps/infra/main/outputs.tf on 2026-09-21.
# A bug fixed here does not reach the sibling copy; fix both.
output "base_url" {
  description = "Target for k6. /loadtest reads this, never a remembered URL."
  value       = "http://${aws_lb.main.dns_name}"
}

output "k6_project_id" {
  description = "Grafana Cloud k6 project id. The project is created and destroyed with this environment, so the id changes after every /env down + /env up: read it with `terraform output -json` (never -raw) when it is needed, never copy it into .env or a README."
  value       = module.k6.k6_project_id
}

# The endpoint only -- host:port, no credentials. local.database_url is deliberately
# NOT an output: it carries the password, and outputs are stored in state and
# printed by `terraform output`.
output "db_endpoint" {
  description = "The RDS instance's host:port, for psql during a session. Always the instance, never the proxy, whatever proxy_enabled says."
  value       = aws_db_instance.main.endpoint
}

# Every app container environment entry except DATABASE_URL, which carries the
# password. Built by name filter from local.app_environment, so the password's
# element never enters this map and the output stays non-sensitive: the
# container_definitions it comes from prints as (sensitive value) in a plan.
# Copy-paste connection command, without the password: psql prompts for it, and
# it is DB_PASSWORD in the root .env (D7).
output "psql" {
  description = "psql command for the instance. Prompts for the password: DB_PASSWORD in the root .env."
  value       = "psql \"host=${aws_db_instance.main.address} port=5432 dbname=${var.db_name} user=${var.db_username} sslmode=require\""
}

output "app_environment" {
  description = "The app container's environment, name -> value, minus DATABASE_URL. Answers 'what does the service run with' from plan output without printing the password."
  value       = { for e in local.app_environment : e.name => e.value if e.name != "DATABASE_URL" }
}

output "database_target" {
  description = "Where DATABASE_URL points: \"proxy\" when proxy_enabled (knob 3), else \"instance\". The URL itself is sensitive; this is its non-secret half."
  value       = var.proxy_enabled ? "proxy" : "instance"
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "service_name" {
  value = aws_ecs_service.app.name
}

output "knobs" {
  description = "The knob positions and measurement parameters, recorded on every results.md row so a number can always be traced to the configuration that produced it."
  value = {
    pool_size        = var.pool_size
    desired_count    = var.desired_count
    proxy_enabled    = var.proxy_enabled
    instance_class   = var.instance_class
    report_scan_rows = var.report_scan_rows
    seed_rows        = var.seed_rows
  }
}

output "collector_endpoint" {
  description = "OTLP endpoint the app tasks export to. It must match the OTLP_ENDPOINT ecs.tf sets on the app container."
  value       = "http://collector.${aws_service_discovery_private_dns_namespace.internal.name}:4318"
}

output "collector_service_name" {
  value = aws_ecs_service.collector.name
}

output "heartbeat_function_name" {
  description = "Idle-population Lambda. `aws logs tail /aws/lambda/<name>` shows whether beats are landing."
  value       = aws_lambda_function.heartbeat.function_name
}
