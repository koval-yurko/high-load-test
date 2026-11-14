#!/usr/bin/env bash
# Drive a project's DEPLOYED environment over HTTP and record evidence. See ../SKILL.md.
# Usage: verify.sh attach <project> | doctor | req <label> <METHOD> <path> [json-body] | ddb-get <label> <pk> <sk> | cleanup
#        verify.sh lint <project>   (static contract check, no AWS; the pre-commit hook runs it)
# Every command except attach needs VERIFY_RUN=<run dir> (attach prints it).
# It reads terraform output only. It never runs apply or destroy: /env up|down owns the environment.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
ROOT="${VERIFY_ROOT:-${TMPDIR:-/tmp}}"; ROOT="${ROOT%/}/verify"

die() { echo "verify: $*" >&2; exit 1; }
need_run() {
  [ -n "${VERIFY_RUN:-}" ] || die "set VERIFY_RUN to the run dir that attach printed"
  [ -f "$VERIFY_RUN/state.env" ] || die "no state.env in $VERIFY_RUN"
  # shellcheck disable=SC1091
  . "$VERIFY_RUN/state.env"
}

attach() {
  local project="${1:-}"
  [ -n "$project" ] || die "usage: attach <project>"
  local target="$REPO/$project/verify/target.sh" main="$REPO/$project/infra/main"
  [ -f "$target" ] || die "$project has no verify/target.sh"
  [ -d "$main/.terraform" ] || terraform -chdir="$main" init -input=false >/dev/null \
    || die "terraform init failed in $main (are the .env secrets loaded?)"
  local TF_OUT; TF_OUT="$(terraform -chdir="$main" output -json)" || die "terraform output failed in $main"
  BASE_URL="$(jq -r '.base_url.value // empty' <<<"$TF_OUT")"
  [ -n "$BASE_URL" ] || die "$project has no base_url output: the environment is down. Bring it up with /env up $project (it stops for approval); this skill never applies."
  BASE_URL="${BASE_URL%/}"

  PROBE_PATH=""; TABLE_NAME=""; AUTH_HEADER=""
  # shellcheck disable=SC1090
  . "$target"   # sets PROBE_PATH, and TABLE_NAME / AUTH_HEADER when the project has them; reads $TF_OUT
  [ -n "$PROBE_PATH" ] || die "$target did not set PROBE_PATH"

  local id run; id="$project-$(date +%Y%m%d-%H%M%S)-$$"; run="$ROOT/$id"
  mkdir -p "$run/evidence"
  ( umask 077   # AUTH_HEADER is a test key, but keep it out of other users' reach
    printf 'PROJECT=%q\nRUN_ID=%q\nBASE_URL=%q\nPROBE_PATH=%q\nTABLE_NAME=%q\nAUTH_HEADER=%q\n' \
      "$project" "$id" "$BASE_URL" "$PROBE_PATH" "$TABLE_NAME" "$AUTH_HEADER" >"$run/state.env" )
  echo "VERIFY_RUN=$run"
}

# curl with the project's auth header unless VERIFY_NO_AUTH=1; extra headers from VERIFY_HEADER.
call() {
  local args=(-sS --max-time 30)
  [ -n "$AUTH_HEADER" ] && [ "${VERIFY_NO_AUTH:-0}" != 1 ] && args+=(-H "$AUTH_HEADER")
  [ -n "${VERIFY_HEADER:-}" ] && args+=(-H "$VERIFY_HEADER")
  curl "${args[@]}" "$@"
}

doctor() {
  need_run
  local ok=1 code
  echo "info project $PROJECT, base $BASE_URL"
  code="$(call -o /dev/null -w '%{http_code}' "$BASE_URL$PROBE_PATH" || echo 000)"
  if [ "$code" = 200 ]; then echo "ok   GET $PROBE_PATH -> 200 (data path works)"; else echo "FAIL GET $PROBE_PATH -> $code"; ok=0; fi
  if [ -n "$TABLE_NAME" ]; then
    if aws dynamodb describe-table --table-name "$TABLE_NAME" --query 'Table.TableStatus' --output text 2>/dev/null | grep -q ACTIVE
    then echo "ok   table $TABLE_NAME ACTIVE"; else echo "FAIL table $TABLE_NAME not ACTIVE or not readable"; ok=0; fi
  fi
  [ "$ok" = 1 ] || die "doctor failed; do not drive this environment. Check /env status $PROJECT."
}

