# The key schema below is mirrored by service/scripts/create-local-table.js, which builds the local
# DynamoDB Local twin of this table without Terraform. Change the keys here and change them there —
# service/test/create-local-table.test.js pins that side, but it cannot see this file.
resource "aws_dynamodb_table" "items" {
  name           = var.project
  billing_mode   = "PROVISIONED"
  read_capacity  = var.read_capacity
  write_capacity = var.write_capacity
  hash_key       = "pk"
  range_key      = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  # Insurance against a long-lived environment only. TTL deletion is
  # asynchronous and will not keep the table small during a session.
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }
}
