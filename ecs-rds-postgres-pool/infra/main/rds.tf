# rds.tf
# The instance the whole project is sized around. db.t4g.micro is deliberate:
# its ~112 connection ceiling is what knob 2 aims at, and a larger class would
# raise that ceiling along with memory and take the proxy phase's point away.

# The password is var.db_password -- DB_PASSWORD in the root .env, beside every
# other secret (plan decision D7). Nothing here generates or stores it.

resource "aws_db_subnet_group" "main" {
  name       = var.project
  subnet_ids = aws_subnet.public[*].id
}

# Owned explicitly so terraform destroy takes it. An unmanaged custom parameter
# group is not billable, but it blocks a clean re-apply.
resource "aws_db_parameter_group" "main" {
  # name_prefix, not name: create_before_destroy below creates the replacement
  # BEFORE deleting the old group, so a fixed name would collide with itself
  # the first time anything forces a replacement (a family change, 16 -> 17).
  name_prefix = "${var.project}-"
  family      = "postgres16"

  # rds.force_ssl is already 1 in PostgreSQL 15+'s default group. It is restated
  # so the requirement is visible in code rather than inherited silently: the
  # service sets DB_SSL=require and verifies the certificate (src/pool.js).
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Declared explicitly with retention so Terraform owns it. An RDS-created log
# group survives terraform destroy and bills quietly forever.
resource "aws_cloudwatch_log_group" "db_postgresql" {
  name              = "/aws/rds/instance/${var.project}/postgresql"
  retention_in_days = var.log_retention_days
}

resource "aws_db_instance" "main" {
  identifier     = var.project
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.instance_class

  db_name  = var.db_name
  username = var.db_username
  password = var.db_password # DB_PASSWORD in the root .env (D7)

  allocated_storage = var.allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.main.name

  # Public, and open on 5432 to any address (network.tf, D7): the password and
  # forced TLS are the guard. The alternative is a NAT gateway.
  publicly_accessible = true
  multi_az            = false

  # Performance Insights is how the database announces it is the constraint, via
  # DBLoadRelativeToNumVCPUs. It IS available on db.t4g.micro for PostgreSQL --
  # the widely repeated exclusion is a MySQL and MariaDB restriction, because the
  # feature leans on PERFORMANCE_SCHEMA there. If the first apply refuses it
  # anyway, the named fallback is db.t4g.medium, and the connection arithmetic
  # the knob sequence depends on has to be redone against the new ceiling.
  performance_insights_enabled          = true
  performance_insights_retention_period = 7 # the free tier

  enabled_cloudwatch_logs_exports = ["postgresql"]

  # --- teardown survivor guards: every one is load-bearing ---
  skip_final_snapshot      = true
  backup_retention_period  = 0
  delete_automated_backups = true
  deletion_protection      = false
  apply_immediately        = true

  depends_on = [aws_cloudwatch_log_group.db_postgresql]
}