# req <label> <METHOD> <path> [json-body]: one call, recorded as evidence/<label>.txt.
req() {
  need_run
  [ $# -ge 3 ] || die "usage: req <label> <METHOD> <path> [json-body]"
  local label="$1" method="$2" path="$3" body="${4:-}" out="$VERIFY_RUN/evidence/$1.txt"
  local args=(-X "$method" -o "$out.body" -D "$out.headers" -w '%{http_code}')
  [ -n "$body" ] && args+=(-H 'content-type: application/json' -d "$body")
  local code; code="$(call "${args[@]}" "$BASE_URL$path" || echo 000)"
  { echo "## $method $BASE_URL$path"; [ -n "$body" ] && echo "## body: $body"
    echo "## auth: $([ -n "$AUTH_HEADER" ] && [ "${VERIFY_NO_AUTH:-0}" != 1 ] && echo "${AUTH_HEADER%%:*} sent" || echo none)"
    echo "## status: $code"; echo "## at: $(date -u +%FT%TZ)"; echo
    cat "$out.headers" 2>/dev/null; cat "$out.body" 2>/dev/null; echo
  } >"$out"
  rm -f "$out.body" "$out.headers"
  cat "$out"
}

# ddb-get <label> <pk> <sk>: read-only second view of an item in the project's deployed table.
ddb_get() {
  need_run
  [ -n "$TABLE_NAME" ] || die "$PROJECT has no DynamoDB table in its verify/target.sh"
  [ $# -eq 3 ] || die "usage: ddb-get <label> <pk> <sk>"
  local out="$VERIFY_RUN/evidence/$1.txt" key
  key="$(jq -cn --arg pk "$2" --arg sk "$3" '{pk:{S:$pk},sk:{S:$sk}}')"
  { echo "## aws dynamodb get-item --table-name $TABLE_NAME --key $key"
    aws dynamodb get-item --table-name "$TABLE_NAME" --key "$key" --consistent-read --output json
  } >"$out" 2>&1
  cat "$out"
}

# lint <project | /abs/path>: static check of the verify/ contract. No AWS, no terraform, no network.
# Run by the git pre-commit hook for every project that has infra/main.
lint() {
  local p="${1:-}"; [ -n "$p" ] || die "usage: lint <project>"
  case "$p" in /*) ;; *) p="$REPO/$p" ;; esac
  local v="$p/verify" bad=0 f
  err() { echo "lint: ${p##*/}/verify: $*" >&2; bad=1; }
  [ -d "$v" ] || { err "missing. Every project needs verify/ (see .claude/skills/verify/SKILL.md)"; return 1; }
  if [ ! -f "$v/target.sh" ]; then err "target.sh missing"
  else
    bash -n "$v/target.sh" 2>/dev/null || err "target.sh has a syntax error"
    grep -q '^PROBE_PATH=' "$v/target.sh" || err "target.sh does not set PROBE_PATH"
  fi
  [ -f "$v/README.md" ] || { err "README.md (the feature index) missing"; return 1; }
  grep -q '^## Features$' "$v/README.md" || err "README.md has no '## Features' section"
  local linked; linked="$(grep -o '](\./[^)]*\.md)' "$v/README.md" | sed 's/](\.\/\(.*\))/\1/' | sort -u || true)"
  [ -n "$linked" ] || err "README.md links no feature file"
  local want=$'## Sub-features\n## How to get to it (user POV)\n## Driving it with verify.sh\n## Gotchas'
  for f in $linked; do
    [ -f "$v/$f" ] || { err "README.md links $f, which does not exist"; continue; }
    [ "$(grep '^## ' "$v/$f")" = "$want" ] || err "$f: the H2 sections must be exactly, in order: Sub-features, How to get to it (user POV), Driving it with verify.sh, Gotchas"
    grep -q '^Preconditions:' "$v/$f" || err "$f: no 'Preconditions:' line under Driving it"
  done
  for f in "$v"/*.md; do
    f="${f##*/}"; [ "$f" = README.md ] && continue
    grep -qx "$f" <<<"$linked" || err "$f is not linked from README.md"
  done
  [ "$bad" = 0 ] && echo "lint: ${p##*/}/verify ok"
  return "$bad"
}

cleanup() {
  need_run
  { echo "closed at $(date -u +%FT%TZ)"
    echo "nothing to stop: this run started no process and no resource"
    echo "the environment stays up; tear it down with /env down $PROJECT when you are done measuring"
  } | tee "$VERIFY_RUN/cleanup.log"
  echo "evidence kept in $VERIFY_RUN/evidence"
}

case "${1:-}" in
  attach) shift; attach "$@" ;;
  doctor) doctor ;;
  req) shift; req "$@" ;;
  ddb-get) shift; ddb_get "$@" ;;
  cleanup) cleanup ;;
  lint) shift; lint "$@" ;;
  *) die "usage: verify.sh <attach|doctor|req|ddb-get|cleanup|lint>" ;;
esac
