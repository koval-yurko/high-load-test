#!/bin/sh
# SessionStart: report when the graph's doc half is behind the docs themselves.
#
# Code freshness is handled by the post-commit / post-checkout hooks. Those are
# AST-only and, by design, never re-extract docs or YAML — and they are inert in
# linked worktrees. This check covers both gaps.
#
# graphify's own needs_update flag does not help: it is written only by
# `graphify watch` (watch.py:2187), which needs the watchdog extra and a live
# daemon per checkout.
set -u

G=graphify-out/graph.json
[ -f "$G" ] || exit 0

# Ask git which files are ours rather than maintaining a prune list. This gets
# .gitignore for free — without it the check reported vendored provider docs
# under .terraform/providers/…, which nests at arbitrary depth and would have
# made the warning fire on every session for files nobody edits.
# --others --exclude-standard keeps new, not-yet-committed docs in scope.
stale=$(git ls-files --cached --others --exclude-standard -z -- '*.md' '*.yaml' '*.yml' 2>/dev/null \
        | while IFS= read -r -d '' f; do
              [ -f "$f" ] && [ "$f" -nt "$G" ] && printf '%s\n' "$f"
          done \
        | head -8)

[ -n "$stale" ] || exit 0

count=$(printf '%s\n' "$stale" | wc -l | tr -d ' ')
list=$(printf '%s\n' "$stale" | paste -sd', ' -)

jq -nc --arg c "$count" --arg l "$list" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: ("graphify: \($c) doc/YAML file(s) are newer than the knowledge graph (\($l)). The code half of the graph is current, but its doc half — including slo.yaml and the specs — predates these edits. To refresh: `git pull` if CI has already regenerated the semantic cache on master, or `graphify extract . --backend claude-cli --max-workers 2` to do it now (cached entries replay free; only changed files cost anything).")
  }
}'
