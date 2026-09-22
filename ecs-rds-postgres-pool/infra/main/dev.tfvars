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
report_scan_rows = 0 # THE CALIBRATED KNOB. Plan 3 sets it; 0 means uncalibrated.
feed_page_size   = 20

# --- boot behaviour. seed_on_boot is one task, one shot: it is not idempotent. ---
migrate_on_boot = true
seed_on_boot    = false

# --- the task ---
task_cpu    = 256
task_memory = 512

# --- the pool's wait limit (plan decision D5) ---
# UNMEASURED PLACEHOLDER. The real value is the heavy class threshold plus a
# margin, and plan 3 sets it once that threshold is frozen in slo.yaml. No run
# before plan 3 depends on it.
pool_connection_timeout_ms = 900

# db_password is NOT here. It is DB_PASSWORD in the root .env, delivered to
# remote runs by the shared HCP variable set (platform/tfc.tf). Secrets never
# live in a project folder (D7).
