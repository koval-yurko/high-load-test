# graffiti → graphify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** **complete** (2026-09-19). All 11 tasks executed; both gates passed.

| task | commit | note |
|---|---|---|
| 1 — Gate 1 | (no commit) | 17 tf nodes vs graffiti's 0, 6,743B vs 8,210B |
| 2 — `.gitignore` | `8ebbe64` | nested re-inclusion; validated against 47 real entries |
| 3 — Gate 2 | `352faea` | 47 hits / 0 miss, 818 nodes in 0.95s vs 10m43s cold |
| 4 — read guard | `b80cff2` | uses `jq -n`, not `printf` |
| 5 — doc-stale hook | `bd1b688` | uses `git ls-files`, not a prune list |
| 6 — settings wiring | `26ca83a` | search guard verified firing live |
| 7 — project skill | `b51336c`, `dc44b8b` | |
| 8 — git hooks | (untracked) | merge driver stripped; `.gitattributes` removed |
| 9 — CI workflow | `82b9d5b` | `--max-workers 2` added after an OOM |
| 10 — docs | `219c0e7` | |
| 11 — remove graffiti | `dfde446` | |

**Four deviations from this plan as written**, all recorded in the commits that made them:

1. **Task 4 builds JSON with `jq -n`**, not `printf`. The nudge text contains both quote species
   and an apostrophe; the sketched nested escaping was a latent quoting bug for no benefit.
2. **Task 5 asks `git ls-files --cached --others --exclude-standard`** instead of walking with a
   prune list. The `find` version reported vendored provider docs under `.terraform/providers/`,
   which nests arbitrarily deep — deferring to `.gitignore` fixes the class, not the instance.
3. **Task 9 passes `--max-workers 2`.** An unconstrained pass was killed for memory exhaustion
   during Task 3; the runner gets the constraint rather than discovering it in CI.
4. **Task 11 Step 4's expectation was wrong as worded.** It expected the same `.tf` nodes Task 1
   produced. With docs semantically indexed, `"dynamodb table read capacity provisioned"` returns
   **0** Terraform nodes while `"aws_dynamodb_table read_capacity"` returns **26** — doc labels are
   sentences containing the query words, code labels are identifiers. Nothing is missing (206 `.tf`
   nodes are present); the ranking differs by query shape. Recorded in the skill.

**Still open:** the §12 question — whether `--backend claude-cli` authenticates from
`CLAUDE_CODE_OAUTH_TOKEN` in a runner — resolves only on the first push to master that touches
docs or YAML. The fallback if it fails is `anthropics/claude-code-action@v1` with a prompt, and it
changes one step of one workflow.

**Goal:** Replace `graffiti` with `graphify` as this repo's code map, committing only the
LLM-extracted semantic cache.

**Architecture:** graphify's project integration is adopted with two local modifications — its read
guard is wrapped so it also fires on `.tf`/`.tfvars`/`.yaml`/`.yml`, and its output directory is
ignored except `cache/semantic/`, the one artifact that costs LLM calls to recreate. Code
extraction stays local and free (`graphify update .`, plus git hooks); semantic extraction over
docs and YAML runs by hand or from a master-only CI job on the Claude subscription.

**Tech Stack:** graphify 0.9.62 (`graphifyy[terraform]`, installed via `uv tool`), Claude Code
hooks (`PreToolUse`, `SessionStart`), POSIX `sh` + `jq` 1.7, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-19-graffiti-to-graphify-design.md`

## Global Constraints

- **`uv tool install "graphifyy[terraform]"` is mandatory.** Without the HCL extra, 30 `.tf`, 2
  `.hcl` and 1 `.tfvars` file contribute nothing to the graph — 33 of 81 code files — and the
  failure is a warning, not an error.
- **Never pass `--strict`** to `graphify hook-guard`. It hard-denies the first raw `Read` per
  session, and the graph will never cover everything (`.envrc` is skipped as sensitive,
  `Dockerfile` and `.tftpl` are unclassified).
- **`.gitignore` must use nested re-inclusion.** `graphify-out/` followed by
  `!graphify-out/cache/semantic*/` re-includes nothing and fails *silently*. The exact working
  block is in Task 2.
- **CI runs on `master` only**, guarded by `if: github.actor != 'claude[bot]'`.
- **Do not touch `.claude/hooks/guard-terraform.sh`** or the `permissions.ask` entries for
  `terraform apply` / `terraform destroy` in `.claude/settings.json`. They are the repo's only
  mechanical guard against unattended AWS spend.
- **graffiti is deleted last** (Task 11), only after Tasks 1 and 3 both pass. Until then it is the
  control.
- **Commits follow Conventional Commits** with scope `repo`. Claude-authored commits end with:

  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JL3hZoaTnfKxtq9Z63v1Pf
  ```

- **Branch:** work directly on `master` (the user chose this for the spec commit; keep it
  consistent unless told otherwise).

---

### Task 1: Gate 1 — prove graphify sees Terraform, and beats graffiti

**Files:**
- Create: none. This task writes nothing into the repo — `GRAPHIFY_OUT` is pointed at a scratchpad
  directory so `git status` stays clean whatever the outcome.
- Test: the two commands below are the test.

**Interfaces:**
- Consumes: nothing.
- Produces: a go/no-go decision. Every later task assumes this one passed.

**This is a stop gate.** If graphify answers worse than graffiti, do not continue — report the
comparison and stop. The spec's premise would be wrong, and that is a legitimate outcome.

- [ ] **Step 1: Build the graph WITHOUT the terraform extra, and watch it fail**

```bash
export GRAPHIFY_OUT=/tmp/graphify-gate1
cd /Users/koval/dev/test/high-load-test
graphify update . 2>&1 | grep -i "contributed nothing\|tree_sitter_hcl" || echo "NO WARNING — unexpected"
```

Expected: warnings naming `30 .tf file(s)`, `2 .hcl file(s)` and `1 .tfvars file(s)` as
contributing nothing, each citing `tree_sitter_hcl not installed`.

- [ ] **Step 2: Confirm the Terraform question is unanswerable**

```bash
graphify query "dynamodb table read capacity provisioned" --graph /tmp/graphify-gate1/graph.json
```

