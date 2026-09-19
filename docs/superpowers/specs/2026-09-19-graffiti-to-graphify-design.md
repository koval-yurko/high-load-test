# repo — replace the graffiti code map with graphify

- **Date:** 2026-09-19
- **Status:** **approved** (2026-09-19) — the user directed proceeding to the implementation plan.
  The §12 probe has been run and resolved. Nothing has been installed, changed or deleted in the
  repo itself.
- **Scope:** repo-wide tooling. This is not a project directory; like `platform/`, it is one of the
  few things that lives above the per-project boundary.
- **Amends:** nothing. The graffiti integration arrived in commit `8bff451`
  (`chore(repo): wire graffiti code map into claude code`) without a spec, so there is no earlier
  decision document to carry a forward-pointer. This spec is the first written record of how the
  code map is wired, and it supersedes the `## graffiti code map` section of `CLAUDE.md` in place.

## 1. What changes, in one line

`graphify` replaces `graffiti` as the repo's code map; the graph itself stays untracked, but the
**LLM-extracted semantic cache is committed**, because it is the one output that costs money to
recreate.

## 2. Why

The motivation is capability, not breakage. graffiti works. graphify adds community detection,
`god-nodes`, `path`, `explain` and `affected` — a blast-radius query — over the same kind of
graph, and those come free: clustering is deterministic Leiden/Louvain with no API key, and code
extraction is tree-sitter AST. A measured code-only build of this repo produced **264 nodes, 475
edges and 18 communities in 3.6 seconds**.

## 3. The constraint that nearly sinks it

graphify's HCL extractor lives behind an optional extra. Without it, a real build of this repo
emitted:

```
warning: 30 .tf file(s) contributed nothing to the graph because a dependency is
missing: tree_sitter_hcl not installed. Install it with: pip install "graphifyy[terraform]"
warning:  2 .hcl file(s) …   warning: 1 .tfvars file(s) …
```

**33 of 81 code files, silently absent**, in a repo whose entire subject is Terraform. `graffiti`
has no such gap. So `uv tool install "graphifyy[terraform]"` is a prerequisite of this change, not
a nice-to-have, and §11 makes proving it the first gate.

## 4. Decisions

| id | decision | choice |
|---|---|---|
| D1 | Code map tool | graphify replaces graffiti |
| D2 | Terraform coverage | the `graphifyy[terraform]` extra is a **prerequisite** |
| D3 | Search guard | `Bash\|Grep` → `graphify hook-guard search`, unmodified |
| D4 | Read guard | wrapped locally to add `.tf`, `.tfvars`, `.yaml`, `.yml`; **no `--strict`** |
| D5 | Git hooks | `post-commit` + `post-checkout`; the merge-driver line is stripped |
| D6 | What is committed | `graphify-out/` ignored **except** `cache/semantic*/` |
| D7 | Doc coverage | routine, not on-demand |
| D8 | Who regenerates the semantic cache | **both** — by hand, and by CI on master |
| D9 | CI branch scope | `master` only |
| D10 | The project skill | short and repo-local, not graphify's shipped 40 KB skill |
| D11 | Staleness signal | a `SessionStart` mtime check, not `graphify watch` |
| D12 | When graffiti is deleted | **last**, gated on a head-to-head query (§11) |

## 5. The hook surface (D3, D4)

graphify's own project install writes two `PreToolUse` entries. The first is taken as-is; the
second is wrapped.

**The search guard needs no help.** A Grep nudges whenever a graph exists, with no extension test
at all (`cli.py:867-871` — `is_grep_tool` is true whenever the call carries a `pattern` and no
command). Terraform searches are already covered today.

**The read guard is extension-filtered, and the list is hardcoded.** `_HOOK_SOURCE_EXTS`
(`cli.py:71-75`, consulted at `cli.py:881`) lists 29 extensions — `.py`, `.js`, `.sh`, `.md` and
so on. It omits `.tf`, `.tfvars`, `.yaml` and `.yml`, and there is no environment variable or
config file that extends it; the roughly 55 `GRAPHIFY_*` variables the package reads include
nothing for it. Left alone, the guard would nudge on JavaScript and shell reads while staying
silent on the files this repo is mostly made of.

