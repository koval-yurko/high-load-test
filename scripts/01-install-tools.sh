#!/usr/bin/env bash
# 01 — the seven command-line tools this repo runs. Checks versions, installs what is
# missing (with consent). Changes nothing else: no credentials, no shell config.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

header "01" "install tools" "Checks the 7 required binaries and installs any that are missing."

# name : brew formula : version command : version the repo was verified against
TOOLS="
node:node:node --version:22.13
terraform:hashicorp/tap/terraform:terraform version:1.14
aws:awscli:aws --version:2.23
k6:k6:k6 version:1.4
docker:--:docker --version:27.4
jq:jq:jq --version:1.7
direnv:direnv:direnv --version:2.37
"

MISSING=""
step "Checking installed versions"
while IFS=: read -r bin formula vercmd want; do
  [ -z "$bin" ] && continue
  if have "$bin"; then
    got=$($vercmd 2>&1 | head -1)
    ok "$(printf '%-10s %s' "$bin" "$got")"
  else
    bad "$(printf '%-10s not found (repo verified against %s)' "$bin" "$want")"
    MISSING="$MISSING $bin:$formula"
  fi
done <<EOF
$TOOLS
EOF

if [ -z "$MISSING" ]; then
  handoff "01" \
    "all 7 tools on PATH, direnv included" \
    "./scripts/02-create-env.sh" \
    "03 needs direnv; 04 needs aws, terraform and k6"
  exit 0
fi

echo
step "Missing tools"
BREW_LIST=""
for entry in $MISSING; do
  bin=${entry%%:*}; formula=${entry#*:}
  if [ "$formula" = "--" ]; then
    warn "$bin — install Docker Desktop by hand: https://docker.com/products/docker-desktop"
  else
    BREW_LIST="$BREW_LIST $formula"
  fi
done

[ -z "$BREW_LIST" ] && blocked "01" \
  "Docker" \
  "install Docker Desktop, then start it" \
  "./scripts/01-install-tools.sh"

have brew || blocked "01" \
  "Homebrew, and these tools:$BREW_LIST" \
  "install Homebrew (https://brew.sh) or install those tools by hand" \
  "./scripts/01-install-tools.sh"

echo
info "would run: brew install$BREW_LIST"
if [ "${1:-}" = "--yes" ]; then
  REPLY=y
elif [ -t 0 ]; then
  printf '\n  install them now? [y/N] '
  read -r REPLY
else
  blocked "01" \
    "these tools:$BREW_LIST" \
    "run: brew install$BREW_LIST" \
    "./scripts/01-install-tools.sh"
fi

case "$REPLY" in
  [yY]*) ;;
  *) blocked "01" "these tools:$BREW_LIST" "run: brew install$BREW_LIST" "./scripts/01-install-tools.sh" ;;
esac

echo
# shellcheck disable=SC2086
brew install $BREW_LIST

echo
step "Re-checking"
exec "$0"