Expected: no nodes whose `src=` is a `.tf` or `.tfvars` file. This is the failing assertion — the
graph cannot answer a question about the thing this repo is made of.

- [ ] **Step 3: Install the extra**

```bash
uv tool install --force "graphifyy[terraform]"
graphify --version   # expect: graphify 0.9.62 (or newer)
```

- [ ] **Step 4: Rebuild and confirm the warnings are gone**

```bash
graphify update . 2>&1 | grep -i "contributed nothing" && echo "STILL BLIND — stop" || echo "HCL extraction OK"
```

Expected: `HCL extraction OK`.

- [ ] **Step 5: Run the identical query and confirm it now answers**

```bash
graphify query "dynamodb table read capacity provisioned" --graph /tmp/graphify-gate1/graph.json
```

Expected: nodes with `src=ecs-dynamodb-rps/infra/main/*.tf` or `dev.tfvars`. Commit `659d33e`
moved `read_capacity` / `write_capacity` into `infra/main/dev.tfvars`, so that file is the ground
truth.

- [ ] **Step 6: Gate 1b — the head-to-head against graffiti**

```bash
graffiti query "dynamodb table read capacity provisioned" | tee /tmp/gate1-graffiti.txt | wc -c
graphify query "dynamodb table read capacity provisioned" --graph /tmp/graphify-gate1/graph.json \
  | tee /tmp/gate1-graphify.txt | wc -c
```

Read both outputs. Judge on **whether the answer is correct and locatable**, not on size alone — a
prior measurement had graphify at 20.5 KB against graffiti's 8.2 KB for a comparable question, so
graphify is expected to be more verbose. The gate fails only if graphify's answer is *worse*: it
misses the capacity definition, or points at the wrong file, or returns nodes so unranked that the
answer is not findable.

- [ ] **Step 7: Record the verdict and decide**

Write the two outputs and the verdict into the session notes. If graphify lost, STOP and report. If
it won or tied, continue to Task 2.

```bash
unset GRAPHIFY_OUT
rm -rf /tmp/graphify-gate1
```

No commit — this task changed nothing in the repo.

---

### Task 2: `.gitignore` — ignore the graph, keep the semantic cache

**Files:**
- Modify: `.gitignore` (the `# graffiti code map` block near the end of the file)

**Interfaces:**
- Consumes: nothing.
- Produces: the ignore rules every later task relies on. Task 3 cannot commit a cache entry without
  this.

- [ ] **Step 1: Write the failing test — prove the naive pattern does not work**

The point of this step is to see the silent failure before trusting the fix.

```bash
T=$(mktemp -d); cd "$T" && git init -q .
mkdir -p graphify-out/cache/semantic/p5e8 graphify-out/2026-09-19
echo '{}' > graphify-out/cache/semantic/p5e8/abc.json
echo '{}' > graphify-out/graph.json
echo '{}' > graphify-out/2026-09-19/graph.json
printf 'graphify-out/\n!graphify-out/cache/semantic*/\n' > .gitignore
git status --porcelain --untracked-files=all
```

Expected: **only `?? .gitignore`.** The cache entry is invisible. Git does not descend into an
excluded directory, so the negation never applies — and nothing warns you.

- [ ] **Step 2: Confirm the nested form works**

```bash
printf 'graphify-out/*\n!graphify-out/cache/\ngraphify-out/cache/*\n!graphify-out/cache/semantic/\n!graphify-out/cache/semantic-deep/\n' > .gitignore
git status --porcelain --untracked-files=all
cd - && rm -rf "$T"
```

Expected: `?? .gitignore` **and** `?? graphify-out/cache/semantic/p5e8/abc.json`, with
`graph.json`, `2026-09-19/` and `cache/stat-index.json` all absent.

- [ ] **Step 3: Replace the graffiti block in the real `.gitignore`**

Find this block at the end of `.gitignore`:

```gitignore
# graffiti code map — generated by `graffiti .`, rebuild with `graffiti update`
.graffiti/
```

Replace it with:

```gitignore
# graphify code map. Everything here is regenerated by `graphify update .` except
# cache/semantic/, which holds LLM-extracted entries for docs and YAML — the one
# output that costs money to recreate, so it is committed and shared.
#
# The nesting is load-bearing: `graphify-out/` plus a `!…/cache/semantic/` negation
# re-includes NOTHING, because git does not descend into an excluded directory. It
# fails silently, so do not "simplify" this back to two lines.
graphify-out/*
!graphify-out/cache/
graphify-out/cache/*
!graphify-out/cache/semantic/
!graphify-out/cache/semantic-deep/
```

- [ ] **Step 4: Verify against the real repo**

```bash
cd /Users/koval/dev/test/high-load-test
mkdir -p graphify-out/cache/semantic/ptest && echo '{}' > graphify-out/cache/semantic/ptest/x.json
echo '{}' > graphify-out/graph.json
git status --porcelain --untracked-files=all | grep graphify-out
rm -rf graphify-out
```

Expected: exactly one line, `?? graphify-out/cache/semantic/ptest/x.json`. If `graph.json` appears,
the block is wrong.

- [ ] **Step 5: Commit**

```bash
git add .gitignore
git commit -m "$(cat <<'EOF'
chore(repo): ignore the graphify graph, keep its semantic cache

Everything graphify writes is regenerated for free by an AST pass except
cache/semantic/, whose entries are produced by LLM calls. graphify's own
layout already draws this line: AST entries are version-namespaced and
discarded on upgrade, semantic entries deliberately are not, because
"re-extraction costs LLM calls" (cache.py). Entries are keyed by source
content hash, so they are portable across clones and cannot conflict.

The nested re-inclusion is not stylistic. A plain `graphify-out/` with a
`!.../cache/semantic/` negation re-includes nothing, since git never
descends into an excluded directory, and it fails with no warning at all:
`git add` would stage zero files forever while looking healthy.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JL3hZoaTnfKxtq9Z63v1Pf
EOF
)"
```

---

### Task 3: Gate 2 — prove a committed semantic cache replays for free

**Files:**
- Create: `graphify-out/cache/semantic/**` (committed — the first real cache entries)

