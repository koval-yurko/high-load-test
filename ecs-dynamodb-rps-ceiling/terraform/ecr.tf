resource "aws_ecr_repository" "app" {
  name = var.project

  # Disposable lab: destroy must not strand images and start billing storage.
  force_delete = true

  image_scanning_configuration {
    scan_on_push = false
  }
}
