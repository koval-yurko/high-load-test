#!/usr/bin/env bash
# PostToolUse: after Claude edits a .tf/.tfvars file, format it and validate the root module that
# owns it. CLAUDE.md asks for fmt + validate in every HCL task; a rule nobody runs let an unformatted
# dev.tfvars reach master, so this runs it instead of asking.
#
# Exit 2 hands stderr back to Claude so it fixes the error in the same turn. Anything this script
# cannot judge (not a Terraform file, root never initialised) exits 0 — it never blocks on itself.
set -uo pipefail

file=$(jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0
case "$file" in *.tf|*.tfvars) ;; *) exit 0 ;; esac
[ -f "$file" ] || exit 0

terraform fmt "$file" >/dev/null 2>&1 || {
  echo "terraform fmt could not parse $file:" >&2
  terraform fmt -no-color "$file" 2>&1 | head -20 >&2
  exit 2
}

# The root that owns the file: a project's infra/* modules are all called from infra/main;
# otherwise the nearest directory up whose .tf files declare a cloud {} block (platform/).
dir=$(cd "$(dirname "$file")" && pwd)
case "$dir" in
  */infra/*) root="${dir%/infra/*}/infra/main" ;;
  *)
    root="$dir"
    until grep -qs 'cloud {' "$root"/*.tf || [ "$root" = / ]; do root=$(dirname "$root"); done
    ;;
esac
[ -d "$root/.terraform" ] || exit 0   # never initialised here: validate would only say "run init"

out=$(terraform -chdir="$root" validate -no-color 2>&1) || {
  printf 'terraform validate failed in %s after editing %s:\n%s\n' "$root" "$file" "$(printf '%s\n' "$out" | sed -n '/^Error:/,$p')" | head -40 >&2
  exit 2
}
exit 0
