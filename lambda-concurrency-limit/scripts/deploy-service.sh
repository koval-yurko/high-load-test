#!/usr/bin/env bash
# deploy-service.sh [--config-only | --check | --dry-run]
#
# Ships this project's code to an ALREADY-APPLIED environment and moves alias live:
#     test -> build (production node_modules) -> zip -> update-function-code -> wait
#     -> publish-version -> update-alias live -> wait for provisioned concurrency READY (if on)
#
#     ./scripts/deploy-service.sh                 # code changed
#     ./scripts/deploy-service.sh --config-only   # dev.tfvars changed a version-frozen setting
#     ./scripts/deploy-service.sh --check         # does live run what $LATEST has?
#     ./scripts/deploy-service.sh --dry-run       # build and inspect the zip; no AWS call
#
# WHY --config-only EXISTS. A published version freezes environment variables, memory and layers.
# Terraform publishes a new version on every configuration change (publish = true), but alias live
# keeps pointing at the old one. So after an apply that changes otel_enabled, trace_sample_ratio,
# otel_layer_version, memory_size, heavy_cpu_iterations or sdk_max_attempts, run --config-only.
# publish-version returns the newest version when nothing changed, so a needless run is harmless.
#
# WHY node_modules IS BUNDLED. The SDK built into the Lambda runtime is a different version; the
# measured retry behaviour (AWS_MAX_ATTEMPTS, default 3, standard mode) is true for the bundled
# @aws-sdk/client-dynamodb 3.1164.0 only.
#
# It never runs terraform apply (CLAUDE.md: an apply inside a script never reaches the approval
# gate). Provision first: terraform -chdir=infra/main apply -var-file=dev.tfvars

. "$(dirname "${BASH_SOURCE[0]}")/../../scripts/lib.sh"

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PROJECT=$(basename "$PROJECT_DIR")
SERVICE="$PROJECT_DIR/service"
DIST="$SERVICE/dist"
ZIP="$DIST/function.zip"

MODE=code
for arg in "$@"; do
  case "$arg" in
    --config-only) MODE=config ;;
    --check)       MODE=check ;;
    --dry-run)     MODE=dry ;;
    *) die "unknown flag '$arg' (usage: ./scripts/deploy-service.sh [--config-only|--check|--dry-run])" ;;
  esac
done

d() { direnv exec "$REPO_ROOT" "$@"; }

header "deploy" "$PROJECT" "mode: $MODE"

step "Checking prerequisites"
for t in jq zip unzip npm; do have "$t" || require_step "$t is not installed" "brew install $t"; done
if [ "$MODE" != dry ]; then
  have aws || require_step "aws is not installed" "brew install awscli"
  have direnv || require_step "direnv is not installed" "brew install direnv"
fi
ok "tools present"

