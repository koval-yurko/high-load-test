#!/usr/bin/env bash
# Seeds the database: one Fargate task on this project's cluster, running
# `node prisma/seed.js` in place of the app container's command.
#
#     ./scripts/seed.sh              # top posts up to seed_rows; re-running is a no-op
#     ./scripts/seed.sh --add 100000 # append 100000 more seeded rows
#     ./scripts/seed.sh -i           # asks how many, with an estimate of what it costs
#     ./scripts/seed.sh --measure    # times the heavy query on the rows already there
#
# Safe to run any number of times. Seeded rows are named by (feed, offset) and
# the seed counts what is already there (author `seed_...`, which the load
# test's own `u_...` inserts never match), so it only inserts what is missing.
# Nothing is ever deleted: to shrink the table, destroy and recreate the env.
#
# WHY NOT FROM A LAPTOP. The database is reachable from the internet (the
# security group admits 5432 from anywhere, guarded by the password and
# rds.force_ssl -- plan 2, ruling R19), so the seed WOULD run locally. In the VPC
# it is faster (the round trip is a fraction of a millisecond, which is what the
# service itself pays) and runs on the same image and settings as the service.
#
# WHY NOT A BOOT FLAG. seed_on_boot would need one apply to turn it on and
# another to turn it off before scaling out (two tasks seeding at once would both insert; one after another is fine). A
# one-off task is one command and leaves nothing behind.
#
# This creates NO infrastructure: the task exits and is reaped. It is the same
# class of call as the `aws ecs update-service` in deploy-service.sh beside it.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../scripts/lib.sh"

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PROJECT=$(basename "$PROJECT_DIR")
REPO_ROOT=$(cd "$PROJECT_DIR/.." && pwd)

# The app container's name, in one place: used for both the run-task override
# and the log-stream name below, so a rename in ecs.tf fails loudly here
# instead of silently returning no logs.
CONTAINER_NAME="app"

SEED_COMMAND=(node prisma/seed.js)

d() { direnv exec "$REPO_ROOT" "$@"; }

ADD_ROWS=0
INTERACTIVE=0
MEASURE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --add)          ADD_ROWS="${2:-}"; shift 2 ;;
    -i|--interactive) INTERACTIVE=1; shift ;;
    --measure)      MEASURE=1; shift ;;
    *) die "unknown argument: $1 (usage: seed.sh [--add N] [-i] [--measure])" ;;
  esac
done
case "$ADD_ROWS" in ''|*[!0-9]*) die "--add needs a whole number of rows" ;; esac

TFVARS="$PROJECT_DIR/infra/main/dev.tfvars"
tfvar() { sed -n "s/^$1[[:space:]]*=[[:space:]]*\([0-9]*\).*/\1/p" "$TFVARS" | head -1; }

# ESTIMATE, from one `--measure` run on 2026-10-12 (db.t4g.micro, scans up to 50000
# rows: 4.9-6.3 ms per 1000, linear). It is NOT valid past ~50000 rows -- the same
# run read 13.5 ms per 1000 at 64968 -- so re-run `--measure` rather than trust it
# beyond that. Override with MS_PER_1K_ROWS.
MS_PER_1K_ROWS=${MS_PER_1K_ROWS:-5}
# seed_rows x ~1 KB has to stay inside shared_buffers (about a quarter of the
# instance's 1 GiB on db.t4g.micro); past that a "fast" query becomes disk reads.
SHARED_BUFFERS_ROWS=${SHARED_BUFFERS_ROWS:-250000}

ms_for() { awk -v r="$1" -v m="$MS_PER_1K_ROWS" 'BEGIN { printf "%.0f", r / 1000 * m }'; }

# What adding $1 rows means for the heavy route. The table size does not slow
# any route by itself: the scan reads report_scan_rows rows, so more data only
# lengthens the request once report_scan_rows is raised to use it.
describe_add() {
  local add="$1" base total scan
  base=$(tfvar seed_rows); scan=$(tfvar report_scan_rows)
  total=$((base + add))
  info "posts after: ~$total (assuming $base now, from dev.tfvars -- the task logs the real count)"
  info "heavy route today (report_scan_rows=$scan): ~$(ms_for "$scan") ms of scan, unchanged by this seed"
  info "heavy route scanning ALL $total rows: ~$(ms_for "$total") ms  (estimate: ${MS_PER_1K_ROWS} ms per 1000 rows; run --measure for the real number)"
  if [ "$total" -gt "$SHARED_BUFFERS_ROWS" ]; then
    warn "$total rows x ~1 KB exceeds shared_buffers (~$SHARED_BUFFERS_ROWS rows): expect disk reads, not a clean CPU scan"
  fi
}

header "seed" "$PROJECT" "Runs one Fargate task (seed, or --measure: read-only timing). No load is generated."

