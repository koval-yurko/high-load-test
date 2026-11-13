output "base_url" {
  description = "Target for k6: https://<id>.execute-api.eu-central-1.amazonaws.com/dev. New on every rebuild; read it with terraform output -json at the moment of use."
  value       = aws_api_gateway_stage.dev.invoke_url
}

output "k6_project_id" {
  description = "Grafana Cloud k6 project id. New after every /env down + /env up: read with terraform output -json, never copy."
  value       = module.k6.k6_project_id
}

output "function_name" {
  value = aws_lambda_function.app.function_name
}

output "alias_name" {
  value = aws_lambda_alias.live.name
}

output "table_name" {
  value = aws_dynamodb_table.items.name
}

output "api_keys" {
  description = "user -> API key value. Read by scripts/upload-k6.sh. Identifies a test user only; not authentication."
  value       = { for k, v in aws_api_gateway_api_key.user : k => v.value }
  sensitive   = true
}

output "knobs" {
  description = "Recorded in results.md next to every run. deploy-service.sh reads provisioned_concurrency."
  value = {
    reserved_concurrency           = var.reserved_concurrency
    provisioned_concurrency        = var.provisioned_concurrency
    user_rate_limit_requests       = var.user_rate_limit_requests
    user_rate_limit_window_seconds = var.user_rate_limit_window_seconds
    anonymous_enabled              = var.anonymous_enabled
    anonymous_rate_limit           = var.anonymous_rate_limit
    anonymous_window_secs          = var.anonymous_window_seconds
    anonymous_ip_source            = var.anonymous_ip_source
    otel_enabled                   = var.otel_enabled
    trace_sample_ratio             = var.trace_sample_ratio
    memory_size                    = var.memory_size
    heavy_cpu_iterations           = var.heavy_cpu_iterations
    sdk_max_attempts               = var.sdk_max_attempts
    billing_mode                   = var.billing_mode
    read_capacity                  = var.billing_mode == "PROVISIONED" ? var.read_capacity : null
    max_read_request_units         = var.max_read_request_units
  }
}

output "cloudwatch_dashboard_url" {
  value = "https://${data.aws_region.current.region}.console.aws.amazon.com/cloudwatch/home?region=${data.aws_region.current.region}#dashboards/dashboard/${aws_cloudwatch_dashboard.main.dashboard_name}"
}

output "grafana_dashboard_url" {
  value = module.grafana.dashboard_url
}