**Interfaces:**
- Consumes: the ignore rules from Task 2.
- Produces: a populated, committed semantic cache. Task 9's CI job is a no-op safety net on top of
  this; Task 10's README documents the command used here.

**This is a stop gate.** If the cache does not replay for free, the `.gitignore` negation from
Task 2 and the CI job in Task 9 both come out, and the design reverts to ignoring everything.

- [ ] **Step 1: Run the full pass over the repo**

```bash
cd /Users/koval/dev/test/high-load-test
graphify extract . --backend claude-cli
```

Expected: a `found N code, M docs…` line, `semantic extraction on M files via claude-cli`, and a
cost line reading `est. cost (~claude-cli): $0.0000` — that zero is the evidence it billed the
subscription and not an API key. A probe run on 2026-09-19 took 16.4s for a single doc file; the
repo has ~43, so expect minutes, not seconds.

- [ ] **Step 2: Confirm the docs actually entered the graph**

```bash
graphify query "slo error budget burn rate" | head -30
```

Expected: at least one node whose `src=` is `ecs-dynamodb-rps/slo.yaml` or a file under
`docs/superpowers/specs/`. If every node is a `.js` or `.tf` file, semantic extraction did not
cover the docs and the premise fails.

- [ ] **Step 3: Record the cache fingerprint**

```bash
find graphify-out/cache/semantic -type f -exec md5 -q {} \; | sort | md5 -q > /tmp/cache-before.txt
cat /tmp/cache-before.txt
```

- [ ] **Step 4: Destroy the derived outputs, keep only the cache**

```bash
rm -f graphify-out/graph.json graphify-out/manifest.json
rm -rf graphify-out/cache/ast
```

- [ ] **Step 5: Rebuild and verify zero LLM calls**

```bash
graphify extract . --backend claude-cli 2>&1 | tee /tmp/gate2-replay.txt | grep -i "incremental summary\|semantic extraction\|tokens"
```

Expected: `incremental summary: N files cached/unchanged, 0 re-extracted`. A non-zero
`re-extracted` count, or any `tokens:` line above zero, means the cache did not replay — **the gate
fails**.

- [ ] **Step 6: Verify the cache is byte-stable**

```bash
find graphify-out/cache/semantic -type f -exec md5 -q {} \; | sort | md5 -q
diff <(cat /tmp/cache-before.txt) <(find graphify-out/cache/semantic -type f -exec md5 -q {} \; | sort | md5 -q) \
  && echo "BYTE-STABLE" || echo "UNSTABLE — the empty-commit guard in Task 9 will not hold"
```

Expected: `BYTE-STABLE`. This is what makes `git diff --cached --quiet` an exact guard rather than
an approximate one. Verified on the probe: `cache.py` contains no `time()`, `datetime`, `utcnow` or
`isoformat`, so entries carry no timestamps.

- [ ] **Step 7: Commit the cache**

```bash
git add graphify-out/cache/semantic/
git status --porcelain | grep -v '^A ' && echo "UNEXPECTED non-cache changes — inspect before committing"
git commit -m "$(cat <<'EOF'
chore(repo): add the graphify semantic cache for docs and yaml

First population of the cache that Task 2's ignore rules keep. These
entries are the output of LLM extraction over the markdown and YAML that
the AST extractor cannot read -- slo.yaml above all, which is the SLO
source of truth and has no structural extractor at all.

Verified they replay for free: deleting graph.json, manifest.json and the
AST cache and rebuilding reported every doc file cached/unchanged with
zero re-extractions, and the cache tree's md5 was unchanged, so a warm
re-run produces no diff.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JL3hZoaTnfKxtq9Z63v1Pf
EOF
)"
```

---

### Task 4: The read-guard wrapper

**Files:**
- Create: `.claude/hooks/graphify-read-guard.sh`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: an executable at `.claude/hooks/graphify-read-guard.sh` that Task 6 wires into
  `.claude/settings.json` as the `Read|Glob` `PreToolUse` command. Contract: reads a Claude Code
  `PreToolUse` JSON payload on stdin, writes either nothing or one
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"…"}}` object to stdout,
  and always exits 0.

- [ ] **Step 1: Write the script**

```sh
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
        if [ -f graphify-out/graph.json ]; then
            printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"graphify: this file is covered by the knowledge graph at graphify-out/. For orientation — where something is defined, what depends on it — prefer `graphify query \"<question>\"`, `graphify explain \"<node>\"` or `graphify affected \"<node>\"` over reading raw files. Build the query from the graph'"'"'s own vocabulary: matching is case-folded substring with no stemming and no synonyms. Reading the file directly to edit or debug specific lines is fine."}}'
        fi
        exit 0
        ;;
esac

printf '%s' "$payload" | graphify hook-guard read
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x .claude/hooks/graphify-read-guard.sh
```

- [ ] **Step 3: Test — a Terraform read nudges**

```bash
cd /Users/koval/dev/test/high-load-test
mkdir -p graphify-out && echo '{"nodes":[],"edges":[]}' > graphify-out/graph.json
echo '{"tool_name":"Read","tool_input":{"file_path":"ecs-dynamodb-rps/infra/main/dev.tfvars"}}' \
  | ./.claude/hooks/graphify-read-guard.sh | jq -e '.hookSpecificOutput.additionalContext' >/dev/null \
  && echo "PASS: tfvars nudged" || echo "FAIL"
```

Expected: `PASS: tfvars nudged`.

- [ ] **Step 4: Test — YAML nudges, and the JSON is valid**

```bash
echo '{"tool_name":"Read","tool_input":{"file_path":"ecs-dynamodb-rps/slo.yaml"}}' \
  | ./.claude/hooks/graphify-read-guard.sh | jq -e '.hookSpecificOutput.hookEventName == "PreToolUse"' >/dev/null \
  && echo "PASS: yaml nudged, JSON valid" || echo "FAIL"
```

Expected: `PASS: yaml nudged, JSON valid`. `jq -e` failing here means the embedded quoting in the
`printf` is broken — that single-quote dance around `graph'"'"'s` is the likely culprit.

- [ ] **Step 5: Test — the graph's own files are never nudged**