So `.claude/hooks/graphify-read-guard.sh` reads the hook JSON, emits the nudge itself when the
path ends in one of the four, and otherwise pipes stdin straight to `graphify hook-guard read`.
Repo-local, so `uv tool upgrade` cannot undo it, and no patching of an installed package.

Including `.yaml`/`.yml` is only honest because of D7. YAML has **no structural extractor** —
`slo.yaml` reaches the graph solely through semantic extraction — so under an on-demand doc policy
the guard would be pointing at content that is usually absent. Routine doc passes are what make
the nudge truthful.

`--strict` is rejected. It hard-denies the first raw `Read` of each session until a query has run,
and the graph will never cover everything (`.envrc` is skipped as sensitive, Dockerfiles and
`.tftpl` are unclassified).

## 6. What is committed, and why it is only one directory (D6)

This is the substantive decision, and it came from a question worth recording: semantic extraction
spends LLM calls, so ignoring its output means every clone, worktree and CI run pays again for work
that was already done.

graphify's own cache layout already draws exactly that line (`cache.py:938-946`):

> AST entries live in `graphify-out/cache/ast/v{version}-s{schema}/`, namespaced by graphify
> version and cache-key schema because they depend on extractor code… Semantic entries are still
> **NOT version-namespaced (re-extraction costs LLM calls, #1252)**.

AST entries are discarded on every version bump because recomputing them is free. Semantic entries
deliberately survive upgrades because they are not. And they are shareable — `load_cached`
(`cache.py:973-978`): *"Cache key: SHA256 of file contents… `root` anchors the content-hash key and
source_file relativization (it must stay the inferred common parent so **keys remain portable**)."*
Keyed by content, not by path, mtime or inode.

| path | tracked | why |
|---|---|---|
| `graphify-out/cache/semantic/` | **yes** | the paid artifact; content-keyed, upgrade-proof by design |
| `graphify-out/cache/semantic-deep/` | **yes** | same, should `--mode deep` ever be used |
| `graphify-out/graph.json` | no | derived, 920 KB, rebuilt free from the caches |
| `graphify-out/graph.html` | no | 807 KB derived visualization |
| `graphify-out/cache/ast/` | no | free to recompute, and discarded on upgrade anyway |
| `manifest.json`, `.graphify_*` | no | a clone without a manifest re-queues the doc files, but every one is a content-hash **cache hit — zero LLM calls** |

**The `.gitignore` must use nested re-inclusion, not a simple negation.** Git does not descend into
an excluded directory, so `graphify-out/` followed by `!graphify-out/cache/semantic*/` re-includes
**nothing** — and it fails silently, which is the dangerous part: `git add graphify-out/cache/semantic/`
would stage zero files, `git diff --cached --quiet` would be true on every run, and the cache would
appear permanently up to date while never being shared at all. Verified 2026-09-19 in a throwaway
repo: that pattern left the cache entry invisible to `git status --untracked-files=all`. The working
form re-includes each level:

```gitignore
graphify-out/*
!graphify-out/cache/
graphify-out/cache/*
!graphify-out/cache/semantic/
!graphify-out/cache/semantic-deep/
```

Verified to expose `graphify-out/cache/semantic/p*/….json` while keeping `graph.json`,
`cache/ast/`, `cache/stat-index.json` and the dated backup directory ignored. A convenient side
effect survives: `git add -A` still physically cannot stage `graph.json` or the viz.

**Dated backup directories are an output too.** Every re-run writes a snapshot to
`graphify-out/<YYYY-MM-DD>/` (observed: `graph.json`, `manifest.json`, `.graphify_analysis.json`,
`.graphify_semantic_marker`). `graphify-out/*` covers them. They accumulate one directory per day a
build runs; `GRAPHIFY_NO_BACKUP=1` suppresses them if that ever becomes a nuisance.

**Entries cannot conflict.** Each is named `{sha256}.json` for its source file's content. Two
branches editing different docs add different files; two branches editing the same doc differently
produce two different hashes and add both. There is no file for git to conflict on. If a collision
ever does occur — a local run and a CI run producing different bodies for the same name — **take
either side**: both are extractions of byte-identical source content, so neither is more correct.
`prune_semantic_cache()` collects the orphans that accumulate as docs change.

## 7. Regenerating the semantic cache (D7, D8, D9)

Two routes that converge, because a warm cache makes the second a no-op.

**By hand**, any time:

```bash
graphify extract . --backend claude-cli
git add graphify-out/cache/semantic/
git commit -m "chore(repo): refresh graphify semantic cache"
```

`graphify extract` is absent from `--help` but is the intended headless path (`cli.py:3175`):
*"Headless full-pipeline extraction for CI / scripts (#698)… Unlike the skill.md path (which runs
through Claude Code subagents), this calls `extract_corpus_parallel` directly using whichever
backend has an API key set."* `claude-cli` is a first-class member of `BACKENDS` (`llm.py:209`),
dispatched like any other (`llm.py:2000`), and is one of only two backends exempted from needing a
key (`llm.py:1978`) because it shells out to the `claude` binary — which is how the subscription
pays for this instead of an API key.

