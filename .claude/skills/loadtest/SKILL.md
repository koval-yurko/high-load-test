---
name: loadtest
description: Run a k6 load profile against a deployed project environment, parse the summary JSON, and append a dated result record with SLO attainment to the project's results file. Use for any load test run, RPS measurement, or before/after comparison in this repo.
---

# Load test and record

Usage: `/loadtest <project> <profile> [--compare]`

Profiles live in `<project>/infra/k6/tests/<profile>.js`. Results are appended to `<project>/results.md`.

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
3. **Get the run's numbers.** Two paths, and which one you are on depends on how the run started:
   - **Started from a terminal** — `k6 cloud run --summary-export=…`, then read that JSON. See
     "Cloud runs" below. This is the path to prefer, because the exit code is a free verdict.
   - **Started from the Grafana Cloud k6 UI** — there is no local file. Read the run from the k6
     Cloud API instead; see "Reading a UI-started run from the API" below. A UI run is still
     recordable, but you must fetch the test run id from the user or the project listing.

   Either way, load must originate from Grafana Cloud's Frankfurt zone, not a laptop, so plain
   `k6 run` never belongs in this step.
4. **Capture the exit code immediately** — `echo $?` on the k6 line itself, not after a pipe (a pipe
   reports the last command's status, not k6's). A UI run has no exit code; use `result_status`
   from the API instead.
5. **Check `rate_source` before recording.** The B and C profiles no longer throw when `RATE` is
   unset — they fall back to the default in `infra/k6/tests/lib/env.js` and tag every sample
   `rate_source=default`. **A run tagged `default` is not a capacity measurement.** Record it only as
   a smoke test, never as a knee or a baseline.

## Reading the results — verified against k6 v1.4.0

Two things about this JSON are counterintuitive and will invert your conclusions if you get them wrong:

- **`thresholds` booleans are "was it breached", not "did it pass".**
  `true` = **crossed = FAILED**. `false` = satisfied = passed.
- **`http_req_failed.passes`/`.fails` do not mean pass/fail of the test.** For a rate metric, `passes`
  counts requests that *were* failures. Use `.value` (0..1) for the error rate.

Exit code: **0** = all thresholds satisfied, **99** = at least one breached. Since 2026-09-02 only
four thresholds can breach: `slo_met`, `slo_met_tail`, `http_req_failed` and `dropped_iterations`.
The per-class `http_req_duration{class:…}` entries are `p(99)>=0` — present so the sub-metric is
printed, unable to fail — so read their `p(99)` values for the row but never treat them as a verdict.

### Reading a discovery run (shape A)

Discovery is twenty scenarios, `rps_100` … `rps_2000`, 60 s each, and every one has its own
threshold `slo_met{scenario:rps_N}`. **The knee is the lowest `rps_N` whose threshold reads
`true` (breached); `RATE` for shapes B and C is the step before it.** Do not compute the knee from
elapsed time or from the cumulative `slo_met` — that cumulative threshold is only an abort so a
broken service does not run all twenty steps, and it lags the real knee by design.

```bash
# Verified against k6 v1.4.0 output on 2026-09-02. Each metric is {passes, fails, thresholds, value},
# so after to_entries the threshold booleans are under .value.thresholds, not .thresholds.
jq -r '.metrics | to_entries[] | select(.key | startswith("slo_met{scenario:rps_"))
       | "\(.key)  breached=\(.value.thresholds["rate>0.99"])  rate=\(.value.value)"' "$S" \
  | sort -t_ -k3 -n
```

If no step breached, the ceiling is above `MAX_RATE`; raise it and re-run. If `dropped_iterations`
breached during discovery, note which step it started at — past the knee it is expected (a step
that breaches also starves), but a drop *before* the knee means the 100-VU cap bit first and that
step measured the generator.

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

## Read the server-side numbers from Grafana

k6 records only what a client can observe. `service attainment` does not come from the k6 summary at
all — it comes from the SLO query and the queries in `<project>/infra/grafana/queries.json`,
evaluated over the run's own window, **after** the run finishes. (The `throttles` column is
server-side too, but it is read straight from CloudWatch — see the next section.)

`queries.json` is generated from `slo.yaml`; do not hand-write PromQL against it. `GRAFANA_AUTH` is
**required**, not optional, for this step — it is the read-capable Grafana service-account token.
`K6_PROMETHEUS_RW_*` is write-scoped: querying with it returns `invalid scope requested`, which a
naive parser reads as "no data" rather than "wrong credential".

