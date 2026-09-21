#!/usr/bin/env bash
# Forked from ecs-dynamodb-rps/scripts/deploy-service.sh on 2026-09-21.
# A bug fixed here does not reach the sibling copy; fix both.
# deploy-service.sh [--skip-build]
#
# Ships this project's service image to an ALREADY-PROVISIONED environment: build → push →
# force a new ECS deployment → wait for health.
#
#     ./scripts/deploy-service.sh [--skip-build]
#
# It lives in THIS project's scripts/, not in the repo's, because every step below is specific to how
# this project is built and deployed — ECS Fargate, an ECR repo, an RDS Postgres database. The next
# project deploys differently and gets its own script; there is deliberately no shared deploy
# abstraction to bend. Only the output helpers are shared (../../scripts/lib.sh).
#
# It deliberately never applies Terraform: the approval gate CLAUDE.md requires before anything
# billable is created is the `permissions.ask` rule in .claude/settings.json, and it matches on
# the command text Claude Code sees. A plan-changing invocation hidden inside a script would never
# reach it. (.claude/hooks/guard-terraform.sh would match more spellings, but it is not registered
# in any settings file, so nothing runs it.) Provision first, by hand:
#     terraform -chdir=infra/main apply -var-file=dev.tfvars
#
# Terraform does not rebuild the container image, so every change under service/src/ needs this
# script. Skipping it fails silently: the service stays healthy while running the old code.
#
# There is no seed step here: the service seeds itself at boot when SEED_ON_BOOT is set (see the
# closing summary below for the one-task, one-shot caveat).

# lib.sh sets REPO_ROOT from its own location — still needed here because .envrc, and therefore
# every credential, lives at the repo root.
. "$(dirname "${BASH_SOURCE[0]}")/../../scripts/lib.sh"

SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    *) die "unknown flag '$arg' (usage: ./scripts/deploy-service.sh [--skip-build])" ;;
  esac
done

# The project is the directory this script's folder lives in, not the caller's cwd — so it can be run
# from anywhere and still name, and act on, the right project.
PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PROJECT=$(basename "$PROJECT_DIR")
cd "$PROJECT_DIR"

[ -d infra/main ] || die "$PROJECT/infra/main does not exist — is this a project directory?"
[ -d service ]    || die "$PROJECT/service does not exist — nothing to build"

header "deploy" "$PROJECT" "Build, push, redeploy. Provisioning is NOT part of this script."

d() { direnv exec "$REPO_ROOT" "$@"; }

# --- 1. is there anything to deploy to? --------------------------------------
step "Reading infrastructure outputs"
# Read once, as JSON. Not `output -raw`: with an empty state that prints a multi-line
# "No outputs found" warning to STDOUT and still exits 0, so both the exit code and the
# emptiness of the value lie -- you end up building `-t :latest` against a warning message.
# `output -json` prints `{}` and exits 0, which jq turns into a genuinely empty string.
OUTPUTS=$(d terraform -chdir=infra/main output -json 2>/dev/null || echo '{}')
tfout() { printf '%s' "$OUTPUTS" | jq -r --arg k "$1" '.[$k].value // empty' 2>/dev/null || true; }

REPO=$(tfout ecr_repository_url)
CL=$(tfout cluster_name)
SV=$(tfout service_name)

if [ -z "$REPO" ] || [ -z "$CL" ] || [ -z "$SV" ]; then
  blocked "deploy" \
    "$PROJECT has no applied infrastructure (terraform outputs are empty)" \
    "terraform -chdir=infra/main apply -var-file=dev.tfvars   # approval gate, on purpose" \
    "./scripts/deploy-service.sh"
fi
ok "ecr      $REPO"
ok "cluster  $CL"
ok "service  $SV"

# --- 2. build and push -------------------------------------------------------
if [ "$SKIP_BUILD" -eq 1 ]; then
  echo; step "Build"; info "skipped (--skip-build)"
else
  echo
  step "Building and pushing the image"
  docker info >/dev/null 2>&1 || blocked "deploy" \
    "the Docker daemon is not running" \
    "start Docker Desktop" \
    "./scripts/deploy-service.sh"

  d aws ecr get-login-password | docker login --username AWS --password-stdin "${REPO%%/*}" >/dev/null
  ok "authenticated to ${REPO%%/*}"

  # linux/amd64 is not optional on Apple Silicon: infra/main sets no runtime_platform, so Fargate
  # expects x86_64 and rejects an arm64 image with a bare CannotPullContainerError at task start.
  docker build --platform linux/amd64 -t "$REPO:latest" "service/"
  ok "built $REPO:latest (linux/amd64)"

  docker push "$REPO:latest" >/dev/null
  ok "pushed"
fi

# --- 3. roll the service -----------------------------------------------------
echo
step "Rolling the ECS service"
d aws ecs update-service --cluster "$CL" --service "$SV" --force-new-deployment >/dev/null
ok "new deployment forced"
info "waiting for the service to stabilise (a few minutes is normal)…"
if d aws ecs wait services-stable --cluster "$CL" --services "$SV"; then
  ok "service stable"
else
  bad "service did not stabilise — check the ECS events and the task logs"
  note "aws ecs describe-services --cluster $CL --services $SV --query 'services[0].events[:5]'"
  exit 1
fi

# --- 4. is it alive? ---------------------------------------------------------
echo
step "Health"
BASE=$(tfout base_url)
if [ -n "$BASE" ] && d curl -fsS --max-time 10 "$BASE/healthz" >/dev/null 2>&1; then
  ok "$BASE/healthz responding"
else
  warn "${BASE:-base_url}/healthz did not respond — the rollout may still be settling"
fi

handoff "deploy" \
  "the current service/src/ running in $PROJECT" \
  "/loadtest $PROJECT <profile>              # measure
             ../../scripts/04-verify-setup.sh      # if anything looks wrong" \
  "a load test measures whatever image is running — deploy before every measured run"
note "a fresh database needs one apply with seed_on_boot = true at desired_count = 1;"
note "the seed is not idempotent, so set the flag back to false before scaling out,"
note "or four tasks will insert four times the rows."