step "Reading the environment"
OUT=$(d terraform -chdir="$PROJECT_DIR/infra/main" output -json 2>/dev/null || true)
CLUSTER=$(printf '%s' "$OUT" | jq -r '.cluster_name.value // empty')
SERVICE=$(printf '%s' "$OUT" | jq -r '.service_name.value // empty')
[ -n "$CLUSTER" ] && [ -n "$SERVICE" ] || blocked "seed" \
  "infra/main has no outputs -- the environment is not applied" \
  "/env up $PROJECT" \
  "./scripts/seed.sh"
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

if [ "$INTERACTIVE" = 1 ]; then
  [ -t 0 ] || die "-i needs a terminal; use --add N from a script"
  step "How many rows to add?"
  for n in 25000 50000 100000 200000; do
    printf '  %s%7d%s rows\n' "$C_BOLD" "$n" "$C_RESET"
    TOTAL=$(( $(tfvar seed_rows) + n ))
    note "-> ~$TOTAL rows, heavy route over all of them ~$(ms_for "$TOTAL") ms"
  done
  read -r -p "  rows to add (0 = just top up to seed_rows): " ADD_ROWS
  case "$ADD_ROWS" in ''|*[!0-9]*) die "enter a whole number" ;; esac
fi

if [ "$ADD_ROWS" -gt 0 ]; then
  step "Adding $ADD_ROWS rows"
  describe_add "$ADD_ROWS"
  if [ "$INTERACTIVE" = 1 ]; then
    read -r -p "  proceed? [y/N] " REPLY
    [ "$REPLY" = y ] || [ "$REPLY" = Y ] || die "cancelled"
  fi
fi

# --measure replaces the seed with the read-only timing script; nothing is written.
[ "$MEASURE" = 1 ] && SEED_COMMAND=(node scripts/measure-scan.js) && ADD_ROWS=0

CMD_JSON=$(printf '%s\n' "${SEED_COMMAND[@]}" | jq -R . | jq -sc .)
OVERRIDES=$(jq -nc --arg name "$CONTAINER_NAME" --argjson cmd "$CMD_JSON" --arg add "$ADD_ROWS" \
  '{containerOverrides: [{name: $name, command: $cmd, environment: [{name: "SEED_ADD_ROWS", value: $add}]}]}')

step "Starting the task"
TASK_ARN=$(d aws ecs run-task --cluster "$CLUSTER" --task-definition "$TASKDEF" \
  --launch-type FARGATE --network-configuration "$NETCFG" --overrides "$OVERRIDES" \
  --started-by "seed" --query 'tasks[0].taskArn' --output text)
[ -n "$TASK_ARN" ] && [ "$TASK_ARN" != "None" ] || die "run-task returned no task ARN"
TASK_ID="${TASK_ARN##*/}"
ok "task $TASK_ID"

# NOT `aws ecs wait tasks-stopped`: that waiter is fixed at 6s x 100 attempts
# (10 minutes) with no flag to raise it, and under `set -e` a waiter timeout
# kills the script outright -- no logs printed, no way to tell a failed task
# from a slow one. Poll it ourselves instead, bounded by WAIT_SECONDS (default
# 30 minutes; raise it with `WAIT_SECONDS=3600 ./scripts/seed.sh`).
WAIT_SECONDS=${WAIT_SECONDS:-1800}
if [ "$MEASURE" = 1 ]; then TAKES="the timing is seconds; Fargate start and stop add 1-2 min"
else TAKES="a full seed of tens of thousands of rows takes minutes; a re-run that finds nothing to add is as fast as --measure"; fi
info "waiting for it to stop (up to $((WAIT_SECONDS / 60)) min; $TAKES)"
ELAPSED=0
LAST_REPORT=0
while :; do
  # Done when the CONTAINER has exited, not when the task is STOPPED: after the
  # container exits Fargate spends ~1 min in STOPPING/DEPROVISIONING (detaching
  # the ENI) while the exit code and logs are already final.
  read -r STATUS CODE < <(d aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
    --query "tasks[0].[lastStatus, containers[?name=='$CONTAINER_NAME']|[0].exitCode]" --output text)
  [ "$STATUS" = "STOPPED" ] && break
  [ "${CODE:-None}" != "None" ] && break
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
  --start-from-head --query 'events[].message' --output json | jq -r '.[]' || warn "no log events (yet)"

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
  handoff "seed" "task $TASK_ID exited 0" "read the output above" "$REASON"
else
  # Propagate the container's own exit code (137 for an OOM kill vs. 1 for a
  # failed seed are not the same failure) rather than a flat 1.
  printf '\n%s└─ task %s exited %s -- %s%s\n\n' "$C_BOLD$C_RED" "$TASK_ID" "${EXIT:-?}" "$REASON" "$C_RESET"
  exit "${EXIT:-1}"
fi
