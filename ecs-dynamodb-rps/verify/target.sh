# Sourced by .claude/skills/verify/scripts/verify.sh attach, with $TF_OUT = terraform output -json.
PROBE_PATH=/items/feed-00/item-00   # seeded by scripts/deploy-service.sh
TABLE_NAME="$(jq -r '.table_name.value' <<<"$TF_OUT")"
