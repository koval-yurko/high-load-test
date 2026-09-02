# The k6 project is recreated on every apply, so its id is never stable and must
# never be hardcoded. K6_CLOUD_PROJECT_ID in the root .env and the k6-app links
# in the project README are both derived from this value after an apply.
output "k6_project_id" {
  description = "Grafana Cloud k6 project id. New on every apply -- the project is created, never imported."
  value       = grafana_k6_project.this.id
}
