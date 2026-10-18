---
name: loadtest
description: Run a k6 load profile against a deployed project environment, parse the summary JSON, and append a dated result record with SLO attainment to the project's results file. Use for any load test run, RPS measurement, or before/after comparison in this repo, and when creating or updating a project's loadtest.md contract.
---

# Load test and record

Usage: `/loadtest <project> <profile> [--compare]`

Profiles live in `<project>/infra/k6/tests/<profile>.js`. Results are appended to `<project>/results.md`.

**This skill is the procedure; `<project>/loadtest.md` is the project.** Everything that differs
between projects — the results-table columns, the run gate, the load-generator sizing and the
server-side metric commands — lives in that file, never here. Read it before step 1. If it does not
exist, write it first (see "The project contract" at the end) — do not improvise the
project-specific parts from memory or from a sibling project.

## The rule that makes results meaningful

**Never edit the k6 script to make a run pass.** A profile is only comparable to itself: between two
runs, the infrastructure changes and the script does not. If a threshold is wrong, that is a separate
committed change (`test(<scope>): ...`) which invalidates prior comparisons — say so explicitly when
it happens.

## Steps

1. **Read `<project>/loadtest.md`.**
2. **Confirm the target is up** and get its URL — from `terraform output`, not from memory of an
   earlier session. If nothing is deployed, stop; run `/env up <project>` first.
3. **Record the infrastructure delta** *before* running: what changed since the last recorded run?
   If nothing changed, this is a repeat run — say so; two identical rows are how you measure
   variance, but label them.
4. **Pass the run gate** in `loadtest.md` "Before the run", and take the pre-run readings it lists.
   A run that skipped the gate is not recordable.
5. **Get the run's numbers.** Two paths, depending on how the run started:
   - **Started from a terminal** — `k6 cloud run --summary-export=…`, then read that JSON. See
     "Cloud runs" below. Prefer this path: the exit code is a free verdict.
   - **Started from the Grafana Cloud k6 UI** — there is no local file. Read the run from the k6
     Cloud API; see "Reading a UI-started run from the API". **A UI run executes the archive stored
     in the cloud, not the file on disk**, so confirm freshness first with
     `<project>/scripts/upload-k6.sh --check`. After every `/env up` the k6 project is new and holds
     no tests, so run `upload-k6.sh` before any UI run.

   Either way, load comes from Grafana Cloud's Frankfurt zone, not a laptop: plain `k6 run` never
   belongs in this step.
6. **Capture the exit code immediately** — `echo $?` on the k6 line itself, not after a pipe. A UI
   run has no exit code; use `result_status` from the API instead.
7. **Check `rate_source` before recording.** Profiles fall back to the default `RATE` in
   `infra/k6/tests/lib/env.js` when it is unset, and tag every sample `rate_source=default`. **A run
   tagged `default` is not a capacity measurement** — record it only as a smoke test.
8. **Read the server-side numbers** — Grafana (below) and the project's own metrics from
   `loadtest.md` "Server-side metrics".
9. **Record** the row (below), then run the completeness check.

## Reading the results — verified against k6 v1.4.0

Two things about this JSON are counterintuitive and will invert your conclusions:

- **`thresholds` booleans are "was it breached", not "did it pass".**
  `true` = **crossed = FAILED**. `false` = satisfied = passed.
- **`http_req_failed.passes`/`.fails` do not mean pass/fail of the test.** For a rate metric, `passes`
  counts requests that *were* failures. Use `.value` (0..1) for the error rate.

Exit code: **0** = all thresholds satisfied, **99** = at least one breached. Only four thresholds can
breach: `slo_met`, `slo_met_tail`, `http_req_failed` and `dropped_iterations`. The per-class
`http_req_duration{class:…}` entries are `p(99)>=0` — present so the sub-metric is printed, unable to
fail — so read their values for the row but never treat them as a verdict.

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
it understates the plateau; when the number that matters is sustained RPS at peak, say which one you
are quoting.

### Reading a discovery run

