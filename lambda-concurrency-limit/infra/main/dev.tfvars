# The switch values (spec, "Configuration — every switch"). Nothing secret here.
#
# After an apply that changes otel_enabled, trace_sample_ratio, otel_layer_version, memory_size,
# timeout_seconds, heavy_cpu_iterations or sdk_max_attempts, run ./scripts/deploy-service.sh --config-only: those
# settings are frozen into each published version, and alias live keeps the old one until moved.

# Knobs, in measurement order (README, "The knob sequence").
reserved_concurrency           = 10 # knob 2: 10 -> 20 -> 100
user_rate_limit_requests       = 0  # knob 1: requests per key per window; 0 = off (e.g. 1200 per 60 s = 20 per second)
user_rate_limit_window_seconds = 60

# Knob 1, anonymous tier. The WAF bills while it exists: false except while measuring.
anonymous_enabled        = false
anonymous_rate_limit     = 60 # requests per address per window; WAF minimum 10
anonymous_window_seconds = 60
anonymous_ip_source      = "forwarded" # test only: the client controls that address
provisioned_concurrency  = 0           # knob 3: 0 -> N; billed per hour, set back to 0 right after phase 4

# Phase 0 settles these.
otel_enabled         = false
trace_sample_ratio   = 1
memory_size          = 512
heavy_cpu_iterations = 0

# Knob 4, DynamoDB read capacity. Two ways to cap reads; use one:
#  - on-demand cap: billing_mode = "PAY_PER_REQUEST" and max_read_request_units = <reads per second> (null = no cap);
#  - fixed capacity: billing_mode = "PROVISIONED" and read_capacity = <reads per second> (AWS allows a billing-mode switch
#    once per 24 hours, and read_capacity can only step down a few times a day).
# Above that many reads per second DynamoDB throttles (ReadThrottleEvents, 500s). Rows are exploration.
billing_mode           = "PAY_PER_REQUEST"
max_read_request_units = 10 # reads per second, for example 10 to see throttling; null = no cap
