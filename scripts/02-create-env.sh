#!/usr/bin/env bash
# 02 — the global secrets file. Creates .env from the committed template if absent, then
# reports which keys are still empty. Never overwrites an existing .env, and never prints
# a value: only the key name and whether it is set.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

header "02" "create .env" "Creates the gitignored secrets file and lists what you still have to fill in."

ENV_FILE="$REPO_ROOT/.env"
TEMPLATE="$REPO_ROOT/.env.example"

[ -f "$TEMPLATE" ] || die "$TEMPLATE is missing — this is not a clean checkout."

step "Secrets file"
if [ -f "$ENV_FILE" ]; then
  # The character class must allow digits, or K6_* and PBKDF2_* keys vanish from the count.
  ok ".env exists — left untouched ($(grep -cE '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE") keys)"
else
  cp "$TEMPLATE" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "created .env from .env.example (mode 600)"
  note "it is gitignored; never commit it"
fi

# Filled in later, from a terraform output — legitimately empty at setup time.
DEFERRED="K6_CLOUD_PROJECT_ID"

echo
step "Keys the template declares"
EMPTY=""; DEFER_EMPTY=""; SET_COUNT=0
for key in $(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$TEMPLATE" | tr -d '='); do
  val=$(env_value "$key" "$ENV_FILE" || true)
  if [ -n "$val" ]; then
    SET_COUNT=$((SET_COUNT + 1))
  elif echo " $DEFERRED " | grep -q " $key "; then
    DEFER_EMPTY="$DEFER_EMPTY $key"
  else
    EMPTY="$EMPTY $key"
  fi
done

ok "$SET_COUNT keys set"
for key in $DEFER_EMPTY; do
  info "$key — empty, but filled after the first apply, not now"
done
for key in $EMPTY; do
  bad "$key — empty"
done

if [ -n "$EMPTY" ]; then
  echo
  note "AWS            https://console.aws.amazon.com/iam  (IAM user keys + the account id)"
  note "Terraform Cloud https://app.terraform.io/app/settings/tokens"
  note "Grafana Cloud  your stack URL, a service-account token, and the k6 / OTLP / Prometheus"
  note "               values from the portal tiles — .env.example documents each one inline"
  blocked "02" \
    "$(echo $EMPTY | wc -w | tr -d ' ') key(s) marked ✘ above" \
    "\$EDITOR $ENV_FILE   (.env.example explains every key inline)" \
    "./scripts/02-create-env.sh"
fi

handoff "02" \
  ".env with all $SET_COUNT required keys set" \
  "./scripts/03-wire-repo.sh" \
  "03 hands .env to direnv; 04 checks the AWS account it names"
