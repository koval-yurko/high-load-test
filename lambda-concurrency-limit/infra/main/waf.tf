# The anonymous tier's limit: one rate-based rule, counted per caller address (spec section 4.3).
# Everything here exists only while anonymous_enabled = true; the WAF bills while it exists.
# A WAF count is approximate (window of 60 s or more, blocking starts some seconds late).

resource "aws_wafv2_web_acl" "anonymous" {
  count = local.anon

  name  = "${var.project}-anonymous"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "anonymous-per-ip"
    priority = 1

    action {
      block {
        custom_response {
          response_code = 429
          response_header {
            name  = "x-throttle"
            value = "waf"
          }
        }
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.anonymous_rate_limit
        evaluation_window_sec = var.anonymous_window_seconds
        aggregate_key_type    = var.anonymous_ip_source == "forwarded" ? "FORWARDED_IP" : "IP"

        # TEST SETTING: the first X-Forwarded-For address is client-controlled (see the variable).
        dynamic "forwarded_ip_config" {
          for_each = var.anonymous_ip_source == "forwarded" ? [1] : []
          content {
            header_name       = "X-Forwarded-For"
            fallback_behavior = "MATCH"
          }
        }

        # Only the keyless routes count; keyed callers are limited by their usage plan.
        scope_down_statement {
          byte_match_statement {
            search_string         = "/public/"
            positional_constraint = "CONTAINS" # WAF sees /<stage>/public/..., the stage comes first
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "anonymous-per-ip"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.project}-anonymous"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "anonymous" {
  count = local.anon

  resource_arn = aws_api_gateway_stage.dev.arn
  web_acl_arn  = aws_wafv2_web_acl.anonymous[0].arn
}
