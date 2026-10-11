---
name: readme
description: Write or restructure a project's README.md in this repo so every scenario has the same sections, the same phase order and the same evidence rules. Use when creating a new <platform>-<scenario> project, when a project's runbook has drifted from its siblings, or when asked to "make the README like ecs-dynamodb-rps".
---

# Project README

Usage: `/readme <project>` (new or existing). The reference implementations are
`ecs-dynamodb-rps/README.md` (the shape) and `ecs-rds-postgres-pool/README.md` (the same shape with
a knob sequence). Read the one closest to the new scenario before writing; copy its section order, do
not invent a new one. A reader who has used one project's README must find everything in the same
place in the next.

## Ground rules

1. **Every figure has a source.** An SLO, RPS, latency or cost number is either (a) read from a k6
   summary or Grafana query run in that session, (b) arithmetic shown inline (objective, burn
   multiplier, connection count), or (c) labelled **estimate** or **chosen, not measured**. Never a
   remembered number. Before a project has run, the "Measured results" section says so and stays
   empty; it is not filled with expectations.
2. **Say what is not true yet.** A README written before the first apply states "Nothing is deployed
   yet" near the top. Remove that line in the commit that records the first run.
3. **Self-contained.** State the substance, then the address. Never cite `§5`, `D7` or "the
   2026-08-31 spec" alone: say what it decided, then link it. A pure pointer (header link to a spec,
   "full reasoning lives here") is the only exception.
4. **Commands, then why.** Every phase is the command to run, followed by one or two sentences on why
   and what to check. Prose that explains a decision belongs in a spec, linked once.
5. **Never write a phase for something there is nothing to run.** No "(nothing to run)" sections;
   fold the fact into the nearest config note instead.
6. **The README documents `dev.tfvars` and `slo.yaml`, it does not duplicate them.** Quote a value
   only where a reader needs it to act; when it changes, grep the README for the old number.
7. **Terraform apply/destroy are approval gates.** Mark each one `approval gate` in the command's
   comment. No project script runs `terraform apply` or `destroy`.
8. **Reference-style links** for the Grafana/k6 URLs, defined once at the bottom: `[dash]`,
   `[alerts]`, `[slo]`, `[k6]` and, when the project emits traces, `[traces]` (the Explore deep link).
9. **Use `they/them`** for anyone whose pronouns are not stated, and no first person.

## Structure (in this order)

```
# <project>
  Intro: what it is, the question it answers, the method (one change at a time), idle cost.
  "Nothing is deployed yet" if true.
## Where to look            table: open | then   (dashboard, alert rules, SLO app, traces if any, k6 projects)
---
## 1. Is the service up?          check | where, Good / Bad
## 2. Are we meeting the SLO?     the SLI panel, server- vs client-side, error budget, window
## 3. What is the bottleneck?     the two metrics read side by side, and the trap in each direction
## Reading a trace              only if the service emits traces: where, how to open one, the span
                                table, TraceQL examples, the sampling knob and what it costs
## 4. Is it about to break?       the alert rules table, burn rates, why SLI-absent exists
---
# Runbook
## Where everything lives         service URL (from terraform output, never in the repo), TFC, ECS, DB, logs,
                                 traces (Explore deep link + the Tempo data source name and uid)
## <Service endpoints | What it provisions | environment-variable contract>   as the scenario needs
## <The knob sequence>            only if the project turns more than one knob; table of phase -> tfvars change
## Configuration notes that bite   one bullet per trap; each says the symptom
## Run it locally                  only if a local loop exists; else say there is none and why
## Phase 0 — Setup (already done once)       env, direnv, platform apply, init; provision, deploy, seed;
                                             troubleshooting table: symptom | cause
## Phase 1 — Is it alive?                    curl /healthz and one real read
## Phase 2 — Run a load test                 shapes A discovery, B constant, C stress; upload-k6.sh;
                                             run gate; start run; terminal alternative; exit codes
## Phase 3 — Read the result                 question | where table; both attainment columns
## Phase 4 — Improve: <change 1>             one change, from the same commit; approval gate
## Phase 5 — Re-measure identically          same scripts, same RATE, same thresholds
## Phase 6 — Improve: <change 2>             only if phase 5 left the previous constraint
## Phase 7 — Re-measure again
## Phase 8 — Record the results              what to put in a results.md row
## Phase 9 — Tear down                       destroy (approval gate) + tag sweep + survivors
---
## How to move the infrastructure for the SLO   (when two distinct moves exist; else omit)
## Cost                                          table of rates, idle total per hour and month
## Known gaps                                    bullets; each says what silently fails
## Measured results                              empty until a run exists
[dash]: ...  [alerts]: ...  [slo]: ...  [k6]: ...
```

