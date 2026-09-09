#!/usr/bin/env bash
# 04 — proves the setup works before anything bills you. Read-only: it authenticates,
# it does not create. Safe to re-run any time; this is also the "why is it broken" script.
#
#   ./scripts/04-verify-setup.sh                 shared setup only
#   ./scripts/04-verify-setup.sh ecs-dynamodb-rps  also terraform init for that project
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

header "04" "verify setup" "Read-only preflight. Nothing here creates or bills."

PROJECT="${1:-}"
cd "$REPO_ROOT"

have direnv || require_step "direnv" "./scripts/01-install-tools.sh"
[ -f .env ]  || require_step ".env"  "./scripts/02-create-env.sh"

# Everything runs through `direnv exec .` so this script behaves identically whether or
# not the calling shell is interactive — direnv's hook only fires in interactive ones.
d() { direnv exec "$REPO_ROOT" "$@"; }

step "Environment loads"
ORG=$(d sh -c 'printf %s "$TF_CLOUD_ORGANIZATION"' 2>/dev/null || true)
PRJ=$(d sh -c 'printf %s "$TF_CLOUD_PROJECT"' 2>/dev/null || true)
TOK=$(d sh -c 'printf %s "${TFE_TOKEN:+set}"' 2>/dev/null || true)
VAR=$(d sh -c 'printf %s "${TF_VAR_grafana_stack_id:+set}"' 2>/dev/null || true)
PROF=$(d sh -c 'printf %s "${AWS_PROFILE:-unset}"' 2>/dev/null || true)

[ -n "$ORG" ] && ok "TF_CLOUD_ORGANIZATION = $ORG" || bad "TF_CLOUD_ORGANIZATION empty — run ./scripts/03-wire-repo.sh"
[ "$PRJ" = "high-load-test" ] && ok "TF_CLOUD_PROJECT = $PRJ" \
  || bad "TF_CLOUD_PROJECT = '${PRJ:-empty}' (expected high-load-test — init would use the org's default project)"
[ "$TOK" = "set" ] && ok "TFE_TOKEN exported (platform/'s tfe provider)" || bad "TFE_TOKEN missing — .envrc did not run"
[ "$VAR" = "set" ] && ok "TF_VAR_* aliases exported (platform/'s inputs)" || bad "TF_VAR_* aliases missing — .envrc did not run"
[ "$PROF" = "unset" ] && ok "AWS_PROFILE unset — ~/.aws cannot outrank .env" || bad "AWS_PROFILE=$PROF is set and may outrank .env"

echo
step "AWS credentials point at the right account"
WANT=$(env_value AWS_ACCOUNT_ID .env || true)
GOT=$(d aws sts get-caller-identity --query Account --output text 2>/dev/null || true)
if [ -z "$GOT" ]; then
  bad "aws sts get-caller-identity failed — keys missing, expired, or no network"
elif [ "$GOT" = "$WANT" ]; then
  ok "account $GOT matches AWS_ACCOUNT_ID"
  info "identity: $(d aws sts get-caller-identity --query Arn --output text 2>/dev/null || echo '?')"
else
  bad "account $GOT does NOT match AWS_ACCOUNT_ID=$WANT — you would provision into the wrong account"
fi

echo
step "Terraform Cloud reachable"
if d terraform -chdir=platform providers >/dev/null 2>&1; then
  ok "platform/ is initialized"
else
  warn "platform/ not initialized yet — run: terraform -chdir=platform init"
fi

echo
step "Tooling"
for t in terraform aws k6 jq docker; do
  have "$t" && ok "$t $($t --version 2>&1 | head -1 | tr -d '\n' | cut -c1-60)" || bad "$t not found — ./scripts/01-install-tools.sh"
done
docker info >/dev/null 2>&1 && ok "docker daemon running" || warn "docker daemon not running — needed only to build/push the service image"

if [ -n "$PROJECT" ]; then
  echo
  step "Project: $PROJECT"
  [ -d "$PROJECT/infra/main" ] || die "$PROJECT/infra/main does not exist"
  if d terraform -chdir="$PROJECT/infra/main" init -input=false >/dev/null 2>&1; then
    ok "terraform init succeeded for $PROJECT/infra/main"
  else
    bad "terraform init failed for $PROJECT/infra/main — run it directly to see why"
  fi
fi

echo
if [ "$FAILED" -gt 0 ]; then
  blocked "04" \
    "$FAILED check(s) failed above" \
    "fix each ✘ (the script named the fix), then re-run" \
    "./scripts/04-verify-setup.sh${PROJECT:+ $PROJECT}"
fi

handoff "04" \
  "a verified environment: right AWS account, TFC reachable, tools present" \
  "terraform -chdir=platform apply      # the shared stack, once
             then: /env up <project>              # per-project infrastructure" \
  "platform/ must be applied before any project workspace can run"