**By CI, on master only**, as a safety net:

```yaml
name: graphify semantic cache
on:
  push:
    branches: [master]
    paths: ['docs/**', '**/*.md', '**/*.yaml', '**/*.yml']
jobs:
  extract:
    if: github.actor != 'claude[bot]'
    runs-on: ubuntu-latest
    permissions: { contents: write }
    steps:
      - uses: actions/checkout@v4
      - run: pipx install "graphifyy[terraform]"
      - run: graphify extract . --backend claude-cli
        env: { CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }} }
      - run: |
          git add graphify-out/cache/semantic/
          git diff --cached --quiet || git commit -m "chore(repo): refresh graphify semantic cache"
          git push
```

**The two routes compose without fighting.** Regenerate by hand and CI still fires, finds every
doc hash present, calls no LLM, stages nothing and exits. Skip the manual step and CI does the
work. Either order converges on the same cache.

**No empty commits**, guarded twice. The `paths:` filter stops the job starting unless docs or YAML
changed; `git diff --cached --quiet ||` stops the commit when extraction produced nothing new —
including a doc *deletion*, which adds no entry. That second guard is exact rather than
approximate because **cache entries carry no timestamps**: `cache.py` contains no `time()`,
`datetime`, `utcnow` or `isoformat`, so re-extracting unchanged content writes byte-identical
files and git sees a genuinely empty diff.

**Master-only is a correctness choice, not a simplification.** Content-hash naming makes entries
conflict-free *between* files; single-branch ownership makes them conflict-free *within* one. The
`claude[bot]` actor guard is the same pattern `.github/workflows/claude-code-review.yml` already
uses against this exact self-trigger loop.

**Locally, code-only is the default.** `graphify update .` never calls an LLM and never touches
`cache/semantic/` — it prints `Re-extracting code files (no LLM needed)` and then points at the
doc path (`cli.py:2440-2447`). To pull docs into a local graph: `git pull`, then
`graphify extract .`, where every entry is a cache hit and costs nothing.

## 8. Staying fresh (D5, D11)

