---
name: loadtest
description: Run a k6 load profile against a deployed project environment, parse the summary JSON, and append a dated result record with SLO attainment to the project's results file. Use for any load test run, RPS measurement, or before/after comparison in this repo.
---

# Load test and record

Usage: `/loadtest <project> <profile> [--compare]`

Profiles live in `<project>/k6/<profile>.js`. Results are appended to `<project>/results.md`.

## The rule that makes results meaningful

**Never edit the k6 script to make a run pass.** A profile is only comparable to itself: between two
runs, the infrastructure changes and the script does not. If a threshold is wrong, that is a separate
committed change (`test(<scope>): ...`) which invalidates prior comparisons — say so explicitly when
it happens.

## Steps

1. **Confirm the target is up** and get its URL — from `terraform output`, not from memory of an
   earlier session. If nothing is deployed, stop; run `/env up <project>` first.
2. **Record the infrastructure delta** *before* running: what changed since the last recorded run
   (task count, instance class, reserved concurrency, pool size)? If nothing changed, this is a repeat
   run — say so; two identical rows are how you measure variance, but label them.
3. Run it, exporting the summary:

```bash
k6 run --no-color --summary-export=/tmp/k6-<project>-<profile>.json \
  -e BASE_URL=<url> <project>/k6/<profile>.js
```

4. **Capture the exit code immediately** — `echo $?` on the k6 line itself, not after a pipe (a pipe
   reports the last command's status, not k6's).

## Reading the results — verified against k6 v1.4.0

Two things about this JSON are counterintuitive and will invert your conclusions if you get them wrong:

- **`thresholds` booleans are "was it breached", not "did it pass".**
  `true` = **crossed = FAILED**. `false` = satisfied = passed.
- **`http_req_failed.passes`/`.fails` do not mean pass/fail of the test.** For a rate metric, `passes`
  counts requests that *were* failures. Use `.value` (0..1) for the error rate.

Exit code: **0** = all thresholds satisfied, **99** = at least one breached.

```bash
S=/tmp/k6-<project>-<profile>.json
jq -r '
  "RPS (avg):    \(.metrics.http_reqs.rate | floor)",
  "Requests:     \(.metrics.http_reqs.count)",
  "p95 latency:  \(.metrics.http_req_duration["p(95)"]) ms",
  "p90 latency:  \(.metrics.http_req_duration["p(90)"]) ms",
  "max latency:  \(.metrics.http_req_duration.max) ms",
  "Error rate:   \(.metrics.http_req_failed.value * 100) %",
  "Checks:       \(.metrics.checks.passes) passed / \(.metrics.checks.fails) failed"
' $S

# Threshold verdicts, with the polarity corrected to read the obvious way:
jq -r '.metrics | to_entries[] | select(.value.thresholds) | .key as $m
       | .value.thresholds | to_entries[]
       | "\(if .value then "BREACHED" else "ok      " end)  \($m): \(.key)"' $S
```

`http_reqs.rate` is the average over the whole run — including ramp-up. For a stages-based profile
that average understates the plateau; when the number that matters is sustained RPS at peak, say which
one you are quoting.

## Recording

Append to `<project>/results.md` — create it with a header row if absent:

```markdown
| date | profile | infra change | RPS | bound resource | evidence | k6 attainment | service attainment | budget burn x | p95 fast/std/heavy | db ms | cpu ms | EL lag p99 | throttles | RCU/WCU | $/hr |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
```

**Two attainment columns, because two different numbers both legitimately answer "did it meet the
SLO", and they are not interchangeable:**

| column | source | what it includes |
|---|---|---|
| `k6 attainment` | the k6 run's `slo_met` rate — the run **gate** | client-side: load-zone RTT, ALB queueing, the client's own scheduling |
| `service attainment` | the Grafana SLO query over the run window — the **SLO** | server-side only: callback start to response finish |

The service figure is the one that means "SLO". The k6 figure is a pass/fail gate for the run.
Expect the k6 number to be lower; if it is *higher*, something is wrong with one of them. **Never
record one number in both columns, and never leave a bare "attainment"** — an unlabelled pair is how
a deliverable stops being trusted.

Read `service attainment` from the same PromQL the alert rules use, over the run's own window. Note
the SLO population is restricted to classified traffic (`class=~"fast|standard|heavy"`); an
internet-facing ALB collects scanner 404s that would otherwise count as violations.

`infra change` is the most important column — it is what makes the row mean something. A row whose
infra change is blank is not a result, it is a number.

`bound resource` and `evidence` are not optional. A ceiling with no attributed cause is a number,
not a result — DynamoDB `ThrottledRequests` climbing means DB-bound; event-loop lag climbing with
flat `db_ms` means service-bound.

`budget burn x` is the burn-rate multiple: observed miss rate / sustainable miss rate. A k6 run is
minutes and the SLO window is days, so a raw "0.03% of budget" figure does not travel between runs.
The multiple does. Compute it from `service attainment`, not the k6 figure — the budget belongs to
the SLO.

### Cloud runs

This repo's projects run from Grafana Cloud so the generator is not the bottleneck and RTT is not
charged against the latency budget. The command is `k6 cloud run`, not `k6 run`.

Verified against the installed k6 v1.4.0:

- **`--summary-export` IS supported on `k6 cloud run`.** `k6 cloud run --help` lists
  `--summary-export string   output the end-of-test summary report to JSON file`, and — unlike
  `--linger`, `--no-usage-report` and `--no-archive-upload` — it carries no "only in local-execution
  mode" caveat. So this is the favourable case: everything in "Reading the results" above (the
  `jq` parsing, the inverted-threshold-boolean gotcha, the `passes`/`.value` gotcha) applies to
  `k6 cloud run --summary-export=...` unchanged.
- **`k6 cloud load-zone list` does not exist in this k6 version.** `k6 cloud --help` lists exactly
  three subcommands: `login`, `run`, `upload`. There is no CLI command to enumerate or confirm load
  zones. Do not chase this command — it cannot work on the installed k6. If you need to *see* the
  zone catalog, that lives in the Grafana Cloud UI/API, not the k6 binary.
- **Zone validity is confirmed at test submission, not by a separate lookup.** Grafana Cloud
  validates `options.cloud.distribution.<name>.loadZone` (e.g. `amazon:de:frankfurt`) when the test
  is submitted, before any load is generated and before VU-hours are spent. An invalid zone fails
  fast and free on the first `k6 cloud run` — so the practical verification step is: submit the run
  and watch for an immediate rejection, not a pre-flight `load-zone list` call.

Capture the exit code on the k6 line itself — behind a pipe you get the pipe's status. `99` means a
threshold was breached; `0` means all passed.

```bash
k6 cloud run --summary-export=/tmp/k6-<project>-<profile>.json \
  -e BASE_URL=<url> <project>/k6/<profile>.js
echo "exit: $?"
```

## `--compare`

Read the previous row for the same profile and present a before/after table: RPS, p95, error rate,
SLO attainment, and the one infrastructure change between them. If the previous row used a different
profile or an edited script, refuse to compare and explain why.

## Reporting

Per CLAUDE.md, an SLO or RPS figure may only be stated with the output that produced it, from this
session. Quote the numbers with the run they came from; never carry a figure over from an earlier
conversation.
