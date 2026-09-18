# PROVISIONED CAPACITY -- the largest line on the bill, and set here on purpose.
#
# These two numbers are AUTHORITATIVE. Nothing generates them and nothing
# outranks them: capacity.auto.tfvars was deleted on 2026-09-18 (a CLI -var-file
# outranks an auto-loaded *.auto.tfvars, so a value here always won anyway --
# silently, which was the actual problem), and the TFC workspace variables that
# used to pin 25/25 above both files are gone (verified 2026-09-18, ws-pPiZ7mfesjrzZ8sx
# has no workspace variables and the shared `high-load-test` varset carries none).
#
# The capacity model in slo.yaml still exists and still computes -- it just
# ADVISES now. `npm run slo:check` (from service/) prints what it would provision
# beside what is set here and marks a difference; it does not fail on one.
# 1000 rps at the modelled mix wants 1,025 RCU / 200 WCU:
#   0.55*0.5 + 0.25*2.5 + 0.05*2.5 = 1.025 RCU per rps
#   0.15*1.0 + 0.05*1.0            = 0.200 WCU per rps
# Deviate deliberately (headroom to move the ceiling off the table, or a cheap
# run), and say why in a comment -- an unexplained difference reads as a stale
# number to whoever runs slo:check next.
read_capacity  = 1025
write_capacity = 200

task_cpu    = 256
task_memory = 512

desired_count = 1

# Calibrated on a real 0.25 vCPU Fargate slice for ~1.4ms of pbkdf2 per report
# request. Re-measured 2026-08-31 on the instrumented build: two one-off Fargate
# runs returned 2665 and 2659 (0.23% apart); value is their mean.
#
# READ THIS BEFORE CONCLUDING THE INSTRUMENTATION MOVED IT. It did not, and this
# calibration cannot see it either way: scripts/calibrate.js imports burn() from
# cpu.js and binary-searches it in isolation -- no HTTP, no server.js, no otel.js.
# The -0.49% against the previous 2675 is host-to-host variance, only twice the
# 0.23% spread between two runs on the same day.
#
# The instrumentation cost is real but far below this measurement's noise floor:
# 0.51 us/request (scripts/bench-otel.js, 200k iterations) is 0.036% of the 1.4ms
# target, i.e. about ONE iteration. Measuring it here would need a calibration
# that drives the whole request path, not burn() alone.
#
# Re-calibrate if task_cpu changes — this number is CPU-specific.
pbkdf2_iterations = 2662
feed_page_size    = 20

autoscaling_enabled = true

requests_scaling_enabled = true

# The service publishes EventLoopUtilization regardless of this flag, so every
# run records the series the 0.70 / 0.85 alarm thresholds are checked against.
elu_scaling_enabled = true

# Shed threshold is var.shed_elu_threshold's default (0.92), which must stay
# above the ELU scale-out thresholds -- see the invariant in variables.tf
# before overriding it here.
shedding_enabled = true
