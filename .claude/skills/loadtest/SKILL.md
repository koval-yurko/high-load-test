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
| date | profile | infra change | RPS | p95 ms | err % | thresholds | notes |
|---|---|---|---|---|---|---|---|
| 2026-08-29 | constant-400 | 2→4 tasks, autoscaling on | 412 | 180 | 0.02 | all ok | plateau 430 |
```

`infra change` is the most important column — it is what makes the row mean something. A row whose
infra change is blank is not a result, it is a number.

## `--compare`

Read the previous row for the same profile and present a before/after table: RPS, p95, error rate,
SLO attainment, and the one infrastructure change between them. If the previous row used a different
profile or an edited script, refuse to compare and explain why.

## Reporting

Per CLAUDE.md, an SLO or RPS figure may only be stated with the output that produced it, from this
session. Quote the numbers with the run they came from; never carry a figure over from an earlier
conversation.
