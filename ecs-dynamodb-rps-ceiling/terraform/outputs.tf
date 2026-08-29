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
