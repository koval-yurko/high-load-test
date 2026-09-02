# GENERATED from slo.yaml by /slo. Do not edit by hand.
#
# The SLO object's inputs. objective and window come from slo.yaml so grafana_slo
# and the burn rules in alerts.tf cannot state different numbers, and the query is
# the same ratio those rules read -- differing only in $__rate_interval, which
# grafana_slo REQUIRES (it rejects a hardcoded range), and var.project for the
# job name.
locals {
  # 99% of requests meet their own class threshold, over 7d.
  slo_objective = 0.99
  slo_window    = "7d"

  class_ratio_query = <<-PROMQL
    (
        (histogram_fraction(0, 0.05, sum(rate(http_server_request_duration_seconds{job="${var.project}", http_route!~"/healthz", class=~"fast|standard|heavy", class="fast", http_response_status_code!~"5.."}[$__rate_interval]))) * histogram_count(sum(rate(http_server_request_duration_seconds{job="${var.project}", http_route!~"/healthz", class=~"fast|standard|heavy", class="fast", http_response_status_code!~"5.."}[$__rate_interval]))) or vector(0))
      +
        (histogram_fraction(0, 0.2, sum(rate(http_server_request_duration_seconds{job="${var.project}", http_route!~"/healthz", class=~"fast|standard|heavy", class="standard", http_response_status_code!~"5.."}[$__rate_interval]))) * histogram_count(sum(rate(http_server_request_duration_seconds{job="${var.project}", http_route!~"/healthz", class=~"fast|standard|heavy", class="standard", http_response_status_code!~"5.."}[$__rate_interval]))) or vector(0))
      +
        (histogram_fraction(0, 0.8, sum(rate(http_server_request_duration_seconds{job="${var.project}", http_route!~"/healthz", class=~"fast|standard|heavy", class="heavy", http_response_status_code!~"5.."}[$__rate_interval]))) * histogram_count(sum(rate(http_server_request_duration_seconds{job="${var.project}", http_route!~"/healthz", class=~"fast|standard|heavy", class="heavy", http_response_status_code!~"5.."}[$__rate_interval]))) or vector(0))
      )
      /
      histogram_count(sum(rate(http_server_request_duration_seconds{job="${var.project}", http_route!~"/healthz", class=~"fast|standard|heavy"}[$__rate_interval])))
  PROMQL
}