Discovery is one 60 s scenario per step, `rps_<START_RATE>` … `rps_<MAX_RATE>` in `STEP_RPS`
increments (defaults 100 … 2000 by 100), and every step has its own threshold
`slo_met{scenario:rps_N}`. **The knee is the lowest `rps_N` whose threshold reads `true`
(breached); `RATE` for `constant` and `stress` is the step before it.** Do not compute the knee from
elapsed time or from the cumulative `slo_met` — that one is only an abort, and it lags the real knee
by design.

```bash
# Each metric is {passes, fails, thresholds, value}, so after to_entries the threshold booleans are
# under .value.thresholds. Read the threshold by POSITION, not by name: the key is the threshold's
# source text ("rate>0.95"), so a literal lookup returns null the moment slo.yaml's objective moves.
jq -r '.metrics | to_entries[] | select(.key | startswith("slo_met{scenario:rps_"))
       | "\(.key)  breached=\(.value.thresholds | to_entries | .[0].value)  rate=\(.value.value)"' "$S" \
  | sort -t_ -k3 -n
```

If no step breached, the ceiling is above `MAX_RATE`; raise it and re-run. If `dropped_iterations`
breached, note the step it started at — past the knee it is expected, but a drop *before* the knee
means the VU cap bit first and that step measured the generator.

## Read the server-side SLO from Grafana

k6 records only what a client can observe. `service attainment` comes from the SLO query in
`<project>/infra/grafana/queries.json`, evaluated over the run's own window, **after** the run.

`queries.json` is generated from `slo.yaml`; do not hand-write PromQL against it. `GRAFANA_AUTH` is
**required** — the read-capable service-account token. `K6_PROMETHEUS_RW_*` is write-scoped:
querying with it returns `invalid scope requested`, which a naive parser reads as "no data".

`sli_ratio` contains `$__rate_interval`, a macro the Grafana SLO API expands but a raw Prometheus
query does not. Substitute the run's own window or the query returns 400.

```bash
set -a && . .env && set +a
P="$GRAFANA_URL/api/datasources/proxy/uid/grafanacloud-prom/api/v1"
Q=<project>/infra/grafana/queries.json
for k in sli_ratio cpu_saturation_ratio; do   # plus any query loadtest.md names
  EXPR=$(jq -r --arg k "$k" '.[$k]' "$Q" | sed "s/\$__rate_interval/${RUN_WINDOW:-5m}/g")
  printf '%-24s ' "$k"
  curl -s -H "Authorization: Bearer $GRAFANA_AUTH" --get \
    --data-urlencode "query=$EXPR" "$P/query" | jq -c '.data.result[]?.value[1]'
done
```

An idle service returns `"1"` / `"0"`, not an empty result — the collector emits the zero rather
than omitting the series. An empty result therefore means a wrong query or credential.

## Recording

Append to `<project>/results.md`; create it with the header from `loadtest.md` if absent. Every
project's header starts with the same spine:

```markdown
| date | profile | infra change | RPS | k6 attainment | service attainment | budget burn x | p95 fast/std/heavy | db ms | cpu ms | EL lag p99 | <project columns> | $/hr |
```

Never carry one project's columns into another's `results.md`: an empty cell for a metric that does
not apply is not a result.

**Two attainment columns, and they are not interchangeable:**

| column | source | what it includes |
|---|---|---|
| `k6 attainment` | the k6 run's `slo_met` rate — the run **gate** | client-side: load-zone RTT, ALB queueing, the client's own scheduling |
| `service attainment` | the Grafana SLO query over the run window — the **SLO** | server-side only: callback start to response finish |

The service figure is the one that means "SLO". Expect the k6 number to be lower; if it is *higher*,
something is wrong with one of them. **Never record one number in both columns, and never a bare
"attainment".** The SLO population is classified traffic only (`class=~"fast|standard|heavy"`), so
scanner 404s on the public ALB do not count as violations.

`infra change` is the most important column. A row whose infra change is blank is not a result, it
is a number.