```bash
echo '{"tool_name":"Read","tool_input":{"file_path":"graphify-out/GRAPH_REPORT.md"}}' \
  | ./.claude/hooks/graphify-read-guard.sh | wc -c
```

Expected: `0`.

- [ ] **Step 6: Test — delegation is intact for types graphify already covers**

```bash
echo '{"tool_name":"Read","tool_input":{"file_path":"ecs-dynamodb-rps/service/src/index.js"}}' \
  | ./.claude/hooks/graphify-read-guard.sh | head -c 200; echo
```

Expected: graphify's own nudge JSON (mentioning `graphify query`), proving the fall-through reached
`graphify hook-guard read` with stdin intact rather than an empty pipe.

- [ ] **Step 7: Test — no graph means silence**

```bash
rm -rf graphify-out
echo '{"tool_name":"Read","tool_input":{"file_path":"ecs-dynamodb-rps/slo.yaml"}}' \
  | ./.claude/hooks/graphify-read-guard.sh | wc -c
```

Expected: `0`. A fresh clone with no graph built must not be nagged.

- [ ] **Step 8: Commit**

```bash
git add .claude/hooks/graphify-read-guard.sh
git commit -m "$(cat <<'EOF'
feat(repo): widen the graphify read guard to terraform and yaml

graphify decides whether to nudge a file read by testing it against a
hardcoded extension tuple that lists .py, .js, .sh, .md and 25 others but
none of .tf, .tfvars, .yaml or .yml, and no environment variable extends
it. Terraform is about 40% of the code files here, so the stock guard
would have nudged on JavaScript and shell while staying quiet on the
files this repo is mostly made of.

The wrapper handles only those four extensions and pipes everything else
to `graphify hook-guard read` untouched, so upstream staleness softening,
out-of-project skipping and fail-open behaviour are preserved.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JL3hZoaTnfKxtq9Z63v1Pf
EOF
)"
```

---

### Task 5: The doc-staleness SessionStart hook

**Files:**
- Create: `.claude/hooks/graphify-doc-stale.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: an executable wired by Task 6 as the `SessionStart` command.

**Why this exists:** graphify's own staleness flag (`graphify-out/needs_update`) is written *only*
by `graphify watch` (`watch.py:2187`), which needs the `watchdog` extra and a live daemon per
checkout. `graphify update` never sets it, so the git hooks from Task 8 cannot report that the doc
half of the graph is behind. This is five lines of `find -newer` instead, and unlike the git hooks
it works identically inside linked worktrees.

- [ ] **Step 1: Write the script**

```sh
#!/bin/sh
# SessionStart: report when the graph's doc half is behind the docs themselves.
#
# Code freshness is handled by the post-commit / post-checkout hooks. Those are
# AST-only and, by design, never re-extract docs or YAML — and they are inert in
# linked worktrees. This check covers both gaps.
set -u

G=graphify-out/graph.json
[ -f "$G" ] || exit 0

stale=$(find . \
        -path ./node_modules -prune -o \
        -path ./graphify-out -prune -o \
        -path ./.git -prune -o \
        \( -name '*.md' -o -name '*.yaml' -o -name '*.yml' \) -newer "$G" -print 2>/dev/null \
        | head -8)

[ -n "$stale" ] || exit 0

count=$(printf '%s\n' "$stale" | wc -l | tr -d ' ')
list=$(printf '%s\n' "$stale" | sed 's/^\.\///' | paste -sd', ' -)

printf '%s' "$(jq -nc --arg c "$count" --arg l "$list" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: ("graphify: \($c) doc/YAML file(s) are newer than the knowledge graph (\($l)). The graph'"'"'s code half is current, but its doc half — including slo.yaml and the specs — predates these edits. To refresh: `git pull` if CI has already regenerated the semantic cache on master, or `graphify extract . --backend claude-cli` to do it now (cached entries replay free; only changed files cost anything).")
  }
}')"
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x .claude/hooks/graphify-doc-stale.sh
```

- [ ] **Step 3: Test — no graph means silence**

```bash
cd /Users/koval/dev/test/high-load-test
rm -rf graphify-out
./.claude/hooks/graphify-doc-stale.sh | wc -c
```

Expected: `0`.

- [ ] **Step 4: Test — a fresh graph means silence**

```bash
mkdir -p graphify-out && touch graphify-out/graph.json   # newer than every doc
./.claude/hooks/graphify-doc-stale.sh | wc -c
```

Expected: `0`.

- [ ] **Step 5: Test — a stale graph reports, with valid JSON**

```bash
touch -t 202001010000 graphify-out/graph.json            # older than every doc
./.claude/hooks/graphify-doc-stale.sh | jq -e '.hookSpecificOutput.additionalContext' \
  && echo "PASS" || echo "FAIL"
```

Expected: the context string printed, then `PASS`. It should name a count and a comma-separated
file list.

- [ ] **Step 6: Test — graphify's own outputs never count as stale docs**

```bash
mkdir -p graphify-out && echo '# report' > graphify-out/GRAPH_REPORT.md
touch graphify-out/GRAPH_REPORT.md
./.claude/hooks/graphify-doc-stale.sh | grep -c GRAPH_REPORT
rm -rf graphify-out
```

Expected: `0`. A `GRAPH_REPORT.md` newer than `graph.json` is normal and must not trigger the
warning.

- [ ] **Step 7: Verify the SessionStart payload shape against the live harness**

The `PreToolUse` contract is confirmed from graphify's source; `SessionStart`'s
`additionalContext` field is **not** verified in this repo. Run `/hooks` in Claude Code and confirm
the hook is listed and produced no error. If the harness rejects the payload, fall back to plain
stdout text (drop the `jq -nc` wrapper and `printf` the message directly) — the message matters,
the envelope does not.

- [ ] **Step 8: Commit**

```bash
git add .claude/hooks/graphify-doc-stale.sh
git commit -m "$(cat <<'EOF'
feat(repo): warn at session start when the doc graph is stale

The git hooks keep the code half of the graph current, but they are
AST-only and never re-extract docs or YAML, and they exit early inside
linked worktrees. graphify's own needs_update flag does not fill the gap:
it is written only by `graphify watch`, which needs an extra package and a
live daemon per checkout.

