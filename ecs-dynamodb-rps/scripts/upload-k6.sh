#!/usr/bin/env bash
# upload-k6.sh [--rate N] [--base-url URL] [--only NAME] [--check] [--dry-run]
#
# Puts this project's three load profiles into the Grafana Cloud k6 project, with BASE_URL and RATE
# baked into each archive, and reads back what the project now holds.
#
#     ./scripts/upload-k6.sh --check              # what is uploaded, and is it stale?
#     ./scripts/upload-k6.sh                      # discovery only -- the knee is not known yet
#     ./scripts/upload-k6.sh --rate 700           # all three, constant/stress pinned to the knee
#
# WHY THIS EXISTS. A run started from the k6 app executes the ARCHIVE STORED IN THE CLOUD, never the
# file on disk. Every edit under infra/k6/tests/ (or tests/lib/, which all three import) is invisible
# to the app until it is uploaded again, and nothing warns you: the old archive runs happily and its
# results look like a measurement of the code you are reading. There is no Terraform resource for
# this -- grafana_k6_load_test takes a single script string and these scripts import from lib/
# (infra/k6/main.tf) -- so it is a script, and this one, so the flags cannot be mistyped per run.
#
# WHY -e AT UPLOAD TIME. `k6 archive` evaluates the init context, so the env given here is frozen
# into the stored archive: metadata.json carries env {BASE_URL, RATE}, the executor's `rate`, the
# derived `preAllocatedVUs`, and the rate_source tag. Verified locally against k6 v1.4.0 --
# `k6 archive -e RATE=700 tests/constant.js` stored rate 700 / preAllocatedVUs 88 /
# tags.rate_source=explicit. That is what makes a UI-started run reproducible without anyone
# remembering to visit a settings page.
#
# WHAT THIS SCRIPT CANNOT DO: set the k6 app's own Settings -> Environment variables. That page has
# no public API -- the Cloud REST API v6 exposes projects, load tests, test runs, schedules, load
# zones and metrics, and nothing else (checked 2026-09-09: every environment-variable path under
# /cloud/v6 returns 404) -- and no Terraform resource. Those values stay a browser step. Because
# this script bakes the same values into the archive, the settings page cannot rescue a stale
# upload: measured 2026-09-10, a UI run took the archive's BASE_URL while that page held the
# correct, newer one. The archive wins both values, so the page is only somewhere to be contradicted
# -- keep it empty, or equal to what this script last uploaded; the closing block prints both.
#
# Like deploy-service.sh next to it, this lives in the PROJECT's scripts/, not the repo's: what gets
# uploaded, and which env each profile needs, is a property of this scenario. The root scripts/ holds
# only repo-wide things — the numbered setup scripts and the output helpers this sources
# (../../scripts/lib.sh).

. "$(dirname "${BASH_SOURCE[0]}")/../../scripts/lib.sh"

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PROJECT=$(basename "$PROJECT_DIR")
K6_DIR="$PROJECT_DIR/infra/k6"

RATE=""
BASE_URL_ARG=""
ONLY=""
CHECK=0
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rate)     RATE="${2:-}";          shift 2 ;;
    --base-url) BASE_URL_ARG="${2:-}";  shift 2 ;;
    --only)     ONLY="${2:-}";          shift 2 ;;
    --check)    CHECK=1;                shift ;;
    --dry-run)  DRY=1;                  shift ;;
    *) die "unknown flag '$1' (usage: ./scripts/upload-k6.sh [--rate N] [--base-url URL] [--only discovery|constant|stress] [--check] [--dry-run])" ;;
  esac
done
[ -z "$RATE" ] || [[ "$RATE" =~ ^[0-9]+$ ]] || die "--rate takes a whole number of requests per second, got '$RATE'"
case "${ONLY:-discovery}" in discovery|constant|stress) ;; *) die "--only takes discovery, constant or stress, got '$ONLY'" ;; esac

# Every credential lives in the root .env, so each call goes through direnv. Its `direnv: loading …`
# banner on stderr is left in on purpose -- it is the same proof the README asks for, and
# DIRENV_LOG_FORMAT does not suppress it for `direnv exec` (checked against direnv 2.37.1).
d() { direnv exec "$REPO_ROOT" "$@"; }

# The k6 API answers about the project; the k6 binary writes to it. Both need the same token.
# The token has to be expanded INSIDE direnv's environment, not this one -- `d curl -H "…$K6_CLOUD_TOKEN"`
# expands in the calling shell, where the variable does not exist (and set -u then kills the script).
api() { d bash -c 'curl -sS -H "Authorization: Bearer $K6_CLOUD_TOKEN" -H "X-Stack-Id: $GRAFANA_STACK_ID" "https://api.k6.io/cloud/v6/$1"' _ "$1"; }