`sli_ratio` (and only `sli_ratio`) contains `$__rate_interval`, a macro the Grafana SLO API expands
but a raw Prometheus query does not understand. Substitute the run's own window — e.g. `sed
's/\$__rate_interval/5m/g'` — or the query 400s.

```bash
set -a && . .env && set +a
P="$GRAFANA_URL/api/datasources/proxy/uid/grafanacloud-prom/api/v1"
Q=<project>/infra/grafana/queries.json
for k in sli_ratio cpu_saturation_ratio; do
  EXPR=$(jq -r --arg k "$k" '.[$k]' "$Q" | sed "s/\$__rate_interval/${RUN_WINDOW:-5m}/g")
  printf '%-24s ' "$k"
  curl -s -H "Authorization: Bearer $GRAFANA_AUTH" --get \
    --data-urlencode "query=$EXPR" "$P/query" | jq -c '.data.result[]?.value[1]'
done
```

Verified live against this repo's stack (2026-09-01, idle service — expect `0`/`1`, not a live-run
number): `sli_ratio` → `"1"`, `cpu_saturation_ratio` → `"0"`. Each returns a **value**, not an empty
result — the collector emits the zero rather than omitting the series.

## Read the throttle counts from CloudWatch

The two throttle readings no longer come from Grafana. Alloy's DynamoDB block was trimmed to
`SuccessfulRequestLatency`, so `read_throttle_events` / `write_throttle_events` are gone from
`queries.json` and from Prometheus — read the source instead, over the run's own window, per-60s
`Sum`, peak of each:

```bash
TABLE=$(terraform -chdir=<project>/infra/main output -raw table_name)
for m in ReadThrottleEvents WriteThrottleEvents; do
  printf '%-20s ' "$m"
  aws cloudwatch get-metric-statistics --namespace AWS/DynamoDB --metric-name "$m" \
    --dimensions Name=TableName,Value="$TABLE" --statistics Sum --period 60 \
    --start-time "$RUN_START" --end-time "$RUN_END" \
    --query 'max(Datapoints[].Sum) || `0`' --output text
done
```

`RUN_START` / `RUN_END` are the run's own timestamps in UTC ISO-8601 (e.g.
`2026-09-04T10:00:00Z`). `aws cloudwatch get-metric-statistics` is already on the permission
allowlist.

**CloudWatch publishes these two metrics sparsely: a minute with no throttling produces no
datapoint at all, not a zero.** So an empty `Datapoints` list means "nothing was throttled", which
is why the JMESPath query ends in a ``|| `0` `` fallback — a missing datapoint is zero, not
missing data. (The zeros
that used to come back from Prometheus were the Alloy exporter filling gaps, not CloudWatch.) The
same sparseness is why the throttle alert in `infra/grafana/throttles.tf` is two rules rather than
one summed rule.

**Nothing derives a bound resource.** The four-row attribution table this skill used to reference
was deleted on 2026-09-01 — it named the service while DynamoDB was rejecting 5,588 reads per
minute, because SDK retry backoff inflates every service-side signal. Record `throttles` as **`read/write`** — the peak
per-minute value of `ReadThrottleEvents`, a slash, then the peak per-minute value of
`WriteThrottleEvents`, both over the run window: e.g. `5588/0`. Two numbers, not the larger of the
two, mirroring the `RCU/WCU` column's convention — separating reads from writes is the entire reason
these two metrics were chosen over `ThrottledRequests` (which is published only per
`TableName`+`Operation` and reads 0 at instants during sustained throttling). Then let whoever reads
the row draw the conclusion from that plus the latency columns.

## Recording

Append to `<project>/results.md` — create it with a header row if absent:

```markdown
| date | profile | infra change | RPS | k6 attainment | service attainment | budget burn x | p95 fast/std/heavy | db ms | cpu ms | EL lag p99 | throttles | RCU/WCU | $/hr |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
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

### Completeness check

Before writing up results, confirm every row carries the columns that make it a result rather than a
number:

```bash
awk -F'|' 'NR>2 && NF>3 && ($4 ~ /^ *$/ || $6 ~ /^ *$/ || $7 ~ /^ *$/ || $13 ~ /^ *$/) \
  { print "INCOMPLETE ROW:", $0 }' <project>/results.md
```

`$4` = infra change, `$6` = k6 attainment, `$7` = service attainment, `$13` = throttles.

**Do not assume those indices survive a schema change.** `awk -F'|'` on a leading-pipe Markdown row
makes `$1` the empty string before the first column, so the field number is never the column number.
After touching this table again, re-derive every index by piping the header row through
`awk -F'|'` and printing the fields — never by counting pipes by eye. Counting is how the previous
version of this check ended up validating the wrong columns while documenting itself as validating
the right ones.

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

Capture the exit code on the k6 line itself — behind a pipe you get the pipe's status. `99` means
one of the four gating thresholds was breached (`slo_met`, `slo_met_tail`, `http_req_failed`,
`dropped_iterations`); `0` means all passed.

