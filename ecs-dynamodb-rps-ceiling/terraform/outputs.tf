output "base_url" {
  description = "Target for k6. /loadtest reads this, never a remembered URL."
  value       = "http://${aws_lb.main.dns_name}"
}

output "table_name" {
  value = aws_dynamodb_table.items.name
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

output "provisioned_capacity" {
  description = "Recorded in results.md alongside every run."
  value = {
    read_capacity  = aws_dynamodb_table.items.read_capacity
    write_capacity = aws_dynamodb_table.items.write_capacity
  }
}

output "collector_endpoint" {
  description = "OTLP endpoint the app tasks export to. Task 12 verifies traffic reaches it."
  value       = "http://collector.${aws_service_discovery_private_dns_namespace.internal.name}:4318"
}

output "collector_service_name" {
  value = aws_ecs_service.collector.name
}

output "heartbeat_function_name" {
  description = "Idle-population Lambda. `aws logs tail /aws/lambda/<name>` shows whether beats are landing."
  value       = aws_lambda_function.heartbeat.function_name
}
