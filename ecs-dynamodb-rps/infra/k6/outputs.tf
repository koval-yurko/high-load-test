output "k6_project_id" {
  description = "Stable id of the Grafana Cloud k6 project owned by platform/. K6_CLOUD_PROJECT_ID in .env and the README links are set from it once."
  value       = one(data.grafana_k6_projects.this.projects).id
}