# --- build (code and dry-run) ------------------------------------------------
build() {
  step "Testing"
  (cd "$SERVICE" && npm test >/dev/null) || die "npm test failed in service/ — not deploying broken code"
  ok "npm test passed"

  step "Building $ZIP"
  rm -rf "$DIST"
  local stage="$DIST/stage"
  mkdir -p "$stage"
  cp -R "$SERVICE/src" "$SERVICE/collector.yaml" "$SERVICE/package.json" "$SERVICE/package-lock.json" "$stage/"
  (cd "$stage" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
  (cd "$stage" && zip -qr "$ZIP" src collector.yaml package.json node_modules)
  rm -rf "$stage"

  # The three things a broken bundle gets wrong, checked on the zip itself.
  local listing
  listing=$(unzip -Z1 "$ZIP")
  grep -qx 'collector.yaml' <<<"$listing" || die "collector.yaml is not at the zip root (/var/task/collector.yaml)"
  grep -qx 'src/handler.js' <<<"$listing" || die "src/handler.js is missing (handler = src/handler.handler)"
  grep -q '^node_modules/@aws-sdk/client-dynamodb/' <<<"$listing" || die "the DynamoDB SDK is not bundled"
  ! grep -q '^node_modules/aws-sdk-client-mock/' <<<"$listing" || die "dev dependencies leaked into the zip"
  ok "zip $(du -h "$ZIP" | cut -f1): collector.yaml at root, src/handler.js, bundled SDK, no dev deps"
}

if [ "$MODE" = dry ]; then
  build
  handoff "deploy (--dry-run)" "$ZIP — nothing uploaded" "./scripts/deploy-service.sh"
  exit 0
fi

# --- names from Terraform (output -json, never -raw: against empty state -raw prints a warning to stdout)
step "Reading terraform outputs"
OUT=$(d terraform -chdir="$PROJECT_DIR/infra/main" output -json 2>/dev/null || true)
FN=$(jq -r '.function_name.value // empty' <<<"$OUT")
ALIAS=$(jq -r '.alias_name.value // empty' <<<"$OUT")
PC=$(jq -r '.knobs.value.provisioned_concurrency // 0' <<<"$OUT")
[ -n "$FN" ] && [ -n "$ALIAS" ] || blocked "deploy" \
  "infra/main has no function_name output — the environment is not applied" \
  "terraform -chdir=infra/main apply -var-file=dev.tfvars   # approval gate" \
  "./scripts/deploy-service.sh"
ok "function $FN, alias $ALIAS, provisioned concurrency $PC"

# --- check -------------------------------------------------------------------
settings() { # [qualifier] -> normalised memory, timeout, code hash, environment, layers
  d aws lambda get-function-configuration --function-name "$FN" ${1:+--qualifier "$1"} --output json 2>/dev/null \
    | jq -S '{memory: .MemorySize, timeout: .Timeout, code: .CodeSha256, env: (.Environment.Variables // {}), layers: ([.Layers[]?.Arn] | sort)}'
}

if [ "$MODE" = check ]; then
  step "Comparing alias $ALIAS with \$LATEST"
  LIVE_V=$(d aws lambda get-alias --function-name "$FN" --name "$ALIAS" --query FunctionVersion --output text 2>/dev/null) \
    || die "cannot read alias $ALIAS of $FN (applied? credentials?)"
  LIVE_S=$(settings "$ALIAS") || LIVE_S=
  LATEST_S=$(settings) || LATEST_S=
  [ -n "$LIVE_S" ] && [ -n "$LATEST_S" ] || die "cannot read the configuration of $FN (alias $ALIAS or \$LATEST) — refusing to report a match on empty data"
  if [ "$LIVE_S" = "$LATEST_S" ]; then
    ok "alias $ALIAS (version $LIVE_V) runs the settings Terraform last applied"
  else
    warn "alias $ALIAS (version $LIVE_V) runs OLDER settings than \$LATEST:"
    diff <(jq 'del(.env.GRAFANA_OTLP_AUTH)' <<<"$LIVE_S") <(jq 'del(.env.GRAFANA_OTLP_AUTH)' <<<"$LATEST_S") | sed 's/^/    /' || true
    note "fix: ./scripts/deploy-service.sh --config-only"
  fi
  exit 0
fi

# --- deploy ------------------------------------------------------------------
if [ "$MODE" = code ]; then
  build
  step "Uploading code"
  d aws lambda update-function-code --function-name "$FN" --zip-file "fileb://$ZIP" >/dev/null
  ok "uploaded"
fi

step "Waiting for the function update to finish"
d aws lambda wait function-updated-v2 --function-name "$FN"
ok "LastUpdateStatus Successful"

step "Publishing a version and moving alias $ALIAS"
VERSION=$(d aws lambda publish-version --function-name "$FN" --query Version --output text)
d aws lambda update-alias --function-name "$FN" --name "$ALIAS" --function-version "$VERSION" >/dev/null
ok "alias $ALIAS -> version $VERSION"

# None of the provisioned environments is usable until all are allocated (1-2 minutes).
if [ "$PC" -gt 0 ]; then
  step "Waiting for provisioned concurrency ($PC) to be READY on the new version"
  sleep 5 # right after update-alias the status can still read READY from the old version
  status=NONE
  for _ in $(seq 1 60); do
    status=$(d aws lambda get-provisioned-concurrency-config --function-name "$FN" --qualifier "$ALIAS" --query Status --output text 2>/dev/null || echo NONE)
    case "$status" in
      READY) break ;;
      FAILED) die "provisioned concurrency FAILED: aws lambda get-provisioned-concurrency-config --function-name $FN --qualifier $ALIAS" ;;
    esac
    sleep 10
  done
  [ "$status" = READY ] || die "provisioned concurrency not READY after 10 minutes (status $status)"
  ok "READY"
fi

handoff "deploy" "alias $ALIAS -> version $VERSION of $FN" \
  "./scripts/deploy-service.sh --check   # or seed, then ./scripts/upload-k6.sh" \
  "every k6 run hits the alias, never \$LATEST"