`budget burn x` is observed miss rate ÷ sustainable miss rate. A run is minutes and the SLO window is
days, so a raw "0.03% of budget" does not travel between runs; the multiple does. Compute it from
`service attainment`, not the k6 figure — the budget belongs to the SLO.

### Completeness check

Every row must carry `infra change` (`$4`), `k6 attainment` (`$6`) and `service attainment` (`$7`).
These are spine columns, so they land on the same field number in every project:

```bash
awk -F'|' 'NR>2 && NF>3 && ($4 ~ /^ *$/ || $6 ~ /^ *$/ || $7 ~ /^ *$/) \
  { print "INCOMPLETE ROW:", $0 }' <project>/results.md
```

Then check the project's own completeness column, whose field number `loadtest.md` gives. **Never
count pipes by eye**: `awk -F'|'` on a leading-pipe row makes `$1` the empty string, so the field
number is never the column number. After any header change, re-derive every index:

```bash
grep -m1 '^| date' <project>/results.md | awk -F'|' '{ for (i = 1; i <= NF; i++) print i": "$i }'
```

## Cloud runs

The command is `k6 cloud run`, not `k6 run`, so the generator is not the bottleneck and RTT is not
charged against the latency budget. Verified against k6 v1.4.0:

- **`--summary-export` works on `k6 cloud run`**, so everything in "Reading the results" applies.
- **There is no `k6 cloud load-zone list`.** `k6 cloud` has exactly `login`, `run` and `upload`. An
  invalid `loadZone` is rejected at submission, before any VU-hours are spent.
- **The subscription caps a test at 100 VUs**, checked against `preAllocatedVUs` at upload:
  `(400/E2004) The Virtual User (VU) count for this test (400 VUs) exceeds the maximum allowed for
  your project (100 VUs)`. It is an organization limit, so it survives the k6 project being
  recreated. How each project sizes VUs under it is in `loadtest.md`. `dropped_iterations` is a
  gating threshold (`count==0`): a run that ran out of VUs exits 99, delivered less than `RATE` and
  **measured the generator, not the service** — record it as failed, never as a pass at a lower rate.
- **`BASE_URL` and the k6 project id come from `terraform output` at the moment of use**, never from
  `.env` or a committed command. Both change on every rebuild. Use `output -json` with `jq`, never
  `output -raw`: against empty state `-raw` prints a warning **to stdout** and exits 0, and that text
  becomes the hostname. Pass the project id explicitly — no script sets `options.cloud.projectID`,
  so without it the run lands in the stack's default project.

```bash
OUT=$(terraform -chdir=<project>/infra/main output -json)
BASE_URL=$(printf '%s' "$OUT" | jq -r '.base_url.value // empty')
K6_CLOUD_PROJECT_ID=$(printf '%s' "$OUT" | jq -r '.k6_project_id.value // empty')
[ -n "$BASE_URL" ] && [ -n "$K6_CLOUD_PROJECT_ID" ] || { echo "<project> is not applied"; exit 1; }

K6_CLOUD_PROJECT_ID="$K6_CLOUD_PROJECT_ID" k6 cloud run --summary-export=/tmp/k6-<project>-<profile>.json \
  -e BASE_URL="$BASE_URL" -e RATE=<measured knee> <project>/infra/k6/tests/<profile>.js
echo "exit: $?"
```

## Reading a UI-started run from the API

Auth is `Authorization: Token $K6_CLOUD_TOKEN` from the root `.env`. Endpoints verified 2026-09-01
against the live API (shapes from `https://api.k6.io/cloud/v5/$metadata`):

```bash
source .env
PROJECT_ID=$(terraform -chdir=<project>/infra/main output -json | jq -r '.k6_project_id.value // empty')
curl -sS -H "Authorization: Token $K6_CLOUD_TOKEN" "https://api.k6.io/cloud/v5/projects/$PROJECT_ID/load_tests"
curl -sS -H "Authorization: Token $K6_CLOUD_TOKEN" "https://api.k6.io/cloud/v5/load_tests/<test_id>/test_runs"
curl -sS -H "Authorization: Token $K6_CLOUD_TOKEN" "https://api.k6.io/cloud/v5/test_runs/<run_id>/result_summary"
```

