# The authoritative sizing knobs. slo.yaml's capacity block is ADVISORY and only
# computes; this file is what Terraform reads -- the arrangement the sibling
# adopted on 2026-09-18, after a generated file made overrides silent rather than
# preventing them.

# --- the knob sequence. One line changes per phase. ---
pool_size     = 5     # knob 1 releases this to 25
desired_count = 1     # knob 2 raises this to 4
proxy_enabled = false # knob 3 flips this to true

# --- the instance under test ---
instance_class    = "db.t4g.micro"
allocated_storage = 20

# --- the measurement parameters ---
seed_rows        = 50000 # x ~1 KB must stay inside shared_buffers
seed_feeds       = 16

# The heavy route's workload, fixed here and deployed with the service. Chosen, not
# measured: ~25 ms of database CPU plus ~320 ms of wait gives a ~345 ms hold on a
# 5% share of the mix, so the mean hold is ~20 ms and the pool of 5 binds near
# 250 rps with the database around half its CPU. If the baseline run shows
# otherwise (pool wait and DBLoadCPU on the dashboard), edit these two numbers --
# and re-run the baseline, because every later row is compared against it.
report_scan_rows = 25000
report_sleep_ms  = 320

feed_page_size   = 20

# --- boot behaviour. seed_on_boot is one task, one shot: it is not idempotent. ---
migrate_on_boot = true
seed_on_boot    = false

# --- the task ---
task_cpu    = 256
task_memory = 512

# --- the pool's wait limit (plan decision D5) ---
# The heavy class threshold in slo.yaml (1000 ms) plus 100 ms: just above it, so an
# over-deep queue fails fast as a 5xx instead of growing latency without bound.
# Change it together with that threshold.
pool_connection_timeout_ms = 1100

# db_password is NOT here. It is DB_PASSWORD in the root .env, delivered to
# remote runs by the shared HCP variable set (platform/tfc.tf). Secrets never
# live in a project folder (D7).
