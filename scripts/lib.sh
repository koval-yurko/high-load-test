#!/usr/bin/env bash
# Shared output helpers for the numbered setup scripts. Sourced, never run.
#
# Every script speaks the same way on purpose: you should be able to tell what a
# script changed, and what the next one needs from it, without reading its code.

set -euo pipefail

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=''; C_DIM=''; C_BOLD=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''
fi

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
FAILED=0

# Banner: what this script is about to do, before it does anything.
header() {
  printf '\n%s┌─ %s %s%s\n' "$C_BOLD$C_BLUE" "$1" "$2" "$C_RESET"
  printf '%s│  %s%s\n\n' "$C_DIM" "$3" "$C_RESET"
}

step()  { printf '%s▸%s %s\n' "$C_BLUE" "$C_RESET" "$1"; }
ok()    { printf '  %s✔%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
warn()  { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; }
info()  { printf '  %s·%s %s\n' "$C_DIM" "$C_RESET" "$1"; }
bad()   { printf '  %s✘%s %s\n' "$C_RED" "$C_RESET" "$1"; FAILED=$((FAILED + 1)); }
note()  { printf '    %s%s%s\n' "$C_DIM" "$1" "$C_RESET"; }

# Closing block. This is the contract between scripts: what now exists, and who needs it.
#   handoff <script-id> <"what this produced"> <"next command"> [<"why next needs it">]
handoff() {
  local id="$1" produced="$2" next="$3" why="${4:-}"
  printf '\n%s└─ %s complete%s\n' "$C_BOLD$C_GREEN" "$id" "$C_RESET"
  printf '   %sproduced:%s %s\n' "$C_BOLD" "$C_RESET" "$produced"
  [ -n "$why" ] && printf '   %sused by:%s  %s\n' "$C_BOLD" "$C_RESET" "$why"
  printf '   %snext:%s     %s\n\n' "$C_BOLD" "$C_RESET" "$next"
}

# Closing block when the script cannot finish because a human has to act.
#   blocked <script-id> <"what is missing"> <"what to do"> <"then re-run this">
blocked() {
  local id="$1" missing="$2" todo="$3" rerun="$4"
  printf '\n%s└─ %s incomplete%s\n' "$C_BOLD$C_YELLOW" "$id" "$C_RESET"
  printf '   %smissing:%s  %s\n' "$C_BOLD" "$C_RESET" "$missing"
  printf '   %syou do:%s   %s\n' "$C_BOLD" "$C_RESET" "$todo"
  printf '   %sthen:%s     %s\n\n' "$C_BOLD" "$C_RESET" "$rerun"
  exit 1
}

die() { printf '\n%serror:%s %s\n\n' "$C_RED$C_BOLD" "$C_RESET" "$1" >&2; exit 1; }

# A prerequisite script has not been run. Say which one instead of failing obscurely.
require_step() {
  local what="$1" fix="$2"
  printf '\n%s└─ cannot continue%s\n' "$C_BOLD$C_RED" "$C_RESET"
  printf '   %smissing:%s  %s\n' "$C_BOLD" "$C_RESET" "$what"
  printf '   %srun:%s      %s\n\n' "$C_BOLD" "$C_RESET" "$fix"
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# Read one key from an env file without sourcing it (values may contain anything,
# and sourcing a secrets file to inspect it is how you leak it into a log).
env_value() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 1
  sed -n "s/^[[:space:]]*${key}=//p" "$file" | head -1 | sed -e 's/^"//' -e 's/"$//'
}
