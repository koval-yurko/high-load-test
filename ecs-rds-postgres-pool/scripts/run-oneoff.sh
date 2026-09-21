#!/usr/bin/env bash
# One-off Fargate task on this project's cluster, with the app container's
# command overridden. Used for the seed and for calibration.
#
#     ./scripts/run-oneoff.sh node prisma/seed.js
#     ./scripts/run-oneoff.sh -e TARGET_MEAN_HOLD_MS=20 node scripts/calibrate.js
#
# WHY NOT FROM A LAPTOP. The database is reachable from the internet (the
# security group admits 5432 from anywhere, guarded by the password and
# rds.force_ssl -- plan 2, ruling R19), so both of these WOULD run locally. They
# must not: calibration measures connection HOLD TIME against a 20 ms target, and
# a run from outside the VPC carries tens of milliseconds of internet round trip
# inside every sample. In the VPC the round trip is a fraction of a millisecond,
# which is what the service itself pays.
#
# WHY NOT A BOOT FLAG. seed_on_boot would need one apply to turn it on and
# another to turn it off before scaling out (the seed is not idempotent). A
# one-off task is one command and leaves nothing behind.
#
# This creates NO infrastructure: the task exits and is reaped. It is the same
# class of call as the `aws ecs update-service` in deploy-service.sh beside it.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../scripts/lib.sh"

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PROJECT=$(basename "$PROJECT_DIR")
REPO_ROOT=$(cd "$PROJECT_DIR/.." && pwd)

USAGE="usage: ./scripts/run-oneoff.sh [-e KEY=VALUE]... <command> [args...]"

# The app container's name, in one place: used for both the run-task override
# and the log-stream name below, so a rename in ecs.tf fails loudly here
# instead of silently returning no logs.
CONTAINER_NAME="app"

ENV_OVERRIDES=()
while [ $# -gt 0 ]; do
  case "$1" in
    -e) [ $# -ge 2 ] || die "$USAGE"
        ENV_OVERRIDES+=("$2"); shift 2 ;;
    *)  break ;;
  esac
