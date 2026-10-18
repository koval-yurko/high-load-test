# ecs-dynamodb-rps — load-test contract

What `/loadtest` needs to know about this project and nothing else does. The generic procedure
(cloud run, summary parsing, both attainment columns, `--compare`) lives in
`.claude/skills/loadtest/SKILL.md`; this file holds only what differs per project.

## Results table

`results.md` header — the shared spine, then this project's columns before `$/hr`:

```markdown
| date | profile | infra change | RPS | k6 attainment | service attainment | budget burn x | p95 fast/std/heavy | db ms | cpu ms | EL lag p99 | throttles | RCU/WCU | $/hr |
```

Completeness column: `$13` = `throttles` — the column that says why a bad row was bad. Re-derive it
from the header with `awk -F'|'` after any header change.

## Before the run

1. **Run gate: drain the burst bucket.** Wait 6 minutes with no load before every run. DynamoDB
   banks unused capacity for about 300 s, so a run that starts from a partly-drained bucket is not
   comparable to one that starts full. **A run without the drain must not be recorded.**
2. **`RCU/WCU`** are `read_capacity` / `write_capacity` in `infra/main/dev.tfvars`; record the values
   the run used. `npm run slo:check` prints them beside the `capacity:` model in `slo.yaml`.

## Load-generator sizing

`preAllocatedVUs = min(100, ceil(rate × 0.125))` in every profile — 125 ms is this mix's mean latency
at the SLO boundary — so the 100-VU subscription cap is reached only from 800 rps up.
`-e PRE_VUS=<n>` overrides it in `constant` and `stress`. A breached `dropped_iterations` means the
generator, not the service, ran out — record the run as failed.

## Server-side metrics (after the run)

`RUN_START` / `RUN_END` are the run's own window in UTC ISO-8601. Peak per-minute `Sum` of each:

```bash
TABLE=$(terraform -chdir=infra/main output -json | jq -r '.table_name.value // empty')
for m in ReadThrottleEvents WriteThrottleEvents; do
  printf '%-20s ' "$m"
  aws cloudwatch get-metric-statistics --namespace AWS/DynamoDB --metric-name "$m" \
    --dimensions Name=TableName,Value="$TABLE" --statistics Sum --period 60 \
    --start-time "$RUN_START" --end-time "$RUN_END" \
    --query 'max(Datapoints[].Sum) || `0`' --output text
done
```

| column | source | rule |
|---|---|---|
| `throttles` | the two peaks above, as `read/write` (e.g. `5588/0`) | two numbers, never the larger one |

**A minute with no throttling publishes no datapoint**, so an empty list means zero here — that is
what the `` || `0` `` fallback does. These two metrics, not `ThrottledRequests`, because
`ThrottledRequests` is published only per `TableName`+`Operation` and reads 0 at moments during
sustained throttling.

Nothing derives a "bound resource" from these numbers. SDK retry backoff inflates every service-side
signal while DynamoDB throttles, so a derived verdict once named the service while DynamoDB was
rejecting 5,588 reads a minute. Record the throttles and the latency columns; the reader concludes.
