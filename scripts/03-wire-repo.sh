#!/usr/bin/env bash
# 03 — wires this checkout: the direnv shell hook (so .env loads on cd), direnv's
# authorization for .envrc, and the git pre-commit hook. Idempotent; backs up your shell rc first.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

header "03" "wire repo" "Installs the direnv shell hook, authorizes .envrc, links the pre-commit hook."

have direnv || require_step "direnv" "./scripts/01-install-tools.sh"
[ -f "$REPO_ROOT/.env" ] || require_step ".env" "./scripts/02-create-env.sh"

# --- 1. the shell hook -------------------------------------------------------
step "direnv hook in your shell rc"
case "$(basename "${SHELL:-/bin/zsh}")" in
  zsh)  RC="$HOME/.zshrc";  HOOK='eval "$(direnv hook zsh)"' ;;
  bash) RC="$HOME/.bashrc"; HOOK='eval "$(direnv hook bash)"' ;;
  fish) RC="$HOME/.config/fish/config.fish"; HOOK='direnv hook fish | source' ;;
  *)    die "unrecognised shell '${SHELL:-}' — add the direnv hook by hand: https://direnv.net/docs/hook.html" ;;
esac

if [ -f "$RC" ] && grep -q 'direnv hook' "$RC"; then
  ok "already present in ${RC/#$HOME/\~}"
else
  cp "$RC" "$RC.bak-$(date +%Y%m%d%H%M%S)" 2>/dev/null && info "backed up ${RC/#$HOME/\~}"
  printf '\n# direnv — loads .envrc per directory (high-load-test repo needs it)\n%s\n' "$HOOK" >> "$RC"
  ok "appended to ${RC/#$HOME/\~}"
  warn "open a new terminal, or run: exec $(basename "${SHELL:-zsh}")"
fi

# --- 2. authorize .envrc -----------------------------------------------------
echo
step "direnv authorization for .envrc"
( cd "$REPO_ROOT" && direnv allow . )
ok "allowed — re-run this script, or 'direnv allow', after any .env or .envrc edit"

# --- 3. the git pre-commit hook ----------------------------------------------
echo
step "git pre-commit hook (terraform fmt + validate)"
HOOK_PATH="$(git -C "$REPO_ROOT" rev-parse --git-common-dir)/hooks/pre-commit"
case "$HOOK_PATH" in /*) ;; *) HOOK_PATH="$REPO_ROOT/$HOOK_PATH" ;; esac
if [ -L "$HOOK_PATH" ] && [ "$(readlink "$HOOK_PATH")" = "$REPO_ROOT/scripts/pre-commit" ]; then
  ok "already linked"
elif [ -e "$HOOK_PATH" ]; then
  warn "$HOOK_PATH exists and is not ours — left alone; link scripts/pre-commit by hand"
else
  ln -s "$REPO_ROOT/scripts/pre-commit" "$HOOK_PATH"
  ok "linked $HOOK_PATH -> scripts/pre-commit"
fi

# --- what direnv now exports -------------------------------------------------
echo
step "What loads on cd into this directory"
COUNT=$(cd "$REPO_ROOT" && direnv exec . env 2>/dev/null | grep -cE '^(AWS_|TF_|TFE_|GRAFANA_|K6_)' || true)
if [ "${COUNT:-0}" -gt 0 ]; then
  ok "$COUNT variables — AWS keys, TF_CLOUD_*, TFE_TOKEN, the TF_VAR_* aliases, Grafana and k6"
  info "AWS_PROFILE is unset inside this directory, so ~/.aws cannot outrank .env"
else
  bad "direnv exported nothing — check .env is filled in (./scripts/02-create-env.sh)"
  exit 1
fi

handoff "03" \
  "a shell that loads .env on cd, and an authorized .envrc" \
  "./scripts/04-verify-setup.sh" \
  "04 reads the loaded environment to prove the credentials actually work"
