# Key schema pk/sk is what service/scripts/seed.js writes and service/src/dynamo.js reads.
resource "aws_dynamodb_table" "items" {
  name           = var.project
  billing_mode   = var.billing_mode
  read_capacity  = var.billing_mode == "PROVISIONED" ? var.read_capacity : null
  write_capacity = var.billing_mode == "PROVISIONED" ? var.write_capacity : null
  hash_key       = "pk"
  range_key      = "sk"

  # A lab table, destroyed every session.
  deletion_protection_enabled = false

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  # Warm throughput is NOT a switch on purpose: raising it is charged and cannot be lowered.
  dynamic "on_demand_throughput" {
    for_each = var.billing_mode == "PAY_PER_REQUEST" && var.max_read_request_units != null ? [1] : []
    content {
      max_read_request_units = var.max_read_request_units
    }
  }

  lifecycle {
    # Every other resource depends on this table or on the function, so a wrong account or region
    # fails here, at plan, before anything is proposed.
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.aws_account_id
      error_message = "These credentials are for account ${data.aws_caller_identity.current.account_id}, not ${var.aws_account_id}."
    }
    precondition {
      condition     = data.aws_region.current.region == var.expected_region
      error_message = "Region is ${data.aws_region.current.region}; the concurrency limits this project is sized for exist in ${var.expected_region} only."
    }
  }
}
