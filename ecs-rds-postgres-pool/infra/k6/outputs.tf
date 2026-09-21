# Forked from ecs-dynamodb-rps/infra/k6/outputs.tf on 2026-09-21.
# A bug fixed here does not reach the sibling copy; fix both.
output "k6_project_id" {
  description = "Id of the Grafana Cloud k6 project this module creates. New on every apply after a teardown -- read it from terraform output at the moment of use, never copy it."
  value       = grafana_k6_project.this.id
}
