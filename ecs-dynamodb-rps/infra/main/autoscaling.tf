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

# Change 2 (2026-09-15 spike-response spec, §5). The CPU policy waits for three
# 60-second datapoints before its first decision; event-loop utilization
# saturates in seconds, and the service publishes it every 10 s at
# StorageResolution 1 (service/src/cloudwatch.js), so a 20-second, 1-datapoint
# alarm can make the first decision in ~30 s.
#
# Step scaling, not target tracking: ELU is bounded 0..1 like CPU, so target
# tracking on it inherits the same 1.67x-per-decision ceiling. Steps state the
# jump directly, and percentages compound correctly from any fleet size.
#
# THE CEILING ON THE BENEFIT -- do not re-derive it: an alarm with an Auto
# Scaling action re-invokes that action at most once per minute while it stays
# in ALARM. 20-second detection buys a fast FIRST decision, not a fast repeating
# one. That is why the steps are +200% and +400% rather than something gentle:
# each decision has to count.
#
# Both thresholds (0.70, 0.85) must stay strictly BELOW the admission-control
# shed threshold (0.92, spec §6.1): shedding clamps ELU near its own threshold,
# so a scale-out step above it would never fire.
#
# Gated separately from autoscaling_enabled, like the requests policy: the
# Change 2 re-measure (plan Task 8) flips only elu_scaling_enabled.
resource "aws_cloudwatch_metric_alarm" "elu_high" {
  count             = var.autoscaling_enabled && var.elu_scaling_enabled ? 1 : 0
  alarm_name        = "${var.project}-elu-high"
  alarm_description = "Fleet-average event-loop utilization >= 0.70 over 20 s. Drives the ELU step-scaling policy."
  namespace         = local.metrics_namespace
  metric_name       = "EventLoopUtilization"
  # Must equal src/cloudwatch.js exactly: one dimension, ServiceName. No task
  # dimension, so every task's datapoints land in this one metric and Average
  # is the fleet average.
  dimensions = {
    ServiceName = local.metrics_service_name
  }
  statistic = "Average"
  # 20 is a legal high-resolution period ("Valid values are 10, 20, 30, and any
  # multiple of 60" -- CloudWatch PutMetricAlarm API reference, Period). It is
  # only meaningful because the metric is published with StorageResolution 1.
  period              = 20
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 0.70
  comparison_operator = "GreaterThanOrEqualToThreshold"
  # Every task publishes on a timer whether or not traffic flows, so a missing
  # datapoint means no task is publishing -- not overload. Never scale on it.
  treat_missing_data = "notBreaching"
  alarm_actions      = [aws_appautoscaling_policy.elu[0].arn]
}

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
    # Without it, +200% of 1 task could round below one whole task on a small
    # fleet and move nothing. 1 guarantees every decision adds at least a task.
    min_adjustment_magnitude = 1
    # 60 s, matching the alarm's once-per-minute re-invocation ceiling above: a
    # shorter cooldown buys nothing because the alarm cannot re-fire sooner, and
    # a longer one would delay the second step past the ~60 s the spec's
    # 1 -> 5 -> 15 in ~100 s model assumes. During cooldown Application Auto
    # Scaling counts the capacity already added, so a repeat invocation does not
    # stack a second +200% on tasks that are still launching.
    cooldown = 60

    # Bounds are RELATIVE to the alarm threshold (0.70), not absolute ELU.
    # Adjustments are percentages of CURRENT capacity, so the task counts in the
    # comments below are examples, not fixed jumps. A spike that cliffs (run
    # 8554820 did) is past 0.85 within the first 20 s period, so the first
    # decision is usually the +400% step: 1 -> 5, then 5 -> 15 -- the model the
    # cooldown comment above assumes.
    step_adjustment {
      metric_interval_lower_bound = 0 # ELU 0.70 .. 0.85
      metric_interval_upper_bound = 0.15
      scaling_adjustment          = 200 # +200%: 1 -> 3, or 5 -> 15 (capped at autoscaling_max)
    }

    step_adjustment {
      metric_interval_lower_bound = 0.15 # ELU >= 0.85, no upper bound
      scaling_adjustment          = 400  # +400%: 1 -> 5, or 3 -> 15 (capped at autoscaling_max)
    }
  }
}