`result_summary` returns `{result_status, metrics_summary, baseline_test_run_details}`;
`metrics_summary.http_metric_summary` carries:

| API field | results column |
|---|---|
| `rps_mean`, `rps_max` | RPS achieved |
| `duration.p95`, `duration.p99` | p95 / p99 (`count, min, mean, max, p95, p99, stdev`) |
| `failures_count` / `requests_count` | error rate — **divide them yourself**; there is no rate field |
| `thresholds_summary.successes` / `.total` | how many thresholds held |
| `result_status` (top level) | the run's verdict, as a **string** |

Three traps, different from the local file's:

- **`result_status` is a string, not the inverted boolean** of the summary JSON; an unexecuted run
  reads `"Error"`. `test_runs/<id>` also has a numeric `result_status` — a different encoding.
- **No error-rate field.** Compute `failures_count / requests_count` and say so in the row.
- **`metrics_summary: null`** means uploaded but never run. Report "no run", never a measurement.

**`slo_met` is not in `http_metric_summary`.** It is a custom `Rate`, so the k6 attainment comes from
`test_runs/<run_id>/metrics`: find the `slo_met` and `slo_met_tail` entries. If their shape is not
documented here yet, print it once and write down what you found.

## `--compare`

Read the previous row for the same profile and present a before/after table: RPS, p95, error rate,
both attainments, and the one infrastructure change between them. If the previous row used a
different profile or a script that has changed since (check `git log -- <project>/infra/k6/tests/`
against the row's date), refuse to compare and say why.

## Reporting

Per CLAUDE.md, an SLO or RPS figure may only be stated with the output that produced it, from this
session. Quote the numbers with the run they came from; never carry a figure over from an earlier
conversation.

## The project contract: `<project>/loadtest.md`

Write this file when a project gets its first load profile, and update it in the same commit as any
change to the results header, the run gate or a server-side metric. Copy the structure of the
nearest sibling (`ecs-dynamodb-rps/loadtest.md`, `ecs-rds-postgres-pool/loadtest.md`); keep these
four sections, in this order, and nothing generic — what is in this skill is not repeated there:

1. **`## Results table`** — the full `results.md` header: the spine above, then the project's
   columns before `$/hr`. Drop a spine column only if the platform cannot produce it (a Lambda has
   no event loop that outlives a request, so `EL lag p99` has no meaning there) and say why. Name the
   **completeness column** — the one that says *why* a bad row was bad — with its field number,
   derived with the `awk` one-liner above.
2. **`## Before the run`** — the run gate (the condition that makes a run not comparable, e.g. a
   drained burst bucket or full CPU credits) and every pre-run reading a column needs, with the
   command or the `dev.tfvars` key it comes from.
3. **`## Load-generator sizing`** — how the profiles set `preAllocatedVUs` under the 100-VU cap, and
   the `-e` overrides.
4. **`## Server-side metrics (after the run)`** — the exact commands over `RUN_START`..`RUN_END`, then
   a `column | source | rule` table mapping every project column to its metric and statistic. For
   each metric say what an empty result means: some CloudWatch metrics publish nothing in a quiet
   minute (an empty list is then 0), others mean "widen the window" (never 0).

Rules for the commands in that file:

- **JMESPath functions are lowercase** — `max`, `min`, `avg`, `sum`. The CloudWatch statistic names
  (`Maximum`, `Minimum`, `Average`, `Sum`) are not JMESPath functions; `--query 'Maximum(...)'` is
  rejected.
- **The statistic in a column name must match the query.** A column called `p95` fed by a
  `histogram_quantile(0.99, …)` query records a p99 under a p95 label.
- Resource names come from `terraform output -json` or the Terraform source, never typed from
  memory; read every query key against `infra/grafana/queries.json` before writing it down.
- Run each command once against a live environment before calling the file done, and note the date
  it was verified.