done
[ $# -gt 0 ] || die "$USAGE"

d() { direnv exec "$REPO_ROOT" "$@"; }

header "one-off task" "$PROJECT" "Runs one Fargate task with an overridden command. No load is generated."

step "Reading the environment"
OUT=$(d terraform -chdir="$PROJECT_DIR/infra/main" output -json 2>/dev/null || true)
CLUSTER=$(printf '%s' "$OUT" | jq -r '.cluster_name.value // empty')
SERVICE=$(printf '%s' "$OUT" | jq -r '.service_name.value // empty')
[ -n "$CLUSTER" ] && [ -n "$SERVICE" ] || blocked "one-off task" \
  "infra/main has no outputs -- the environment is not applied" \
  "/env up $PROJECT" \
  "./scripts/run-oneoff.sh $*"
ok "cluster $CLUSTER, service $SERVICE"

# The task definition and the network configuration are taken from the RUNNING
# SERVICE rather than from Terraform outputs: that way this task lands on the
# same subnets, the same security group and the same revision the service is
# actually running, and no new output has to be maintained for it.
step "Copying the service's task definition and network configuration"
SVC=$(d aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
        --query 'services[0].{taskDefinition:taskDefinition,net:networkConfiguration}' --output json)
TASKDEF=$(printf '%s' "$SVC" | jq -r '.taskDefinition')
NETCFG=$(printf '%s' "$SVC" | jq -c '.net')
ok "$TASKDEF"

CMD_JSON=$(printf '%s\n' "$@" | jq -R . | jq -sc .)
ENV_JSON=$(printf '%s\n' "${ENV_OVERRIDES[@]:-}" | jq -R 'select(length > 0) | split("=") | {name: .[0], value: (.[1:] | join("="))}' | jq -sc .)
OVERRIDES=$(jq -nc --arg name "$CONTAINER_NAME" --argjson cmd "$CMD_JSON" --argjson env "$ENV_JSON" \
  '{containerOverrides: [{name: $name, command: $cmd, environment: $env}]}')

step "Starting the task"
TASK_ARN=$(d aws ecs run-task --cluster "$CLUSTER" --task-definition "$TASKDEF" \
  --launch-type FARGATE --network-configuration "$NETCFG" --overrides "$OVERRIDES" \
  --started-by "run-oneoff" --query 'tasks[0].taskArn' --output text)
[ -n "$TASK_ARN" ] && [ "$TASK_ARN" != "None" ] || die "run-task returned no task ARN"
TASK_ID="${TASK_ARN##*/}"
ok "task $TASK_ID"

# NOT `aws ecs wait tasks-stopped`: that waiter is fixed at 6s x 100 attempts
# (10 minutes) with no flag to raise it, and under `set -e` a waiter timeout
# kills the script outright -- no logs printed, no way to tell a failed task
# from a slow one. Poll it ourselves instead, bounded by WAIT_SECONDS (default
# 45 minutes -- long enough for the calibration run; a caller can raise it for
# anything longer, e.g. `WAIT_SECONDS=5400 ./scripts/run-oneoff.sh ...`).
WAIT_SECONDS=${WAIT_SECONDS:-2700}
info "waiting for it to stop (up to $((WAIT_SECONDS / 60)) min; the seed takes minutes, calibration longer)"
ELAPSED=0
LAST_REPORT=0
while :; do
  STATUS=$(d aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
    --query 'tasks[0].lastStatus' --output text)
  [ "$STATUS" = "STOPPED" ] && break
  if [ "$ELAPSED" -ge "$WAIT_SECONDS" ]; then
    printf '\n%s└─ task %s still running after %s min -- giving up%s\n\n' \
      "$C_BOLD$C_RED" "$TASK_ID" "$((WAIT_SECONDS / 60))" "$C_RESET"
    note "aws ecs describe-tasks --cluster $CLUSTER --tasks $TASK_ARN"
    exit 1
  fi
  sleep 10
  ELAPSED=$((ELAPSED + 10))
  # One line per minute at most, not per 10s poll.
  if [ "$((ELAPSED - LAST_REPORT))" -ge 60 ]; then
    info "still $STATUS after $((ELAPSED / 60)) min"
    LAST_REPORT=$ELAPSED
  fi
done
ok "task stopped"

# The log stream is awslogs-stream-prefix/container/task-id, and the prefix is
# whatever ecs.tf set -- read it rather than assuming, so a changed prefix fails
# here instead of printing nothing and looking like a silent task.
PREFIX=$(d aws ecs describe-task-definition --task-definition "$TASKDEF" \
  --query "taskDefinition.containerDefinitions[?name=='$CONTAINER_NAME']|[0].logConfiguration.options.\"awslogs-stream-prefix\"" --output text)
GROUP=$(d aws ecs describe-task-definition --task-definition "$TASKDEF" \
  --query "taskDefinition.containerDefinitions[?name=='$CONTAINER_NAME']|[0].logConfiguration.options.\"awslogs-group\"" --output text)

echo
step "Output"
d aws logs get-log-events --log-group-name "$GROUP" --log-stream-name "$PREFIX/$CONTAINER_NAME/$TASK_ID" \
  --start-from-head --query 'events[].message' --output text || warn "no log events (yet)"

EXIT=$(d aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query "tasks[0].containers[?name=='$CONTAINER_NAME']|[0].exitCode" --output text)
# describe-tasks answers "None" (as text) rather than an empty string when the
# container never produced an exit code (e.g. it was OOM-killed before exit,
# or the task never left PENDING) -- fold that into empty so the guard below
# catches both cases the same way.
[ "$EXIT" != "None" ] || EXIT=""
REASON=$(d aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].stoppedReason' --output text)

echo
if [ "$EXIT" = "0" ]; then
  handoff "one-off task" "task $TASK_ID exited 0" "read the output above" "$REASON"
else
  # Propagate the container's own exit code (137 for an OOM kill vs. 1 for a
  # calibration that refused to converge are not the same failure) rather than
  # a flat 1 that makes every failure look identical to the caller.
  printf '\n%s└─ task %s exited %s -- %s%s\n\n' "$C_BOLD$C_RED" "$TASK_ID" "${EXIT:-?}" "$REASON" "$C_RESET"
  exit "${EXIT:-1}"
fi
