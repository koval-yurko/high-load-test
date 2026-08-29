#!/usr/bin/env bash
# PreToolUse guard: terraform apply/destroy create and delete billable AWS resources.
# Never let them run unattended. Reads the hook payload on stdin.
set -uo pipefail

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
# Fail closed: if the payload could not be parsed, match against the raw text.
[ -z "$cmd" ] && cmd="$input"

# Matches `terraform apply|destroy` with any flags between, including -chdir=,
# after a pipeline/&&/;, and with env-var prefixes.
TF_RE='(^|[;&|(]|[[:space:]])terraform([[:space:]]+-[^[:space:]]+)*[[:space:]]+(apply|destroy)([[:space:]]|$)'

printf '%s' "$cmd" | grep -Eq "$TF_RE" || exit 0

if printf '%s' "$cmd" | grep -Eq -- '-auto-approve'; then
  jq -n --arg r "BLOCKED: -auto-approve removes the human approval gate that CLAUDE.md requires before creating or destroying billable AWS resources. Re-run without -auto-approve and approve the prompt, or run it yourself in a terminal." \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
fi

if printf '%s' "$cmd" | grep -Eq '[[:space:]]destroy([[:space:]]|$)'; then
  verb="DESTROY — deletes data and infrastructure"
else
  verb="APPLY — creates billable AWS resources"
fi

jq -n --arg r "terraform $verb. Review the plan before approving; confirm the AWS account is the intended one. After a destroy, run /env down's sweep — a clean destroy is not proof the account is clean." \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$r}}'