header "k6 upload" "$PROJECT" "Archives the load profiles into the cloud project. No load is generated."

# --- 1. preflight ------------------------------------------------------------
step "Checking prerequisites"
have k6   || require_step "k6 is not installed"   "brew install k6      # then re-run"
have jq   || require_step "jq is not installed"   "brew install jq      # then re-run"
have direnv || require_step "direnv is not installed" "brew install direnv  # the credentials live in the root .env"

TOKEN=$(d printenv K6_CLOUD_TOKEN 2>/dev/null || true)
STACK=$(d printenv GRAFANA_STACK_ID 2>/dev/null || true)
[ -n "$TOKEN" ] && [ -n "$STACK" ] || blocked "k6 upload" \
  "K6_CLOUD_TOKEN or GRAFANA_STACK_ID is empty in the root .env" \
  "fill them in (.env.example documents each), then: direnv allow" \
  "./scripts/upload-k6.sh"

# The k6 project is created by this project's own infra/main and destroyed by /env down, so its id
# changes on every rebuild and is never copied anywhere -- ask Terraform now. `output -json` + jq, NOT
# `output -raw`: against empty state (the normal condition between /env down and the next /env up)
# -raw prints a multi-line warning to STDOUT and exits 0, which would land here as the "id".
PROJECT_ID=$(d terraform -chdir="$PROJECT_DIR/infra/main" output -json 2>/dev/null | jq -r '.k6_project_id.value // empty' || true)
[ -n "$PROJECT_ID" ] || blocked "k6 upload" \
  "infra/main has no k6_project_id output — the environment is not applied, so there is no k6 project to upload into" \
  "/env up $PROJECT     # creates the k6 project with everything else" \
  "./scripts/upload-k6.sh"
ok "k6 project $PROJECT_ID on stack $STACK"

# The output can outlive the project it names -- state that was not refreshed, or a project deleted
# by hand. Uploading into a missing project would silently create nothing recognisable, so fail here.
PROJECT_NAME=$(api "projects/$PROJECT_ID" | jq -r '.name // empty')
[ -n "$PROJECT_NAME" ] || blocked "k6 upload" \
  "k6 project $PROJECT_ID does not exist, or the token cannot see it" \
  "terraform -chdir=infra/main apply -var-file=dev.tfvars     # recreates the k6 project" \
  "./scripts/upload-k6.sh"
ok "project name '$PROJECT_NAME'"

# --- 2. what is up there now -------------------------------------------------
# Read back BY PROJECT: /load_tests ignores a project_id query param and answers for the whole
# stack, which reads exactly like "your test is there" when it is another project's test.
echo
step "Reading the cloud project"
UPLOADED=$(api "projects/$PROJECT_ID/load_tests")
COUNT=$(printf '%s' "$UPLOADED" | jq '.value | length')
if [ "$COUNT" -eq 0 ]; then
  warn "no load tests in this project — a UI run has nothing to start"
else
  printf '%s' "$UPLOADED" | jq -r '.value[] | "  \(.id)  \(.name)  updated \(.updated)"'
fi

# What the environment currently is, resolved best-effort so the staleness report below can compare
# it against what each archive was uploaded with. Failure is fine here — an unapplied environment
# just means there is nothing to compare to; section 3 is where a missing BASE_URL is fatal.
LIVE_BASE_URL="$BASE_URL_ARG"
if [ -z "$LIVE_BASE_URL" ]; then
  LIVE_BASE_URL=$(d terraform -chdir="$PROJECT_DIR/infra/main" output -json 2>/dev/null | jq -r '.base_url.value // empty' || true)
fi

