output "workspace_ids" {
  description = "Map of repo project name to its Terraform Cloud workspace id."
  value       = { for name, ws in tfe_workspace.project : name => ws.id }
}

output "variable_set_id" {
  description = "The shared credentials/endpoints variable set, attached to the TFC project."
  value       = tfe_variable_set.shared.id
}

output "grafana_root_folder_uid" {
  description = "Fixed uid of the shared parent Grafana folder every project nests under."
  value       = grafana_folder.root.uid
}

output "k6_project_ids" {
  description = "Map of repo project name to its Grafana Cloud k6 project id. K6_CLOUD_PROJECT_ID in .env is set from this, once -- the id is now stable across teardowns."
  value       = { for name, proj in grafana_k6_project.project : name => proj.id }
}