- **The project caps virtual users, and the cap bites at upload time.** Verified 2026-09-01 against
  the hand-made k6 project `8474786`, and the cap is an organization/subscription one rather than a
  property of the project object — so it applies unchanged to the k6 project `platform/` now owns
  (`ecs-dynamodb-rps`), whose own `vu_max_per_test` reads 25000. Any test asking for more than
  **100 VUs** is rejected with
  `(400/E2004) The Virtual User (VU) count for this test (400 VUs) exceeds the maximum allowed for
  your project (100 VUs)`. `preAllocatedVUs` is what the check reads. Since 2026-09-02 the scripts
  derive it as `min(100, ceil(rate × 0.125))` — 125 ms is the frozen mix's mean latency at the SLO
  boundary — so a run that meets the SLO never starves and the cap is only reached from 800 rps up.
  This is a **generator** limit, not a service limit: at 100 VUs the achievable rate is roughly
  `100 / mean_iteration_seconds`, so it collapses exactly where the service slows down — near the
  knee. `dropped_iterations` is now a **gating threshold** (`count==0`): a run that ran out of VUs
  exits 99 and the summary shows the breach. Such a run delivered less than `RATE` and **measured
  the generator, not the service**; record it as a failed run, never as a pass at a lower rate.

- **`BASE_URL` never appears in a command line in git.** It comes from the root `.env` (this repo is
  public and the ALB has no auth). Source it, pass it through.

```bash
source .env
k6 cloud run --summary-export=/tmp/k6-<project>-<profile>.json \
  -e BASE_URL="$BASE_URL" -e RATE=<measured knee> <project>/infra/k6/tests/<profile>.js
echo "exit: $?"
```

## Reading a UI-started run from the API

A run started from the Grafana Cloud k6 UI writes no local file. Everything the results row needs is
in the k6 Cloud API instead. Auth is `Authorization: Token $K6_CLOUD_TOKEN` from the root `.env`.

**Endpoints, verified 2026-09-01 against the live API** (shapes taken from the service's own OData
schema at `https://api.k6.io/cloud/v5/$metadata`, not guessed):

```bash
source .env

# 1. Find the run. Tests in the project:
curl -sS -H "Authorization: Token $K6_CLOUD_TOKEN" \
  "https://api.k6.io/cloud/v5/projects/$K6_CLOUD_PROJECT_ID/load_tests"

# 2. That test's runs, newest last:
curl -sS -H "Authorization: Token $K6_CLOUD_TOKEN" \
  "https://api.k6.io/cloud/v5/load_tests/<test_id>/test_runs"

# 3. The numbers:
curl -sS -H "Authorization: Token $K6_CLOUD_TOKEN" \
  "https://api.k6.io/cloud/v5/test_runs/<run_id>/result_summary"
```

`result_summary` returns `{result_status, metrics_summary, baseline_test_run_details}`, where
`metrics_summary.http_metric_summary` carries the fields the results row is built from:

| API field | results column |
|---|---|
| `rps_mean`, `rps_max` | RPS achieved |
| `duration.p95`, `duration.p99` | p95 / p99 (a `TrendSummary`: `count, min, mean, max, p95, p99, stdev`) |
| `duration_median` | median |
| `failures_count` / `requests_count` | error rate — **divide them yourself**; there is no rate field |
| `thresholds_summary.successes` / `.total` | how many thresholds held |
| `result_status` (top level) | the run's verdict, as a **string** |

**Three traps, and they are not the same traps as the local file's.**

- **`result_status` is a string here, not the inverted boolean of the summary JSON.** In
  `--summary-export` a threshold's boolean means *was it breached* (`true` = failed). In the API it
  is a word — an unexecuted run reads `"Error"`. Do not carry the inversion habit across; do not
  carry a raw integer either, since `test_runs/<id>` also exposes a numeric `result_status` that is
  a different encoding of the same thing.
- **There is no error-rate field.** `http_req_failed.value` has no API equivalent — compute
  `failures_count / requests_count` and say so in the row.
- **An archived-but-never-run test returns `metrics_summary: null`.** That is not an API failure and
  not a zero-result run; it means the test was uploaded and never executed. Report it as "no run",
  never as a measurement.

**`slo_met` is not in `http_metric_summary`.** It is a custom `Rate` metric, so the client-side SLO
attainment — the gate — comes from `test_runs/<run_id>/metrics`, not from `result_summary`. Fetch
that list and find the `slo_met` and `slo_met_tail` entries. If the shape there is not yet documented
in this skill, print it once and write down what you found rather than assuming it matches
`TrendSummary`.

## `--compare`

Read the previous row for the same profile and present a before/after table: RPS, p95, error rate,
SLO attainment, and the one infrastructure change between them. If the previous row used a different
profile or an edited script, refuse to compare and explain why.

## Reporting

Per CLAUDE.md, an SLO or RPS figure may only be stated with the output that produced it, from this
session. Quote the numbers with the run they came from; never carry a figure over from an earlier
conversation.
