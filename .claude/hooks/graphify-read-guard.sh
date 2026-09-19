#!/bin/sh
# Widen graphify's read guard to the file types this repo is actually made of.
#
# graphify tests a read target against a hardcoded extension tuple
# (_HOOK_SOURCE_EXTS, cli.py:71) covering .py/.js/.sh/.md and 25 others. It has
# no .tf, .tfvars, .yaml or .yml, and none of the ~55 GRAPHIFY_* environment
# variables extends it. Terraform is roughly 40% of the code files here, so the
# stock guard nudges on JavaScript and shell reads while staying silent on the
# files we spend most of our time in.
#
# Anything outside our four extensions is handed to graphify untouched, so its
# staleness softening, out-of-project skips and fail-open behaviour are all
# preserved for every type it already covers.
set -u

payload=$(cat)

# graphify reads the same keys from the same place (cli.py:851):
#   t = d.get("tool_input", d);  t["file_path"] | t["path"]
target=$(printf '%s' "$payload" | jq -r '(.tool_input // .) | (.file_path // .path // "")' 2>/dev/null) || target=""

case "$target" in
    # Never nudge someone toward the graph for reading the graph's own files.
    graphify-out/*|*/graphify-out/*) exit 0 ;;
    *.tf|*.tfvars|*.yaml|*.yml)
        [ -f graphify-out/graph.json ] || exit 0
        jq -nc --arg msg "graphify: this file is covered by the knowledge graph at graphify-out/. For orientation — where something is defined, what depends on it — prefer \`graphify query \"<question>\"\`, \`graphify explain \"<node>\"\` or \`graphify affected \"<node>\"\` over reading raw files. Build the query from the graph's own vocabulary: matching is case-folded substring with no stemming and no synonyms. Reading the file directly to edit or debug specific lines is fine." \
            '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$msg}}'
        exit 0
        ;;
esac

printf '%s' "$payload" | graphify hook-guard read
