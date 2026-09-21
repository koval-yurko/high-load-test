# ecs-rds-postgres-pool — results

Each row is one `/loadtest` run: the k6 profile, the one infra change that distinguishes it from the
previous row, and the SLO/pool/instance numbers that run produced. `posts rows` is
`SELECT count(*) FROM posts`, taken immediately before the run starts — the table is never reset
between runs (20% of the mix inserts, and a heartbeat inserts one row a minute), so its size is
recorded rather than controlled.

| date | profile | infra change | RPS | k6 attainment | service attainment | budget burn x | p95 fast/std/heavy | db ms | cpu ms | EL lag p99 | pool wait p95 | waiting peak | DBLoadCPU/vCPU | connections | pool size | credit balance | posts rows | $/hr |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