**Git hooks handle code.** `graphify hook install` writes `post-commit` and `post-checkout`,
appended to existing hooks rather than replacing them. The rebuild is launched **detached** so
commits do not block (`hooks.py:439`: *"Full-repo rebuilds can take hours; blocking the post-commit
hook stalls the shell"*), and it exits early during rebase, merge and cherry-pick, and when only
`graphify-out/` changed. `post-checkout` does a full rebuild, which is the point: a graph built on
master describes code you are not editing, and the read guard would be telling us to trust it.

The merge driver the same command registers is stripped afterwards. It targets
`graphify-out/graph.json`, which is ignored — a `.gitattributes` line pointing at an untracked path
is a false signal that the graph is committed.

**Both hooks are inert in linked worktrees.** They compare `git rev-parse --git-dir` against
`--git-common-dir` and exit when they differ (`hooks.py:365-371`). Worktree sessions run
`graphify update .` by hand. This is a real limit, not an oversight, and belongs in the README.

**Docs need a different signal, because graphify has none that fits.** The `needs_update` flag is
written only by `graphify watch` (`watch.py:2187`), which needs the `watchdog` extra and a live
daemon per checkout; `graphify update` never sets it, so the git hooks cannot report doc staleness.
Instead, `.claude/hooks/graphify-doc-stale.sh` runs at `SessionStart` and compares mtimes: if
anything under `docs/`, `slo.yaml`, `README.md` or `results.md` is newer than `graph.json`, it says
so and names both routes — `git pull` if CI has already done it, `graphify extract .` to do it now.
A few lines of `find -newer`, no daemon, no extra package, and it works identically in worktrees
where the git hooks do not.

## 9. Files touched

| file | change |
|---|---|
| `.claude/settings.json` | drop `Grep\|Glob → graffiti hook`; add the two guards and the `SessionStart` entry |
| `.claude/hooks/graphify-read-guard.sh` | new (§5) |
| `.claude/hooks/graphify-doc-stale.sh` | new (§8) |
| `.claude/skills/graphify/SKILL.md` | new (§10) |
| `.claude/skills/graffiti/` | deleted |
| `.github/workflows/graphify-semantic-cache.yml` | new (§7) |
| `CLAUDE.md` | the `## graffiti code map` section rewritten |
| `README.md` | new section (§10) |
| `.gitignore` | `.graffiti/` → `graphify-out/` + negation |
| `.graffiti/` | deleted |
| `.git/hooks/post-commit`, `post-checkout` | installed; `.gitattributes` line stripped |

## 10. What the skill and the README each say (D10)

They are for different readers and must not be copies of each other.

**The skill** (`.claude/skills/graphify/SKILL.md`) is for Claude, and stays short like the graffiti
one it replaces — graphify ships a 40 KB skill plus ~60 KB of references, and copying that into the
repo buys context cost, not clarity. Four things: `query`/`explain`/`path`/`affected`/`god-nodes`
as the entry points; `graphify update .` after editing code; docs and `slo.yaml` reach the graph
only through a semantic pass; and **build queries from the graph's own vocabulary**, because
matching is case-folded substring with IDF and has no stemming, no synonyms and no cross-language
matching — the single largest determinant of whether a query returns anything.

**The README** gets its own section, for a human at a fresh clone, covering install and manual use:

- `uv tool install "graphifyy[terraform]"` — and why the extra is not optional (§3), since the
  failure mode is a silently incomplete graph rather than an error.
- The five query commands, with one worked example against this repo.
- `graphify update .` for code; the manual `graphify extract .` block from §7 for docs, with the
  `git add graphify-out/cache/semantic/` line, since that is the part a newcomer will not guess.
- That CI on master regenerates the cache anyway, so the manual route is a convenience and never an
  obligation.
- That the git hooks do not fire in worktrees (§8).

It belongs after `## Prerequisites` and before `## Configuration: what goes where` — it is a tool
you install, and the `graphifyy[terraform]` row should join the prerequisites table alongside the
seven binaries `./scripts/01-install-tools.sh` checks.

## 11. Verification — two gates

Per this repo's reading of `test-driven-development`, the analogue of a failing test is watching
the measurement fail first.

**Gate 1 — Terraform coverage.** Build *before* installing the extra and query something only HCL
can answer: the DynamoDB table's provisioned capacity, which commit `659d33e` moved into
`infra/main/dev.tfvars`. Expect an empty result and the `contributed nothing to the graph` warning
from §3. Then install the extra, `graphify update .`, and run the identical query. Expect real
`.tf` nodes.

**Gate 1b — the head-to-head.** Same question through `graffiti query`, which works today. If
graphify answers worse, the honest outcome is to keep graffiti and report that — this spec's
premise would be wrong.

> **Result (2026-09-19): both gates' first half passed, and the size concern was unfounded.**
>
> | | graffiti | graphify |
> |---|---|---|
> | nodes from `.tf` / `.tfvars` | **0** | **17** |
> | output size | 8,210 bytes | **6,743 bytes** |
> | top hit | markdown plan files | `aws_dynamodb_table.items` @ `dynamodb.tf`, carrying `billing_mode="PROVISIONED"`, `read_capacity`, `write_capacity` |
>
> graffiti never surfaces the Terraform resource for this question at all — its nodes are
> file-level (`[doc]`, `[file]`). graphify is both more correct **and smaller** here.
>
> An earlier draft of this section warned that graphify had measured 20.5 KB against graffiti's
> 8.2 KB and might cost 2.5× the tokens. That figure came from a different question asked during
> research and does not hold for the capacity query; it is corrected rather than deleted, because
> the original number was cited in the commit that introduced this spec.
>
> Before the extra: `30 .tf`, `2 .hcl`, `1 .tfvars` contributed nothing; 899 nodes. After:
> 1,120 nodes, 1,697 edges, 79 communities. Installing the extra also moved graphify
> **0.9.62 → 0.9.64**, which is the version this repo now runs.

**Gate 2 — the cache premise.** Run one doc pass. Then delete `graph.json` and `manifest.json`,
keep `cache/semantic/`, and rebuild. Expect the docs back in the graph with **zero LLM calls**. If
that does not hold, committing the cache buys nothing and the `.gitignore` negation comes out along
with the CI workflow.

`.graffiti/` and the graffiti skill are deleted **last**, after both gates pass (D12). Until then
graffiti is the control.

## 12. The probe, and what is still open

**Run 2026-09-19** against a throwaway directory holding one markdown file of deliberately
invented names (Zarquon, Flibber, Grunthos, Vroomfondel), so that any extracted node provably came
from that file:

```
[graphify extract] found 0 code, 1 docs, 0 papers, 0 images
[graphify extract] semantic extraction on 1 files via claude-cli...
[graphify extract] wrote …/graph.json: 7 nodes, 9 edges, 3 communities
[graphify extract] tokens: 28,412 in / 1,797 out, est. cost (~claude-cli): $0.0000
```

Exit 0 in 16.4s. The nodes were `Flibber Ingest`, `Grunthos Queue`, `Vroomfondel Worker`,
`Zarquon Ledger Service`, `Flibber Pipeline`, `Zarquon Throughput Ledger (doc)` and
`Grunthos Drain SLO (400ms p95)` — real extraction with real relationships, not a stub. The
`$0.0000` line is the direct evidence that this backend bills the subscription rather than an API
key, which is the point of choosing it.

The entry landed at `graphify-out/cache/semantic/p5e80268fecd6/0e5abe90….json` — the
`p{prompt-fingerprint}/{content-sha256}.json` layout §6 depends on.

**A second run confirmed the two claims §7 rests on.** It reported
`incremental summary: 1 files cached/unchanged, 0 re-extracted, 0 deleted` — zero LLM calls — and
finished in 0.35s against 16.4s cold. The md5 of the cache tree was **identical before and after**
(`faefdd453a5a00148e0db6154875a4f7`), so re-extraction of unchanged content is byte-stable and the
`git diff --cached --quiet` guard against empty commits is exact rather than approximate.

**First CI run failed for a simpler reason than expected.** The runner image does not ship the
`claude` binary at all, and graphify detects the backend with a bare `shutil.which("claude")`
(`llm.py:3216`), so it failed before the token was ever consulted:
`error: backend 'claude-cli' requires the claude CLI on $PATH`. The workflow now installs
`@anthropic-ai/claude-code` from npm first. Everything else the job needs was already in place: the
`CLAUDE_CODE_OAUTH_TOKEN` secret exists, Actions allows all actions, the job declares
`contents: write`, and `master` carries no branch protection to block the push.

**Still open, and only testable in CI:** whether the `claude` binary authenticates from
`CLAUDE_CODE_OAUTH_TOKEN` inside a GitHub Actions runner. The probe ran on a workstation where
`claude` is authenticated by the user's own session, so it establishes that the backend works and
that `extract` accepts it — not that the token path works headlessly. The first push to master
after the workflow lands is the test. If it fails, the fallback is unchanged:
`anthropics/claude-code-action@v1` with a prompt that runs the pass through its own subagents,
already proven in this repo by `claude.yml` and `claude-code-review.yml`.

This affects **only** the middle step of the CI workflow. The manual route, the cache design and
everything in §5, §6 and §8 are now verified independent of it.

## 13. What this does not change

- **No project directory is touched.** `ecs-dynamodb-rps/` and `platform/` are untouched; this is
  repo-level tooling, and nothing here affects Terraform, SLOs or load profiles.
- **The terraform guard hook is untouched.** `.claude/hooks/guard-terraform.sh` and the
  `permissions.ask` entries for `terraform apply`/`destroy` stay exactly as they are. Nothing in
  this spec goes near the one mechanical guard against unattended AWS spend.
- **No Grafana, k6 or AWS resource is involved**, so no cost changes and nothing to provision or
  destroy.
- **`slo.yaml` remains the SLO source of truth.** Its appearance in the graph is a convenience for
  navigation and confers no authority; `/slo` still generates the k6 thresholds and Grafana rules.
