# lambda-concurrency-limit — load-test contract

What `/loadtest` needs to know about this project and nothing else does. The generic procedure
(cloud run, summary parsing, `--compare`) lives in `.claude/skills/loadtest/SKILL.md`; this file
holds only what differs per project.

## Results table

`results.md` header — the shared spine, then this project's columns. `EL lag p99` is dropped: a
Lambda has no event loop that outlives a request. `service attainment` is dropped: there is no
service-side SLI (the SLO is judged from k6 only).

```markdown
| date | profile | infra change | seed | λ target | RPS | k6 attainment (lat / avail) | throttle % | rate-limited % normal / noisy / anonymous | p95 fast/std/heavy | p99 fast/std/heavy | Duration avg / export avg | cold starts | consumed RCU | ddb throttles | reserved / provisioned | otel | k6 run |
```

Completeness column: `throttle %`. Derive its field number with
`head -1 results.md | awk -F'|' '{for(i=1;i<=NF;i++) print i": "$i}'` and write the number here
after any header change (the leading pipe makes `$1` empty): `$10`.

A knob row with a blank `throttle %`, `k6 attainment` or `infra change` is incomplete.

A `noisy-neighbour` row is invalid if the judged (normal) user has `rate_limited > 0`: the per-user
limit was set wrong, which is a design failure, not a result.

## Before the run

1. **Run gate.** All of these must hold, or the run is not recordable:
   - `ReadThrottleEvents` = 0 on the table over the last 10 minutes (command below). An empty
     result counts as 0.
   - The alias is current: `./scripts/deploy-service.sh --check` compares alias `live`'s settings
     with `$LATEST` and must say they match.
   - Provisioned concurrency is READY when it is on.
   - For a row on a PROVISIONED table (an exploration row): the burst bucket holds 300 s of unused
     capacity. Wait 5 minutes idle first.
2. **Pre-run readings.**
   - `terraform -chdir=infra/main output -json knobs` — reserved and provisioned concurrency, otel.
   - `seed-manifest.json` — the seed id for the `seed` column.

## Load-generator sizing

`vus(rate, cap)` in `infra/k6/tests/lib/arrivals.js`:

```
n = min(cap, max(5, ceil(2 × rate × MEAN_SECONDS)))
```

`MEAN_SECONDS` is the mix-weighted class threshold: 0.36 s with the provisional thresholds.

Caps (the Grafana Cloud subscription allows 100 VUs):

| profile | cap |
|---|---|
| `constant`, `discovery` | 100 per scenario (scenarios run one after another) |
| `spike` | 20 base + 80 surge |
| `noisy-neighbour` | 4 × 12 + 52 |
| `tiers` | 20 normal + 20 noisy + 30 anonymous (`TIER_VU_CAP` in `lib/tier.js`) |

A run needs rate × mean client latency ≤ the scenario's VUs (requests in flight; the × 2 in `vus()`
is headroom, not the limit). Past that the generator runs out of VUs and `dropped_iterations` fails
the run. Record it as failed; the service did not cause it. Consequences: knob 2 compares C = 20 and
C = 100 at about 300 RPS (about 300 × 0.22 s ≈ 66 in flight), not at C = 100's 404 RPS capacity; the
spike peak is at most about 80 RPS, because each request in the cold-start head holds a VU for about
1 s against the surge scenario's 80 VUs.

Start every run with `./scripts/upload-k6.sh --only <profile> <flags>` (it uploads the keys, then runs).
A bare `k6 cloud run` sends no API key and every request gets 403.

`upload-k6.sh` flags and the `-e` names they set:

| profile | flag | `-e` name |
|---|---|---|
| `constant` | `--rate` | `RATE` |
| `discovery` | `--start-rate` | `START_RATE` |
| `discovery` | `--max-rate` | `MAX_RATE` |
| `discovery` | `--step-rps` | `STEP_RPS` |
| `discovery` | `--step-seconds` | `STEP_SECONDS` |
| `spike` | `--peak-rate` | `PEAK_RATE` |
| `noisy-neighbour` | `--normal-rate` | `NORMAL_RATE` |
| `noisy-neighbour` | `--noisy-rate` | `NOISY_RATE` |
| `tiers` | `--normal-rate`, `--noisy-rate` | `NORMAL_RATE`, `NOISY_RATE` (per caller) |
| `tiers` | `--normal-callers` | `NORMAL_CALLERS` (1 to 4) |
| `tiers` | `--anon-callers` | `ANON_CALLERS` (default 20) |
| `tiers` | `--anon-rate` | `ANON_RATE` (per caller, 20 callers) |
| `tiers` | `--tiers` | `TIERS` (comma list of normal, noisy, anonymous; default all) |

