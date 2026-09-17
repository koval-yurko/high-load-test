# Gated by a variable so enabling it is a one-line tfvars change.
resource "aws_appautoscaling_target" "ecs" {
  count = var.autoscaling_enabled ? 1 : 0
  # Derived from var.desired_count (see ecs.tf) so the floor and the baseline
  # cannot drift apart.
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

# CPU is bounded at 100%, so target tracking on it can never ask for more than
# target/current tasks in one decision. ALBRequestCountPerTarget is unbounded
# and proportional to capacity, so one decision can go straight to the fleet
# size the traffic needs. Kept alongside the CPU policy, not instead of it:
# Application Auto Scaling takes the largest desired count any policy asks
# for, so this costs nothing and CPU still covers a burst of requests that
# are cheap in count but expensive individually (e.g. /reports).
#
# Not supported with blue/green deployments -- doesn't apply today (rolling
# controller with a circuit breaker) but constrains a future move to
# CODE_DEPLOY.
#
# Gated separately from autoscaling_enabled so it can be measured in
# isolation against the CPU-only baseline.
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

# The CPU policy waits for three 60-second datapoints before its first
# decision; event-loop utilization saturates in seconds and is published
# every 10s at high resolution (service/src/cloudwatch.js), so the alarm in
# alerts.tf can make the first decision in ~30s.
#
# Step scaling, not target tracking: ELU is bounded 0..1 like CPU, so target
# tracking on it would inherit the same per-decision ceiling. Steps state the
# jump directly.
#
# An alarm re-invokes its action at most once per minute while it stays in
# ALARM, so 20-second detection buys a fast FIRST decision, not a fast
# repeating one -- that's why the steps are +200%/+400% rather than gentle.
#
# Both step thresholds must stay strictly BELOW the admission-control shed
# threshold (var.shed_elu_threshold): shedding clamps ELU near its own value,
# so a scale-out step at or above it would never fire.
#
# Gated separately from autoscaling_enabled so it can be measured in
# isolation.
resource "aws_appautoscaling_policy" "elu" {
  count              = var.autoscaling_enabled && var.elu_scaling_enabled ? 1 : 0
  name               = "${var.project}-elu-step"
  policy_type        = "StepScaling"
  resource_id        = aws_appautoscaling_target.ecs[0].resource_id
  scalable_dimension = aws_appautoscaling_target.ecs[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs[0].service_namespace

  step_scaling_policy_configuration {
    adjustment_type         = "PercentChangeInCapacity"
    metric_aggregation_type = "Maximum"
    # 1 guarantees every decision adds at least a task -- otherwise +200% of 1
    # task could round below a whole task on a small fleet and move nothing.
    min_adjustment_magnitude = 1
    # Matches the alarm's once-per-minute re-invocation ceiling: a shorter
    # cooldown buys nothing, and Application Auto Scaling already counts
    # capacity added during cooldown so a repeat invocation doesn't stack.
    cooldown = 60

    # Bounds are RELATIVE to the alarm threshold, not absolute ELU.
    # Adjustments are percentages of CURRENT capacity.
    step_adjustment {
      metric_interval_lower_bound = 0 # threshold .. threshold + 0.15
      metric_interval_upper_bound = 0.15
      scaling_adjustment          = 200 # +200% (capped at autoscaling_max)
    }

    step_adjustment {
      metric_interval_lower_bound = 0.15 # threshold + 0.15 and above
      scaling_adjustment          = 400  # +400% (capped at autoscaling_max)
    }
  }
}
