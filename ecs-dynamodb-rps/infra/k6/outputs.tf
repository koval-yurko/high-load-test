output "k6_project_id" {
  description = "Id of the Grafana Cloud k6 project this module creates. New on every apply after a teardown -- read it from terraform output at the moment of use, never copy it."
  value       = grafana_k6_project.this.id
}
