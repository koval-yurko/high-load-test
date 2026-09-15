# Gated by a variable so enabling it is a one-line tfvars change — which is
# exactly the "change one thing" the before/after comparison requires.
resource "aws_appautoscaling_target" "ecs" {
  count = var.autoscaling_enabled ? 1 : 0
  # Derived from var.desired_count, not a separate variable -- see the comment above
  # `desired_count = var.desired_count` in ecs.tf. One number is the floor and the
  # Terraform baseline, so they cannot drift apart the way they did in run 8554820.
  min_capacity       = var.desired_count
  max_capacity       = var.autoscaling_max
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.app.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu" {
  count              = var.autoscaling_enabled ? 1 : 0
  name               = "${var.project}-cpu-target-tracking"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs[0].resource_id
  scalable_dimension = aws_appautoscaling_target.ecs[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs[0].service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }

    target_value = var.autoscaling_cpu_target

    # Scale out fast, in slowly: a spike profile must not be answered
    # and then un-answered inside the same run.
    scale_out_cooldown = 30
    scale_in_cooldown  = 120
  }
}