A find -newer comparison at session start covers both cases and works the
same in a worktree as in the main checkout.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JL3hZoaTnfKxtq9Z63v1Pf
EOF
)"
```

---

### Task 6: Wire the hooks into `.claude/settings.json`

**Files:**
- Modify: `.claude/settings.json` (the `hooks` object)

**Interfaces:**
- Consumes: `.claude/hooks/graphify-read-guard.sh` (Task 4),
  `.claude/hooks/graphify-doc-stale.sh` (Task 5).
- Produces: the live hook wiring.

**Do not touch** the `permissions` object. `Bash(terraform apply*)` and friends stay exactly as
they are.

- [ ] **Step 1: Replace the `hooks` object**

The file currently contains:

```json
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "command": "graffiti hook",
            "type": "command"
          }
        ],
        "matcher": "Grep|Glob"
      }
    ]
  },
```

Replace that `hooks` value with:

```json
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Grep",
        "hooks": [
          {
            "type": "command",
            "command": "graphify hook-guard search",
            "timeout": 10
          }
        ]
      },
      {
        "matcher": "Read|Glob",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/graphify-read-guard.sh",
            "timeout": 10
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/graphify-doc-stale.sh",
            "timeout": 10
          }
        ]
      }
    ]
  },
```

Note `$CLAUDE_PROJECT_DIR` rather than a relative path. A relative path resolves against the
session's working directory and breaks in worktree sessions — see the memory note that worktree
sessions need absolute-path helper scripts. There is **no** existing hook entry in this file to
copy the spelling from: `.claude/hooks/guard-terraform.sh` exists on disk but is registered
nowhere (see the note at the end of this plan).

- [ ] **Step 2: Validate the JSON**

```bash
jq -e '.hooks.PreToolUse | length == 2' .claude/settings.json && echo "PASS: two PreToolUse entries"
jq -e '.permissions.ask | index("Bash(terraform apply*)")' .claude/settings.json >/dev/null \
  && echo "PASS: terraform ask-rules intact" || echo "FAIL — restore them"
jq -e '.hooks | has("SessionStart")' .claude/settings.json >/dev/null && echo "PASS: SessionStart present"
```

All three must print PASS.

- [ ] **Step 3: Confirm no graffiti reference survives**

```bash
grep -c graffiti .claude/settings.json
```

Expected: `0`.

- [ ] **Step 4: Load the hooks and verify they fire**

Run `/hooks` in Claude Code (settings are only re-read for directories that existed at session
start — the README already documents this for the terraform guard). Confirm all three entries are
listed with no errors.

- [ ] **Step 5: Commit**

```bash
git add .claude/settings.json
git commit -m "$(cat <<'EOF'
feat(repo)!: point the code-map hooks at graphify

Replaces the single `Grep|Glob -> graffiti hook` entry with graphify's
two guards and the session-start staleness check. The search guard is
taken as shipped; the read guard goes through the local wrapper so it
also fires on .tf, .tfvars, .yaml and .yml.

--strict is deliberately not used. It hard-denies the first raw Read of a
session, and the graph never covers everything -- .envrc is skipped as
sensitive, Dockerfile and .tftpl are unclassified -- so a blanket block
would strand reads of files that have no graph nodes to consult.

The terraform apply/destroy ask-rules and guard-terraform.sh are
untouched.

BREAKING CHANGE: sessions started before this commit keep the old graffiti
hook until Claude Code is restarted or /hooks is opened. Run /hooks once
after pulling.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JL3hZoaTnfKxtq9Z63v1Pf
EOF
)"
```

---

### Task 7: The project skill

**Files:**
- Create: `.claude/skills/graphify/SKILL.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the skill Claude loads for codebase-structure questions. Task 11 deletes the graffiti
  skill this replaces.

**Keep it short.** graphify ships a 40 KB skill plus ~60 KB of references; copying that into the
repo buys context cost, not clarity. The graffiti skill it replaces is about 1 KB.

- [ ] **Step 1: Write the skill**

````markdown
---
name: graphify
description: Use when exploring or answering questions about THIS codebase's structure — where something is defined, how components connect, what the architecture looks like. graphify turns the repo into a queryable code map so you query the graph instead of grepping blind.
---

# graphify — read the map, don't grep blind

`graphify` turns this repository into a queryable knowledge graph at `graphify-out/`.
Building the code half needs no API key and costs nothing.

## Answering questions about the code

```bash
graphify query "<question>"        # scoped subgraph — prefer this over grep
graphify explain "<node>"          # one node, its neighbours, its source files
graphify path "<A>" "<B>"          # how two things connect, hop by hop
graphify affected "<node>"         # reverse traversal — blast radius of a change
graphify god-nodes                 # the most connected nodes; architectural hubs
```

**Build the query from the graph's own vocabulary, not from English.** Matching is
case-folded substring with IDF — no stemming, no synonyms, no cross-language matching.
"authentication" will not find `authHandler`. If a query returns nothing, that is the
first thing to suspect: run `graphify god-nodes` to see how things are actually named,
then re-query with those tokens.

## Keeping it current

- **After editing code:** `graphify update .` — AST only, no LLM, a few seconds.
  The `post-commit` and `post-checkout` git hooks do this automatically, but they are
  inert inside linked worktrees, so run it by hand there.
- **After editing docs, specs or `slo.yaml`:** those are *not* covered by `update`.
  They reach the graph only through `graphify extract . --backend claude-cli`, which
  costs LLM calls for changed files and replays cached ones for free. CI regenerates
  this on master, so `git pull` is usually enough.

## What is and is not in the graph

`.tf`, `.tfvars`, `.js`, `.sh`, `package.json` and markdown structure come from the AST
extractor. `.yaml` has **no** structural extractor — `slo.yaml` is present only if a
semantic pass has run. `.envrc` is skipped as sensitive; `Dockerfile` and `.tftpl` are
not classified at all. When the graph has nothing, grep is the right tool and the
session-start warning will tell you if the doc half is stale.
````

- [ ] **Step 2: Verify the frontmatter parses and the skill is discoverable**

```bash
head -4 .claude/skills/graphify/SKILL.md
ls .claude/skills/
```

