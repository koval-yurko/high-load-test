# ecs-rds-postgres-pool — load-test contract

What `/loadtest` needs to know about this project and nothing else does. The generic procedure
(cloud run, summary parsing, both attainment columns, `--compare`) lives in
`.claude/skills/loadtest/SKILL.md`; this file holds only what differs per project.

## Results table

`results.md` header — the shared spine, then this project's columns before `$/hr`:

```markdown
| date | profile | infra change | RPS | k6 attainment | service attainment | budget burn x | p95 fast/std/heavy | db ms | cpu ms | EL lag p99 | pool wait p99 | waiting peak | DBLoadCPU/vCPU | connections | pool size | credit balance | posts rows | $/hr |
```

Completeness column: `$14` = `waiting peak` — the column that says why a bad row was bad (requests
queued for a connection). Re-derive it from the header with `awk -F'|'` after any header change.

## Before the run

1. **Run gate: burst credits.** The instance runs in unlimited burst-credit mode. Read
   `CPUCreditBalance` and `CPUSurplusCreditBalance` (commands below, over the last 10 minutes). Do
   not start until the balance is full and the surplus is zero.
2. **`posts rows`.** `SELECT count(*) FROM posts`, immediately before the run
   (`terraform -chdir=infra/main output -raw psql` prints the psql command). The table is never
   reset — 20% of the mix inserts and the heartbeat inserts once a minute — so its size is recorded
   rather than controlled.
3. **`pool size`** is `pool_size × desired_count` from `infra/main/dev.tfvars` (e.g. `5×1`); record
   the values the run used.

## Load-generator sizing

Every profile sizes `preAllocatedVUs` by Little's law: rate × the mix-weighted class threshold
from `lib/slo.js` (`DERIVED_MEAN_SECONDS`), capped at the 100-VU subscription limit.
`-e MEAN_SECONDS=<s>` overrides the mean; `-e PRE_VUS=<n>` overrides the VU count in `constant` and
`stress`. A breached `dropped_iterations` means the generator, not the service, ran out — record the
run as failed.

## Server-side metrics (after the run)

`RUN_START` / `RUN_END` are the run's own window in UTC ISO-8601. The instance identifier is the
project name (`infra/main/rds.tf`, `identifier = var.project`).

```bash
rds() {  # <metric> <CloudWatch statistic> <JMESPath function: max|min|avg>
  printf '%-24s ' "$1"
  aws cloudwatch get-metric-statistics --namespace AWS/RDS --metric-name "$1" \
    --dimensions Name=DBInstanceIdentifier,Value=ecs-rds-postgres-pool --statistics "$2" \
    --period 60 --start-time "$RUN_START" --end-time "$RUN_END" \
    --query "$3(Datapoints[].$2)" --output text
}
rds DatabaseConnections     Maximum max
rds DBLoadCPU               Average avg
rds CPUCreditBalance        Minimum min
rds CPUSurplusCreditBalance Maximum max
```

The CloudWatch statistic (`Maximum`) and the JMESPath function (`max`) are different names for the
same idea, and only the lowercase one is a JMESPath function — `Maximum(...)` is rejected.

| column | source | rule |
|---|---|---|
| `connections` | `DatabaseConnections`, max | |
| `DBLoadCPU/vCPU` | `DBLoadCPU`, avg, ÷ the vCPU count of `instance_class` | record the quotient; `DBLoadCPU` counts active sessions, it is not a percentage |
| `credit balance` | `CPUCreditBalance`, min | the low point is the one closest to running out |
| — | `CPUSurplusCreditBalance`, max | **validity check, not a column.** Above zero disqualifies the run: note it in `infra change` or do not record the row |
| `pool wait p99` | `pool_wait_p99_by_class` in `infra/grafana/queries.json` | per class, over the run window |
| `waiting peak` | `pool_waiting` in `infra/grafana/queries.json`, max over the run window | |

**A quiet minute publishes no datapoint, not a zero.** An empty list prints `None`. Do not record it
as 0: widen the window instead. (The DynamoDB throttle counts are the opposite case.)
