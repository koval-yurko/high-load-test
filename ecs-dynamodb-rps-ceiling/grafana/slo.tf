# The SLO. grafana_slo derives the error budget and the burn windows itself, so
# nothing here pre-computes a ratio -- that is why the SLI had to be a ratio
# rather than a percentile (2026-08-29 spec, D5).
resource "grafana_slo" "latency_classes" {
  name        = "${var.project} latency classes"
  description = "Proportion of requests meeting their own class threshold: fast 50ms, standard 200ms, heavy 800ms."

  query {
    type = "freeform"
    freeform {
      query = local.class_ratio_query
    }
  }

  # From slo.yaml via grafana/locals.tf. Typing these by hand duplicated the
  # objective into a file `npm run slo:check` does not read, which is the exact
  # drift this repo's one-source rule exists to prevent.
  objectives {
    value  = local.slo_objective
    window = local.slo_window
  }

  destination_datasource {
    uid = var.prometheus_datasource_uid
  }

  label {
    key   = "project"
    value = var.project
  }
}

# The SLI's idle population does NOT come from Grafana any more. Synthetic
# Monitoring checks used to live here; the SM tenant is disabled at the Grafana
# Cloud account level and re-enabling it needs a third credential from a portal
# this project does not want to depend on.
#
# What the SLI actually needs is only that traffic EXISTS between load tests --
# health checks are excluded by selector, so with nothing running the class
# ratio is no-data and no error budget accrues. Nothing about that premise
# requires a Grafana probe. The population is now produced inside AWS by an
# EventBridge Scheduler + Lambda heartbeat: see terraform/heartbeat.tf. It also
# covers all three latency classes, which the two SM checks did not -- they hit
# only fast and standard, leaving heavy with no idle data to alert on.