Expected: valid YAML frontmatter with `name: graphify`, and the directory listed.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/graphify/SKILL.md
git commit -m "$(cat <<'EOF'
feat(repo): add the graphify project skill

Deliberately short, like the graffiti skill it replaces. graphify ships a
40KB skill plus about 60KB of references; vendoring that into the repo
would cost context on every session without telling us anything specific
to this codebase.

It carries the four things that are specific: the five query commands,
that `update` is code-only while docs and slo.yaml need a semantic pass,
that the git hooks are inert in worktrees, and that queries must be built
from the graph's own vocabulary because matching has no stemming and no
synonyms -- which is the single most common reason a query returns
nothing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JL3hZoaTnfKxtq9Z63v1Pf
EOF
)"
```

---

### Task 8: Git hooks for automatic code rebuilds

**Files:**
- Modify: `.git/hooks/post-commit`, `.git/hooks/post-checkout` (untracked by git — local state)
- Delete: the `.gitattributes` line the installer writes, if it creates one

**Interfaces:**
- Consumes: nothing.
- Produces: automatic AST rebuilds in the main checkout.

- [ ] **Step 1: Install the hooks**

```bash
cd /Users/koval/dev/test/high-load-test
graphify hook install
```

Expected output naming `post-commit`, `post-checkout` and `merge driver`.

- [ ] **Step 2: Remove the merge driver, which has nothing to act on**

The installer registers a `graph.json` merge driver and may write `.gitattributes`. `graph.json` is
ignored by Task 2, so a `.gitattributes` line pointing at it is a false signal that the graph is
tracked.

```bash
git config --unset merge.graphify.driver 2>/dev/null
git config --unset merge.graphify.name 2>/dev/null
if [ -f .gitattributes ]; then
  grep -v 'merge=graphify' .gitattributes > /tmp/ga && mv /tmp/ga .gitattributes
  [ -s .gitattributes ] || rm -f .gitattributes
fi
cat .gitattributes 2>/dev/null || echo "no .gitattributes — correct"
```

- [ ] **Step 3: Verify the post-commit hook is non-blocking**

```bash
touch /tmp/hooktest.md && git add -A 2>/dev/null
time git commit --allow-empty -m "test: verify graphify hook does not block" 2>&1 | tail -3
```

Expected: the commit returns in well under a second, printing
`[graphify hook] launching background rebuild`. The rebuild is detached by design
(`hooks.py:439`: *"Full-repo rebuilds can take hours; blocking the post-commit hook stalls the
shell"*). If the commit hangs, stop and investigate.

- [ ] **Step 4: Confirm the rebuild actually ran**

```bash
sleep 20; tail -5 ~/.cache/graphify-rebuild.log
```

Expected: recent lines showing an extraction completing.

- [ ] **Step 5: Drop the test commit**

```bash
git reset --hard HEAD~1
git log --oneline -1   # confirm the Task 7 commit is HEAD again
```

- [ ] **Step 6: Document the worktree limitation for the reader**

No action here beyond confirming the fact for Task 10's README text: both hooks compare
`git rev-parse --git-dir` against `--git-common-dir` and exit when they differ
(`hooks.py:365-371`), so they never fire in a linked worktree.

```bash
git worktree list
```

- [ ] **Step 7: Commit (only if `.gitattributes` changed)**

`.git/hooks/` is not tracked, so there may be nothing to commit. If Step 2 modified or removed
`.gitattributes`:

```bash
git add -A .gitattributes
git commit -m "$(cat <<'EOF'
chore(repo): drop the graphify merge driver

`graphify hook install` registers a union merge driver for
graphify-out/graph.json, which this repo does not track. A .gitattributes
line naming an ignored path tells the next reader the graph is committed,
which it is not -- only cache/semantic/ is.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JL3hZoaTnfKxtq9Z63v1Pf
EOF
)"
```

---

### Task 9: The master-only CI job

**Files:**
- Create: `.github/workflows/graphify-semantic-cache.yml`

**Interfaces:**
- Consumes: the ignore rules from Task 2 and the populated cache from Task 3.
- Produces: automatic cache refresh on master. This is a **safety net**, not the primary route —
  if the cache was refreshed by hand, this job finds every hash present, calls no LLM, stages
  nothing and exits without committing.

- [ ] **Step 1: Write the workflow**

```yaml
name: graphify semantic cache

# Master only, on purpose. Content-hash filenames make cache entries
# conflict-free between files; single-branch ownership makes them
# conflict-free within one. Feature branches never carry cache entries.
on:
  push:
    branches: [master]
    paths:
      - 'docs/**'
      - '**/*.md'
      - '**/*.yaml'
      - '**/*.yml'

jobs:
  extract:
    # Same guard claude-code-review.yml already uses: this job pushes, and
    # without it that push would re-trigger the job.
    if: github.actor != 'claude[bot]'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4

      - name: Install graphify
        run: pipx install "graphifyy[terraform]"

      - name: Semantic extraction
        run: graphify extract . --backend claude-cli
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}

      - name: Commit the cache, only if it changed
        run: |
          git config user.name  "claude[bot]"
          git config user.email "noreply@anthropic.com"
          git add graphify-out/cache/semantic/
          if git diff --cached --quiet; then
            echo "semantic cache unchanged — nothing to commit"
            exit 0
          fi
          git commit -m "chore(repo): refresh graphify semantic cache"
          git push
