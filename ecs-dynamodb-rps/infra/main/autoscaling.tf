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

# Change 1 (2026-09-15 spike-response spec, §4). CPU utilization is bounded at
# 100%, so target tracking on it can never ask for more than target/current
# tasks in one decision -- from one task with a 60% target that is a ceiling
# of 1.67x, so reaching 15 tasks takes five consecutive control-loop decisions.
# ALBRequestCountPerTarget is unbounded and proportional to capacity, so one
# decision can go straight to the fleet size the traffic needs.
#
# The CPU policy above is kept, not replaced: Application Auto Scaling takes
# the largest desired count any policy asks for, so this costs nothing and
# covers what request count misses -- a burst of individually expensive
# requests (e.g. /reports) that is cheap in count and dear in CPU.
#
# Two facts worth not re-learning:
# - The metric is not reported at all when no requests flow, which drives its
#   alarm to INSUFFICIENT_DATA. Harmless here: the Grafana synthetic canary
#   sustains ~23 rps continuously (~1,392 requests/minute at the ALB between
#   runs), which at one task is ~1,380/min -- well under target, so it keeps
#   the metric alive without provoking a scale-out.
# - ALBRequestCountPerTarget is not supported with blue/green deployments.
#   This service uses the rolling controller with a deployment circuit
#   breaker, so it does not apply today -- but it constrains any future move
#   to CODE_DEPLOY.
#
# Gated separately from autoscaling_enabled: the baseline stress run (plan
# Task 4) must measure the CPU-only policy with this off, and the Change 1
# re-measure (plan Task 6) flips only this flag -- the before/after
# comparison requires changing exactly one knob from the same commit.
resource "aws_appautoscaling_policy" "requests" {
  count              = var.autoscaling_enabled && var.requests_scaling_enabled ? 1 : 0
  name               = "${var.project}-requests-target-tracking"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs[0].resource_id
  scalable_dimension = aws_appautoscaling_target.ecs[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs[0].service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.main.arn_suffix}/${aws_lb_target_group.app.arn_suffix}"
    }

    target_value = var.autoscaling_rps_target

    scale_out_cooldown = 30
    scale_in_cooldown  = 120
  }
}
