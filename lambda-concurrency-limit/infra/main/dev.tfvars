# The switch values (spec, "Configuration — every switch"). Nothing secret here.
#
# After an apply that changes otel_enabled, trace_sample_ratio, otel_layer_version, memory_size,
# timeout_seconds, heavy_cpu_iterations or sdk_max_attempts, run ./scripts/deploy-service.sh --config-only: those
# settings are frozen into each published version, and alias live keeps the old one until moved.

# Knobs, in measurement order (README, "The knob sequence").
reserved_concurrency    = 100 # knob 2: 20 -> 100
user_rate_limit_rps     = 0   # knob 1: 0 -> L from capacity.js
provisioned_concurrency = 0   # knob 3: 0 -> N; billed per hour, set back to 0 right after phase 4

# Phase 0 settles these.
otel_enabled         = true
trace_sample_ratio   = 1
memory_size          = 512
heavy_cpu_iterations = 0

# DynamoDB: on-demand for every comparison. PROVISIONED rows are exploration only.
billing_mode = "PAY_PER_REQUEST"