```

- [ ] **Step 2: Validate the YAML**

```bash
python3 -c "import yaml,sys; d=yaml.safe_load(open('.github/workflows/graphify-semantic-cache.yml')); print('branches:', d[True]['push']['branches']); print('guard:', d['jobs']['extract']['if'])"
```

Expected: `branches: ['master']` and the `claude[bot]` guard. (`d[True]` is not a typo — YAML
parses the bare key `on` as boolean true.)

- [ ] **Step 3: Confirm the empty-commit guard locally**

```bash
cd /Users/koval/dev/test/high-load-test
graphify extract . --backend claude-cli >/dev/null 2>&1
git add graphify-out/cache/semantic/
git diff --cached --quiet && echo "PASS: warm cache stages nothing" || echo "FAIL: would make an empty-ish commit"
git reset >/dev/null
```

Expected: `PASS`. Task 3 already proved the cache is byte-stable; this confirms the exact guard the
workflow uses agrees.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/graphify-semantic-cache.yml
git commit -m "$(cat <<'EOF'
ci(repo): refresh the graphify semantic cache on master

Semantic extraction over docs and YAML costs LLM calls, so its output is
committed rather than regenerated per clone. This job is the safety net
for the manual route: if the cache was already refreshed by hand, every
doc hash is present, no LLM is called, nothing is staged and no commit is
made.

Two independent guards stop empty commits -- the paths filter keeps the
job from starting unless docs or YAML changed, and `git diff --cached
--quiet` stops the commit when extraction produced nothing new, which is
exact because cache entries carry no timestamps.

Master only: content-hash filenames make entries conflict-free between
files, and single-branch ownership makes them conflict-free within one.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JL3hZoaTnfKxtq9Z63v1Pf
EOF
)"
```

- [ ] **Step 5: Watch the first real run — this is where the open question resolves**

Push to master and watch the job. The unresolved item from the spec is whether the `claude` binary
authenticates from `CLAUDE_CODE_OAUTH_TOKEN` inside a runner; the local probe could not test it,
because `claude` is authenticated by the user's own session on a workstation.

```bash
gh run list --workflow=graphify-semantic-cache.yml --limit 3
gh run view --log-failed
```

If the extraction step fails on authentication, replace the `Semantic extraction` step with
`anthropics/claude-code-action@v1` carrying `claude_code_oauth_token` and a prompt instructing it to
run the doc pass — the pattern `claude.yml` and `claude-code-review.yml` already prove in this
repo. Nothing else in the workflow changes.

---

### Task 10: Documentation — `CLAUDE.md` and `README.md`

**Files:**
- Modify: `CLAUDE.md` (the `## graffiti code map` section)
- Modify: `README.md` (new section after `## Prerequisites`; one row added to the prerequisites
  table)

**Interfaces:**
- Consumes: the commands established in Tasks 3, 4, 7 and 9.
- Produces: the written contract. `CLAUDE.md` says this file must be updated as reality diverges
  from it, so leaving the graffiti section in place is a defect, not a cosmetic gap.

- [ ] **Step 1: Replace the `CLAUDE.md` section**

Find:

```markdown
## graffiti code map

If `.graffiti/map.json` exists, this repo has a graffiti code map. For questions about the
codebase's structure (where something lives, how parts connect, the architecture), run
`graffiti query "<question>"` instead of grep/read — it returns a scoped subgraph. After
editing code, run `graffiti update` to refresh the map. If no map exists yet, run
`graffiti build .` first.
```

Replace with:

```markdown
## graphify code map

This repo is indexed as a queryable graph at `graphify-out/`. For questions about structure —
where something lives, how parts connect, what a change would affect — run
`graphify query "<question>"`, `graphify explain`, `graphify path`, `graphify affected` or
`graphify god-nodes` instead of grepping blind. Build queries from the graph's own vocabulary:
matching is case-folded substring with no stemming and no synonyms, so an empty result usually
means the wrong word, not a missing node.

**Two halves, refreshed differently.** Code (`.tf`, `.js`, `.sh`, `package.json`) comes from a
free offline AST pass: `graphify update .`, run automatically by the `post-commit` and
`post-checkout` git hooks — which are inert inside linked worktrees, so run it by hand there.
Docs, specs and `slo.yaml` come only from semantic extraction, which costs LLM calls:
`graphify extract . --backend claude-cli`. A `SessionStart` hook says when that half is stale.

**`graphify-out/` is ignored except `cache/semantic/`, which is committed.** That directory holds
the LLM-extracted entries, keyed by source content hash, so the paid work is shared rather than
repeated per clone — and a warm cache replays for free. The ignore block's nesting is load-bearing
and must not be collapsed; the reason is written above it in `.gitignore`. CI regenerates the cache
on master, so `git pull` is usually enough; regenerating by hand and committing
`graphify-out/cache/semantic/` is equally valid and makes CI a no-op.

Full reasoning: `docs/superpowers/specs/2026-09-19-graffiti-to-graphify-design.md`.
```

- [ ] **Step 2: Add the prerequisites row in `README.md`**

In the table under `## Prerequisites`, after the `direnv` row:

```markdown
| graphify | 0.9.64 | code map; install with the `[terraform]` extra (see below) |
```

Then update the sentence below the table — it currently reads
"`./scripts/01-install-tools.sh` checks all seven and installs what is missing." graphify is not
installed by that script, so change it to make that explicit:

```markdown
`./scripts/01-install-tools.sh` checks the first seven and installs what is missing. graphify is
separate — see the next section.
```

- [ ] **Step 3: Add the README section**

Insert after the `---` that closes `## Prerequisites` and before `## Configuration: what goes
where`:

````markdown
## The code map (graphify)

The repo is indexed as a queryable graph, so questions about structure are answered from the
graph rather than by grepping.

### Install

```bash
uv tool install "graphifyy[terraform]"
```

**The `[terraform]` extra is not optional here.** Without it graphify has no HCL extractor, and
30 `.tf`, 2 `.hcl` and 1 `.tfvars` file contribute nothing to the graph — 33 of 81 code files, in
a repo whose entire subject is Terraform. It fails as a warning, not an error, so an incomplete
map looks exactly like a complete one.

### Ask it things

```bash
graphify query "dynamodb provisioned capacity"   # scoped subgraph for a question
graphify explain "slo.yaml"                      # one node and its neighbours
graphify affected "slo.yaml"                     # what a change here would touch
graphify god-nodes                               # the most connected nodes
```

Matching is case-folded substring with no stemming and no synonyms, so build queries from the
names the code actually uses — `graphify god-nodes` is a good way to see them.

### Keep it current

```bash
graphify update .                          # code only: free, offline, a few seconds
graphify extract . --backend claude-cli    # also docs, specs and slo.yaml: costs LLM calls
```

`post-commit` and `post-checkout` git hooks run the first one for you. **They do not fire in
linked worktrees** — they exit when `git rev-parse --git-dir` differs from `--git-common-dir` — so
run it by hand when working in one.