## Server-side metrics (after the run)

**Not yet run against a live environment; plan 3, phase 0 verifies each command and dates it.**

`RUN_START` / `RUN_END` are the run's own window, ISO 8601 UTC. Function `lambda-concurrency-limit`,
alias `live`, table `lambda-concurrency-limit`, region `eu-central-1`. Dimensions are those in
`infra/grafana/dashboard.tf`. JMESPath functions are lowercase (`sum`, not `Sum`).

```bash
export AWS_REGION=eu-central-1
FN=lambda-concurrency-limit
cw() {  # <namespace> <metric> <statistic> <JMESPath fn: sum|avg|max> <dimension args...>
  local ns=$1 m=$2 st=$3 fn=$4; shift 4
  local dims=(); [ $# -gt 0 ] && dims=(--dimensions "$@")  # ColdStarts has none
  printf '%-32s ' "$m"
  aws cloudwatch get-metric-statistics --region eu-central-1 --namespace "$ns" --metric-name "$m" \
    "${dims[@]}" --statistics "$st" --period 60 \
    --start-time "$RUN_START" --end-time "$RUN_END" \
    --query "$fn(Datapoints[].$st)" --output text
}
FNDIM=Name=FunctionName,Value=$FN
ALIASDIM=Name=Resource,Value=${FN}:live
cw AWS/Lambda Throttles                     Sum sum $FNDIM
cw AWS/Lambda Invocations                   Sum sum $FNDIM
cw AWS/Lambda Duration                      Average avg $FNDIM $ALIASDIM
cw AWS/Lambda PostRuntimeExtensionsDuration Average avg $FNDIM $ALIASDIM
cw lambda-concurrency-limit ColdStarts      Sum sum
cw AWS/DynamoDB ConsumedReadCapacityUnits   Sum sum Name=TableName,Value=${FN}
cw AWS/DynamoDB ReadThrottleEvents          Sum sum Name=TableName,Value=${FN}
```

`avg(Datapoints[].Average)` is an unweighted mean of per-minute averages, so it is skewed when load
varies (the spike profile). The k6 summary is the authoritative latency; use this only for the
`Duration avg / export avg` column.

For the run gate, run the last command with `RUN_START` set to 10 minutes ago and `RUN_END` to now.

| column | source | rule |
|---|---|---|
| `throttle %` | `Throttles` Sum (Lambda), `Count` Sum (API Gateway) | `Throttles ÷ Count × 100`, whole run. `Count` is every request the clients sent, so a per-key limit that sheds requests at the gateway does not shrink the denominator. Rows before 2026-11-12 used `Throttles ÷ (Throttles + Invocations)` (marked †) |
| `Duration avg / export avg` | `Duration` Average, `PostRuntimeExtensionsDuration` Average | milliseconds; export is the OTel extension's flush time after the handler returns |
| `cold starts` | `ColdStarts` Sum, namespace `lambda-concurrency-limit` | custom metric |
| `consumed RCU` | `ConsumedReadCapacityUnits` Sum | total over the window |
| `ddb throttles` | `ReadThrottleEvents` Sum | |
| `rate-limited % …`, `p95`, `p99`, `RPS`, `k6 attainment` | k6 summary and run | not CloudWatch; see the skill |

What an empty result means:

- `Throttles`, `ReadThrottleEvents`, `ColdStarts`: **0.** These publish nothing in a quiet minute.
- `Invocations`: 0 only if the run sent nothing; otherwise the window is wrong.
- `Duration`, `PostRuntimeExtensionsDuration`: **never 0.** An empty result means the window or
  the `Resource` dimension is wrong. Widen the window or check the alias name.
- `ConsumedReadCapacityUnits`: wrong window; every request reads the table.
