# The authoritative sizing knobs. slo.yaml's capacity block is ADVISORY and only
# computes; this file is what Terraform reads -- the arrangement the sibling
# adopted on 2026-09-18, after a generated file made overrides silent rather than
# preventing them.

# --- the knob sequence. One line changes per phase. ---
pool_size     = 5     # knob 1 releases this to 25
desired_count = 1     # knob 2 raises this to 4
proxy_enabled = false # knob 3 flips this to true

# --- tracing ---
trace_sample_ratio = 1 # 1 = every request. Hold constant across runs being compared.

# --- the instance under test ---
instance_class    = "db.t4g.micro"
allocated_storage = 20

# --- the measurement parameters ---
seed_rows        = 50000 # x ~1 KB must stay inside shared_buffers
seed_feeds       = 16

# The heavy route's workload, fixed here and deployed with the service: a pure CPU
# scan, no wait. Chosen, not measured -- the hold is whatever 25000 rows cost, and
# a longer one comes from more seed_rows plus a bigger scan, not from a sleep.
# Check pool wait and DBLoadCPU on the dashboard, and re-run the baseline after
# any change, because every later row is compared against it.
report_scan_rows = 25000

feed_page_size   = 20

# --- boot behaviour. seed_on_boot is one task, one shot: it is not idempotent. ---
migrate_on_boot = true
seed_on_boot    = false

# --- the task ---
task_cpu    = 512
task_memory = 1024 # Fargate: 1024 CPU needs 2048-8192 MiB

# --- the pool's wait limit (plan decision D5) ---
# The heavy class threshold in slo.yaml (1000 ms) plus 100 ms: just above it, so an
# over-deep queue fails fast as a 5xx instead of growing latency without bound.
# Change it together with that threshold.
pool_connection_timeout_ms = 1100

# db_password is NOT here. It is DB_PASSWORD in the root .env, delivered to
# remote runs by the shared HCP variable set (platform/tfc.tf). Secrets never
# live in a project folder (D7).