### The committed cache

`graphify-out/` is gitignored except `graphify-out/cache/semantic/`, which **is** committed. Those
entries are the output of LLM extraction over markdown and YAML, keyed by source content hash, so
committing them means the work is paid for once and reused by every clone, worktree and CI run. A
warm cache replays for free.

CI regenerates it on every push to master, so `git pull` is normally all you need. To do it
yourself:

```bash
graphify extract . --backend claude-cli
git add graphify-out/cache/semantic/
git commit -m "chore(repo): refresh graphify semantic cache"
```

Both routes converge — refresh by hand and the CI job finds every hash already present, calls no
LLM and commits nothing.
````

- [ ] **Step 4: Verify no stale graffiti references remain anywhere**

```bash
grep -rn "graffiti" --include="*.md" --include="*.json" --include="*.yml" --include="*.sh" . \
  | grep -v "docs/superpowers/" | grep -v node_modules
```

Expected: no output. Matches under `docs/superpowers/` are historical record and stay.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "$(cat <<'EOF'
docs(repo): document graphify as the code map

CLAUDE.md says it must be updated as reality diverges from it, so the
graffiti section is a defect once the hooks point elsewhere. The README
gains its own section because the install has a trap: the [terraform]
extra is mandatory here, and omitting it produces a silently incomplete
graph rather than an error.

Both documents state the same two facts that are easy to get wrong: the
code half and the doc half refresh by different commands at different
cost, and graphify-out/ is ignored except the semantic cache.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JL3hZoaTnfKxtq9Z63v1Pf
EOF
)"
```

---

### Task 11: Remove graffiti

**Files:**
- Delete: `.claude/skills/graffiti/SKILL.md` and its directory
- Delete: `.graffiti/` (untracked build output)

**Interfaces:**
- Consumes: passing gates from Task 1 and Task 3.
- Produces: nothing. This is the last task on purpose — graffiti is the control until graphify has
  proven itself.

**Do not start this task if Task 1 or Task 3 failed.**

- [ ] **Step 1: Re-confirm both gates passed**

Check the session record for Task 1 Step 7 (graphify's Terraform answer was not worse than
graffiti's) and Task 3 Step 5 (`0 re-extracted`). If either is missing or failed, stop.

- [ ] **Step 2: Remove the skill and the build output**

```bash
cd /Users/koval/dev/test/high-load-test
git rm -r .claude/skills/graffiti
rm -rf .graffiti
```

- [ ] **Step 3: Verify nothing references it**

```bash
grep -rn "graffiti" --include="*.md" --include="*.json" --include="*.yml" --include="*.sh" . \
  | grep -v "docs/superpowers/" | grep -v node_modules
ls -d .graffiti 2>&1 | grep -q "No such" && echo "PASS: build output gone"
```

Expected: no grep output, then `PASS`.

- [ ] **Step 4: Confirm the graph still answers after the control is gone**

```bash
graphify query "dynamodb table read capacity provisioned" | head -20
```

Expected: the same `.tf` / `.tfvars` nodes Task 1 Step 5 produced.

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
chore(repo)!: remove graffiti

Deleted last, deliberately: graffiti was the control that graphify had to
beat on a real Terraform question before the switch was worth making.
Both gates passed -- graphify sees the HCL files with the [terraform]
extra installed, and the committed semantic cache replays with zero LLM
calls.

The graffiti binary itself is a user-level tool and is left alone; this
removes only the project skill and the generated map.

BREAKING CHANGE: .graffiti/ is gone and `graffiti query` is no longer part
of this repo's workflow. Install graphify per the README before working
here: `uv tool install "graphifyy[terraform]"`.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JL3hZoaTnfKxtq9Z63v1Pf
EOF
)"
```

- [ ] **Step 6: Final state check**

```bash
git status --short
git log --oneline -11
```

Expected: a clean tree apart from the two pre-existing untracked research docs
(`docs/research/ecs-rds-postgres-pool.md`, `docs/research/lambda-concurrency-sqs.md`), and the
task commits in order.

---

## Verification summary

| spec section | covered by |
|---|---|
| §3 Terraform coverage is a prerequisite | Task 1 (gate) |
| §5 hook surface, `.tf`/`.yaml` widening, no `--strict` | Tasks 4, 6 |
| §6 what is committed, nested re-inclusion | Task 2 |
| §7 manual + CI regeneration, no empty commits | Tasks 3, 9 |
| §8 git hooks, merge driver stripped, staleness signal | Tasks 5, 8 |
| §10 skill and README split | Tasks 7, 10 |
| §11 Gate 1 (coverage + head-to-head), Gate 2 (cache replay) | Tasks 1, 3 |
| §12 the open CI-auth question | Task 9 Step 5 |
| §13 guard-terraform.sh untouched | Task 6 Step 2 |

---

## Out of scope, but found while writing this plan

**The terraform spend guard is not currently active.** This is unrelated to graphify and no task
here changes it, but it was discovered while verifying that Task 6 leaves the guard alone, and it
contradicts what `CLAUDE.md` and `README.md` both state.

1. **`.claude/hooks/guard-terraform.sh` is registered nowhere.** The script exists and is
   executable, but `grep -rn guard-terraform .claude/` returns nothing, and it is absent from
   `.claude/settings.json`, `.claude/settings.local.json` and `~/.claude/settings.json`. `CLAUDE.md`
   describes it as "the guard that actually holds… the one mechanical guard against unattended AWS
   spend", and the README says it "intercepts `terraform apply`/`destroy` in Claude Code sessions".
   No hook invokes it.
2. **`.claude/settings.local.json` sets `"permissions": {"defaultMode": "bypassPermissions"}`**,
   which bypasses the `permissions.ask` entries for `terraform apply` / `terraform destroy` in
   `.claude/settings.json` — the second layer the same documentation relies on.

Both layers of the documented gate are therefore inert. `settings.local.json` is gitignored and
per-machine, so this may be deliberate local convenience rather than a repo defect; either way the
documentation asserts a protection that is not in force. Deciding what to do is the user's call:
re-register the hook, drop the `bypassPermissions` default, or correct the two documents. It should
not be folded into this plan, which is about the code map.