# Stale means one of two things, and BOTH have produced a wrong measurement here:
#
#   1. a source file is newer than the archive stored in the cloud;
#   2. the archive's baked-in BASE_URL is not the endpoint that exists now. `terraform destroy` +
#      `apply` gives the ALB a NEW hostname, and that touches no .js file, so check 1 cannot see it.
#      The 2026-09-10 case: the archive uploaded 2026-09-09T07:26Z carried the ALB alive at the time,
#      the environment was rebuilt at 12:38Z onto a new hostname, and every UI-started run afterwards
#      went on hitting the dead one. The k6 app's Settings -> Environment variables page did NOT
#      rescue it: it held the correct new URL and the run still used the archived one, so the
#      archive's env wins and re-uploading is the ONLY fix.
#
# This is the failure the script exists to prevent, so both are reported even when nothing is being
# uploaded.
#
# NOT by timestamp. The obvious check — is a .js file newer than the test's `updated` field — cannot
# work: `updated` is set when the load test is CREATED and a re-upload does not move it (verified
# 2026-09-10: uploaded twice, the field stayed 2026-09-09T07:26:43Z), so it would warn forever after
# the first edit and teach you to ignore the warning. It was also silently dead on macOS anyway —
# k6 returns fractional seconds and a Z, BSD find answers "Can't parse date/time", and the error went
# to /dev/null.
#
# So compare the bytes. GET /load_tests/<id>/script returns the stored tar itself, which carries both
# metadata.json (the frozen env) and every .js file under a normalised file/Users/nobody/… path. Diff
# those against the working tree and there is nothing left to infer.
check_stored() {
  local id="$1" name="$2" tar dir entry rel drift
  tar=$(mktemp -t k6-stored).tar
  d bash -c 'curl -sS -H "Authorization: Bearer $K6_CLOUD_TOKEN" -H "X-Stack-Id: $GRAFANA_STACK_ID" "https://api.k6.io/cloud/v6/load_tests/$1/script" -o "$2"' _ "$id" "$tar" 2>/dev/null || true
  if ! tar -tf "$tar" >/dev/null 2>&1; then
    warn "'$name' — could not read the stored archive back; staleness unknown"
    rm -f "$tar"; return 0
  fi

  # 1. the sources a UI run would execute, against the ones you are editing. EXTRACT, never
  #    `tar -xO <entry>`: the entry point is stored as a hard link to the archive's `data` member
  #    ("h--------- … link to data"), so streaming that one path out prints nothing and every check
  #    would read as "the local file has changed". Extracting resolves the link.
  dir=$(mktemp -d -t k6-stored)
  tar -xf "$tar" -C "$dir" 2>/dev/null || true
  while read -r entry; do
    rel="${entry##*/infra/k6/}"
    if [ ! -f "$K6_DIR/$rel" ]; then
      warn "'$name' stores $rel, which no longer exists locally"
    elif ! cmp -s "$entry" "$K6_DIR/$rel"; then
      warn "'$name' runs an older $rel — the local file has changed since upload"
    fi
  done < <(find "$dir/file" -name '*.js' 2>/dev/null || true)
  rm -rf "$dir"

  # 2. the endpoint frozen into the archive, against the one that exists now. `terraform destroy` +
  #    `apply` gives the ALB a NEW hostname and touches no .js file, so check 1 cannot see it. The
  #    2026-09-10 case: an archive from 2026-09-09T07:26Z kept the ALB alive at that moment, the
  #    environment was rebuilt at 12:38Z onto a new hostname, and every UI-started run afterwards
  #    went on hitting the dead one. The k6 app's Settings -> Environment variables page did NOT
  #    rescue it — it held the correct new URL and the run still used the archived one. The archive's
  #    env wins, so re-uploading is the only fix.
  drift=$(tar -xOf "$tar" metadata.json 2>/dev/null | jq -r '.env.BASE_URL // empty')
  if [ -n "$drift" ] && [ -n "$LIVE_BASE_URL" ] && [ "$drift" != "$LIVE_BASE_URL" ]; then
    warn "'$name' will run against $drift"
    note "the environment is at $LIVE_BASE_URL — re-upload; the settings page cannot override this"
  fi
  rm -f "$tar"
  return 0
}

report_staleness() {
  local id name
  while IFS=$'\t' read -r id name; do
    [ -n "$name" ] && check_stored "$id" "$name"
  done < <(printf '%s' "$UPLOADED" | jq -r '.value[] | "\(.id)\t\(.name)"')
  # Never the script's exit status. The old body ended on `[ -n "$newer" ] && warn`, so a clean
  # report returned 1 and `set -e` killed the whole script right here — before resolving BASE_URL,
  # before uploading anything, printing nothing. That is why upload-k6.sh appeared to do nothing.
  return 0
}
if [ "$COUNT" -gt 0 ]; then report_staleness; fi

if [ "$CHECK" -eq 1 ]; then
  handoff "k6 upload (--check)" \
    "$COUNT load test(s) in k6 project $PROJECT_ID" \
    "./scripts/upload-k6.sh --rate <knee>    # re-upload anything reported stale above" \
    "a UI-started run executes the stored archive, not the file on disk"
  exit 0
fi

# --- 3. the values that get baked in -----------------------------------------
echo
step "Resolving BASE_URL"
# Resolved before the staleness report (output -json, not -raw: with an empty state -raw prints a
# multi-line warning to STDOUT and still exits 0, so you would bake a warning message in as the
# hostname). Empty is fatal here, where it was only uncomparable there.
BASE_URL="$LIVE_BASE_URL"
[ -n "$BASE_URL" ] || blocked "k6 upload" \
  "no BASE_URL — infra/main has no outputs, so the environment is not applied" \
  "terraform -chdir=infra/main apply -var-file=dev.tfvars   # approval gate, on purpose
             ./scripts/upload-k6.sh --base-url <url>              # or pass one explicitly" \
  "./scripts/upload-k6.sh"
ok "BASE_URL $BASE_URL"

