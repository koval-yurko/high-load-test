# Sourced by .claude/skills/verify/scripts/verify.sh attach, with $TF_OUT = terraform output -json.
# Post ids start at 1 once the seed has run (seed_on_boot or scripts/seed.sh), so post 1 proves the
# service reaches the database, not only that the container answers /healthz.
PROBE_PATH=/posts/1
