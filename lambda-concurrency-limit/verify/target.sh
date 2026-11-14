# Sourced by .claude/skills/verify/scripts/verify.sh attach, with $TF_OUT = terraform output -json.
# The keyed routes need x-api-key. normal-1 is one of the k6 test users; the key identifies a test
# user only (outputs.tf: "not authentication"). VERIFY_USER picks another user, such as noisy.
PROBE_PATH=/items/feed-0000/item-0000   # seeded by service/scripts/seed.js
TABLE_NAME="$(jq -r '.table_name.value' <<<"$TF_OUT")"
AUTH_HEADER="x-api-key: $(jq -r --arg u "${VERIFY_USER:-normal-1}" '.api_keys.value[$u] // empty' <<<"$TF_OUT")"
[ "$AUTH_HEADER" != "x-api-key: " ] || { echo "verify: no api key for user ${VERIFY_USER:-normal-1} in terraform output api_keys" >&2; exit 1; }
