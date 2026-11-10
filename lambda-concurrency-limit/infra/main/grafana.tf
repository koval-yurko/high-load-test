# Forked from ecs-rds-postgres-pool/infra/main/grafana.tf on 2026-11-09.
# A bug fixed here does not reach the sibling copy; fix both.
# Auth comes from GRAFANA_URL / GRAFANA_AUTH and the k6 token in the workspace's variable set.
provider "grafana" {}

module "grafana" {
  source = "../grafana"

  project                   = var.project
  cloudwatch_datasource_uid = var.cloudwatch_datasource_uid
  function_name             = aws_lambda_function.app.function_name
  alias_name                = aws_lambda_alias.live.name
  api_name                  = aws_api_gateway_rest_api.app.name
  stage_name                = aws_api_gateway_stage.dev.stage_name
  table_name                = aws_dynamodb_table.items.name
  reserved_concurrency      = var.reserved_concurrency
  provisioned_concurrency   = var.provisioned_concurrency
  anonymous_enabled         = var.anonymous_enabled
  web_acl_name              = "${var.project}-anonymous"
}

# Creates this project's k6 project, so /env down destroys it with its uploaded tests and run
# history. Re-upload after every /env up: ./scripts/upload-k6.sh
module "k6" {
  source = "../k6"

  project = var.project
}