Phases 4-7 vary per scenario (the knob sequence differs); the **numbering of 0-3 and 8-9 does not**.
If a scenario has three improvements, repeat the Improve / Re-measure pair, keep 8 and 9 last, and
renumber everything after, fixing every link to a renumbered anchor (`grep -n "phase-"`).

## Section details that are easy to get wrong

- **Traces (only when the service emits them).** Four things, each learned the hard way:
  - *Where:* give the Tempo data source **name and uid** read from the Grafana API
    (`GET /api/datasources`, `type == "tempo"`), not guessed, and an Explore deep link with the TraceQL
    query pre-filled (a `panes` JSON in the URL: `datasource`, `queries[].queryType = "traceql"`).
  - *How to open:* numbered steps a first-time reader can follow — open the link, set the time range
    to the run's window, run a query, click a row, click the SQL span and read its attributes, sort by
    duration to find the worst one.
  - *Attribute names come from a real trace, never from library docs.* The pg instrumentation emits the
    statement as `db.query.text` on current versions and `db.statement` on older ones; the first
    README claimed the latter and its TraceQL example matched nothing. Query the deployed Tempo and
    copy the key it returns.
  - *What is not covered.* Auto-instrumentation gives the request, the pool wait and the SQL; it does
    not give Prisma's in-process work, body parsing or response serialization. Say which gaps exist
    so a gap in the waterfall is not read as an idle service.
  - *Sampling is part of the configuration.* Name the ratio knob, its default, and that it must be
    identical across runs being compared, because tracing runs inside the task under test.

- **Phase 2 run gate.** State the condition under which a run is not recordable (DynamoDB: 6 minutes
  to drain the burst bucket; RDS T-class: `CPUCreditBalance` full and `CPUSurplusCreditBalance` zero)
  and that `SELECT count(*)` / table size is recorded before the run.
- **k6 facts.** A threshold's boolean in `--summary-export` is *was it breached*: `true` = failed.
  `http_req_failed` uses `.value`. k6 exits 99 on a breach and the code must be captured on the k6
  line, not behind a pipe.
- **Uploading profiles.** A UI run executes the archive stored in the cloud, not the file on disk;
  `upload-k6.sh --check` first, `upload-k6.sh` (discovery only) before the knee is known,
  `upload-k6.sh --rate <knee>` after.
- **Two attainment columns, never one:** k6 (client-side) and service (Grafana, server-side).
- **Thresholds.** Name where they are set (`slo.yaml`), the values, that they are set by decision or by
  measurement, and that changing one invalidates every earlier result. Point at the dashboard panel
  that draws them.
- **Cost.** List rates, then the idle total per hour and per month (x 730 h), then the forgotten
  environment as the real risk. Mark every unqueried price an estimate until `pricing.json` exists.
- **Tear down.** `terraform destroy` then the tag query, then the survivors by name (final snapshots,
  log groups, EIPs, NAT, the Grafana k6 project).
- **Service URL** comes from `terraform output`, never from the repo or `.env`.
- **Phase 3 table.** When traces exist, add the row *which request was slow and which SQL was it
  waiting on?* pointing at `[traces]`; it is the only place a per-request answer lives.

## Procedure

1. Read the nearest sibling README and the project's `variables.tf`, `dev.tfvars`, `slo.yaml`,
   `scripts/`, `infra/k6/tests/` and `infra/main/outputs.tf`. Document what exists; do not describe
   files that are not there.
2. Draft in the order above. Take each number from a file you read, or label it.
3. Check every script, flag and output name mentioned actually exists (`ls scripts`,
   `grep -n 'output "' infra/main/outputs.tf`).
4. Check every internal link: `grep -n "](#" README.md`, then confirm each anchor has its heading.
5. If the service emits traces, open one real trace and confirm every span name and attribute key the
   README mentions appears in it, and that the Explore link actually opens on the right data source.
6. Check the project name is spelled the same everywhere — it is the `Project` tag value and the
   commit scope.
7. Commit as `docs(<project>): ...` per the Conventional Commits table in CLAUDE.md.