# Which profiles to upload. constant and stress are meaningless without a measured knee: archived
# without RATE they freeze at the 50 rps placeholder in tests/lib/env.js and tag every sample
# rate_source=default, which is a run that must never be recorded as a capacity measurement. So they
# are not uploaded at all until --rate is given -- an absent test is honest, a wrong one is not.
if [ -n "$RATE" ]; then
  TESTS=(discovery constant stress)
  ok "RATE $RATE rps — constant and stress will archive at this rate (stress peaks at 3x)"
else
  TESTS=(discovery)
  info "no --rate: uploading discovery only"
  note "constant and stress need the knee discovery measures; re-run with --rate <knee> afterwards"
fi
[ -z "$ONLY" ] || TESTS=("$ONLY")

# --- 4. upload ---------------------------------------------------------------
# From infra/k6: the scripts import './lib/…' relative to themselves, and the archive records the
# working directory.
cd "$K6_DIR"
E_ARGS=(-e "BASE_URL=$BASE_URL")
[ -n "$RATE" ] && E_ARGS+=(-e "RATE=$RATE")

for t in "${TESTS[@]}"; do
  echo
  step "Uploading $t.js"
  [ -f "tests/$t.js" ] || { bad "tests/$t.js does not exist"; continue; }

  # K6_CLOUD_PROJECT_ID is how `k6 cloud upload` picks the project -- no script under tests/ sets
  # options.cloud.projectID. It used to arrive implicitly from the root .env through direnv; it is
  # passed explicitly now, from the Terraform output resolved in section 1. Without it the upload
  # lands in the stack's DEFAULT project, and the read-back below (by $PROJECT_ID) finds nothing.
  # Explicit also beats a stale K6_CLOUD_PROJECT_ID still left in someone's .env.
  if [ "$DRY" -eq 1 ]; then
    info "dry run: K6_CLOUD_PROJECT_ID=$PROJECT_ID k6 cloud upload ${E_ARGS[*]} tests/$t.js"
  else
    if ! d env K6_CLOUD_PROJECT_ID="$PROJECT_ID" k6 cloud upload "${E_ARGS[@]}" "tests/$t.js"; then
      bad "$t.js was not uploaded"
      note "a 400 with E2004 means the archived preAllocatedVUs exceeds the project's 100-VU cap"
      continue
    fi
  fi

  # Proof of what the archive actually contains, from the archive itself rather than from the
  # upload's own summary: same script, same flags, read back locally.
  ARCHIVE=$(mktemp -t "k6-$t").tar
  if d k6 archive "${E_ARGS[@]}" -O "$ARCHIVE" "tests/$t.js" >/dev/null 2>&1; then
    tar -xOf "$ARCHIVE" metadata.json | jq -r '
      "  env        " + (.env | to_entries | map(.key + "=" + .value) | join(", ")),
      "  tags       " + ((.options.tags // {}) | to_entries | map(.key + "=" + .value) | join(", ")),
      "  scenarios  " + ((.options.scenarios | to_entries | map(.key + " @ " + ((.value.rate // .value.startRate // 0) | tostring) + " rps")) | join(", ") | .[0:160])'
  fi
  rm -f "$ARCHIVE"
  [ "$DRY" -eq 1 ] && info "$t not uploaded (--dry-run); the block above is what WOULD be stored" || ok "$t archived"
done

# --- 5. read back ------------------------------------------------------------
if [ "$DRY" -eq 1 ]; then
  handoff "k6 upload (--dry-run)" \
    "nothing — the cloud project is untouched" \
    "./scripts/upload-k6.sh${RATE:+ --rate $RATE}${ONLY:+ --only $ONLY}" \
    "the env / tags / scenarios blocks above are what the archive would carry"
  exit 0
fi

echo
step "Cloud project after upload"
api "projects/$PROJECT_ID/load_tests" | jq -r '.value[] | "  \(.id)  \(.name)  updated \(.updated)"'

if [ "$FAILED" -gt 0 ]; then
  printf '\n%s└─ k6 upload incomplete — %d profile(s) failed%s\n\n' "$C_BOLD$C_RED" "$FAILED" "$C_RESET"
  exit 1
fi

# The settings page cannot be written from here, so the closing block states what it must NOT
# contradict. Neither value there can override the archive (measured 2026-09-10, see the header) --
# an out-of-date page is a reader trap rather than a live risk, which is why the line says EMPTY.
handoff "k6 upload" \
  "${TESTS[*]} archived in k6 project $PROJECT_ID with BASE_URL=$BASE_URL${RATE:+ RATE=$RATE}" \
  "https://k0valchuk.grafana.net/a/k6-app/projects/$PROJECT_ID   # start the run (wait 6 min first)" \
  "Settings -> Environment variables must be EMPTY or match the values above — it is browser-only"
