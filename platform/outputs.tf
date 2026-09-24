output "workspace_ids" {
  description = "Map of repo project name to its Terraform Cloud workspace id."
  value       = { for name, ws in tfe_workspace.project : name => ws.id }
}

output "variable_set_id" {
  description = "The shared non-secret variable set, attached to the TFC project."
  value       = tfe_variable_set.shared.id
}

output "grafana_root_folder_uid" {
  description = "Fixed uid of the shared parent Grafana folder every project nests under."
  value       = grafana_folder.root.uid
}

output "aws_run_role_arns" {
  description = "Map of \"<project>/<phase>\" to the IAM role that phase of the workspace assumes through OIDC."
  value       = { for k, r in aws_iam_role.run : k => r.arn }
}
