# Drives the ELU step-scaling policy (autoscaling.tf) at high resolution --
# see the comment there for why a 20-second alarm beats CPU's 60-second one.
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
  # 20 is a legal high-resolution period, only meaningful because the metric
  # is published with StorageResolution 1.
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
