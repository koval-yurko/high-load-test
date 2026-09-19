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
"authentication" will not find `authHandler`. If a query returns nothing, suspect that
first: run `graphify god-nodes` to see how things are actually named, then re-query.

**Ask for code in the shape code is written in.** Doc nodes carry sentence-shaped labels
("Capacity pinned 25/25 in dev.tfvars"), code nodes carry identifiers
(`aws_dynamodb_table.items`), and a resource's attributes live in `attrs`, not its label.
So an English question preferentially surfaces prose and can crowd code out entirely —
measured here, `"dynamodb table read capacity provisioned"` returned **0** Terraform nodes
while `"aws_dynamodb_table read_capacity"` returned **26**, against the same graph. If you
want the definition rather than the discussion, query the identifier, or go straight to
`graphify explain "<node>"`.

## Keeping it current

- **After editing code:** `graphify update .` — AST only, no LLM, a few seconds. The
  `post-commit` and `post-checkout` git hooks do this automatically, but they exit early
  inside linked worktrees, so run it by hand there.
- **After editing docs, specs or `slo.yaml`:**
  `graphify extract . --backend claude-cli --max-workers 2`. This costs LLM calls for
  changed files and replays cached ones for free. CI regenerates it on master, so
  `git pull` is usually enough. Pass `--max-workers 2`: an unconstrained full pass has
  exhausted memory on this repo.

`update` merges with existing semantic results rather than replacing them — verified —
so a code rebuild never drops the doc half.

## What is and is not in the graph

`.tf`, `.tfvars`, `.js`, `.sh` and `package.json` come from the AST extractor, which
needs the `graphifyy[terraform]` extra for HCL — without it 33 files here index as
nothing, and it warns rather than failing.

Markdown is covered two different ways, which explains a confusing node count: `update`
extracts it *structurally* (a node per heading), while `extract` routes it to *semantic*
extraction (fewer, richer nodes). Both are legitimate; the totals differ.

**`.yaml` has no structural extractor at all.** `slo.yaml` — the SLO source of truth —
is in the graph only because a semantic pass ran. `.envrc` is skipped as sensitive, and
`Dockerfile` and `.tftpl` are not classified. When the graph has nothing, grep is the
right tool; the session-start hook will tell you if the doc half is stale.
