# ecs-rds-postgres-pool

A Node.js service on ECS Fargate in front of an RDS PostgreSQL `db.t4g.micro`, built so that the
**application's connection pool** is the binding constraint, then released one knob at a time.

**The question it answers:** when a service's pool is the bottleneck, what does each of the three
standard fixes — a bigger pool, more tasks, an RDS Proxy — actually do to SLO attainment, and where
does the next bottleneck appear? Each knob is a separate apply and a separate row in `results.md`,
measured with the identical k6 profile.

Full design: `docs/superpowers/specs/2026-09-19-ecs-rds-postgres-pool-design.md`. Service plan:
`docs/superpowers/plans/2026-09-20-ecs-rds-postgres-pool-service.md`. Infrastructure plan:
`docs/superpowers/plans/2026-09-21-ecs-rds-postgres-pool-infrastructure.md`.

## What it provisions

All of it from `infra/main`, the root module of the HCP Terraform workspace `ecs-rds-postgres-pool`
(the workspace itself is created by `platform/`). Every resource carries `Project =
ecs-rds-postgres-pool` through the AWS provider's `default_tags`.

| file | what |
|---|---|
| `network.tf` | VPC, two public subnets, security groups for the ALB, the tasks and the database |
| `rds.tf` | PostgreSQL 16 on `db.t4g.micro`, gp3, Performance Insights (free-tier retention), no final snapshot, no backups |
| `proxy.tf` | RDS Proxy, its Secrets Manager secret and IAM role — all `count = proxy_enabled ? 1 : 0`, so it costs nothing until knob 3 |
| `ecs.tf` `alb.tf` `ecr.tf` | the app service behind a public ALB (HTTP, no auth), its task definition and image repository |
| `collector.tf` | the Grafana Alloy gateway collector the tasks export OTLP to |
| `heartbeat.tf` | a Lambda on a one-minute schedule, so the SLI has a population between load tests |
| `grafana.tf` | calls `../grafana` (dashboard, saturation and canary alert rules) and `../k6` (the Grafana Cloud k6 project) |

The database is public and its security group admits 5432 from **any address**: the password and
TLS forced by `rds.force_ssl` are the only guard, and internet scanners will reach the login prompt.
A deliberate lab trade (plan decision D7) — the alternative was a NAT gateway, and psql works from
any network. The password is `DB_PASSWORD` in the root `.env`, a random value you can read there.

### Outputs

`terraform -chdir=infra/main output -json` — always `-json` piped through `jq`, never `-raw`, which
against an empty state prints a warning to stdout and exits 0.

| output | read by |
|---|---|
| `base_url` | `scripts/upload-k6.sh`, `/loadtest`, local k6 runs |
| `k6_project_id` | `scripts/upload-k6.sh` — new after every teardown, never copy it |
| `ecr_repository_url` `cluster_name` `service_name` | `scripts/deploy-service.sh` |
| `db_endpoint` | you, for `psql`. Host and port only: the connection string carries the password and is deliberately not an output |
| `psql` | you: the connection command, without the password (user and database are both `app`). It prompts; the password is `DB_PASSWORD` in the root `.env` |
| `app_environment` | you, before an apply: the app container's environment minus `DATABASE_URL`, because the task definition itself prints as `(sensitive value)` in a plan |
| `database_target` | you: `instance` or `proxy` — where `DATABASE_URL` points, which knob 3 switches |
| `knobs` | `/loadtest`, recorded on every `results.md` row |
| `collector_endpoint` `collector_service_name` `heartbeat_function_name` | debugging the telemetry path |

## The environment-variable contract

The interface between the service (`service/src/config.js`) and the task definition
(`infra/main/ecs.tf`). Moved here from the service plan, which is executed and stays frozen. A
misspelt name is not a Terraform error — the service silently falls back to its default — so a
change here is a change in both files.

| variable | type | absent means | set by Terraform from |
|---|---|---|---|
| `PORT` | number | 8080 | `container_port` |
| `AWS_REGION` | string | `eu-central-1` | the provider's region |
| `DATABASE_URL` | string | **required** — the service exits non-zero at boot | built in `proxy.tf`; its host is the instance, or the proxy when `proxy_enabled` |
| `DB_SSL` | `"require"` \| `"off"` | `"require"` | fixed `"require"` |
| `DB_CA_BUNDLE` | path | `/app/certs/rds-global-bundle.pem`, which the image downloads at build time | not set — the image default. The trust store is Node's public roots plus this bundle, because the instance presents an RDS-CA certificate and the proxy an ACM certificate chaining to Amazon's public roots |
| `POOL_MAX` | number | 5 — **knob 1** | `pool_size` |
| `POOL_CONNECTION_TIMEOUT_MS` | number | 900 | `pool_connection_timeout_ms` |
| `MIGRATE_ON_BOOT` | `"1"` \| unset | off | `migrate_on_boot` (`true` → `"1"`, `false` → `""`) |
| `SEED_ON_BOOT` | `"1"` \| unset | off | `seed_on_boot`, same encoding |
| `SEED_ROWS` | number | 50000 | `seed_rows` |
| `SEED_FEEDS` | number | 16 | `seed_feeds` |
| `FEED_PAGE_SIZE` | number | 20 | `feed_page_size` |
| `REPORT_SCAN_ROWS` | number | 0 — the calibrated cost knob; 0 makes the heavy route return immediately | `report_scan_rows` |
| `OTEL_SERVICE_NAME` | string | `ecs-rds-postgres-pool` | the project name |
| `OTEL_SERVICE_INSTANCE_ID` | string | ECS task metadata supplies `service.instance.id` | **deliberately not set**: a constant would collapse every task onto one series. It is a manual override for when detection fails |
| `OTLP_ENDPOINT` | string | no exporter; recorders are no-ops | the collector's Cloud Map name, port 4318 |
| `OTEL_EXPORT_INTERVAL_MS` | number | 15000 | not set |
| `METRICS_NAMESPACE` | string | no CloudWatch publisher, no AWS client | the project name |
| `METRICS_INTERVAL_MS` | number | 10000 | not set |

There is deliberately **no** `SHED_ELU_THRESHOLD`: admission control would shed 429s before the pool
queue forms, and a saturated pool is supposed to produce the 5xx the availability objective counts.

**Never put an `sslmode=` query parameter in `DATABASE_URL`.** `pg` merges the parsed URL over the
explicit `ssl` config, so the parameter would silently replace the verified trust store —
`sslmode=no-verify` would turn certificate verification off without an error anywhere.

**Certificate verification covers the request path, not migrations.** `prisma migrate deploy` at
boot connects through Prisma's own engine with the bare URL; the verified trust store lives in
`service/src/pool.js`, which only the request path uses.

## The knob sequence

Three knobs, each its own `dev.tfvars` line, its own apply, its own approval and its own ledger row.
There is no autoscaler: `desired_count` is a fixed number, so every run is one configuration.

| phase | `dev.tfvars` change | app connections (`pool_size × desired_count`) | what it tests |
|---|---|---|---|
| baseline | `pool_size = 5`, `desired_count = 1` | 5 × 1 = **5** | the pool binds before the database does |
| knob 1 | `pool_size = 25` | 25 × 1 = **25** | releasing the client pool; the bottleneck should move toward database CPU |
| knob 2 | `desired_count = 4` | 25 × 4 = **100**, against a ceiling estimated at ~112 | whether `FATAL: sorry, too many clients already` — a 5xx — becomes reachable |
| knob 3 | `proxy_enabled = true` | multiplexed by the proxy | whether the proxy removes that failure for four long-lived tasks holding warm pools |

The ~112 ceiling is an **estimate** from RDS's default `max_connections` formula for the instance's
memory, not a reading. **Before knob 2 runs:**

1. Connect with the `psql` output and run `SHOW max_connections`.
2. Subtract what the application can never use: the reserved superuser slots
   (`SHOW superuser_reserved_connections`) and RDS's own sessions (`rdsadmin` and friends — count
   them in `pg_stat_activity` on the idle instance).
3. Re-derive `max_connections_alert` from that net figure and set it in `dev.tfvars`. Its default of
   100 is exactly knob 2's arithmetic and is itself an estimate; the ceiling alert means nothing
   until it is grounded in the real number.

**Before knob 3 runs:** confirm the unit of the proxy's `DatabaseConnectionsBorrowLatency` in the
CloudWatch console on the real proxy (AWS documents a sibling proxy metric in microseconds; community
reports discuss borrow latency in milliseconds), then set `proxy_borrow_latency_threshold`. It is
`null` by default and knob 3 refuses to plan until it is set. The proxy costs roughly 40% of the idle
bill while it exists: run it last and destroy promptly.

**The table grows between runs, and that is recorded rather than reset** (plan decision D6). The
`write` and `report` routes both insert into `posts`, the table the heavy route scans, and the
heartbeat inserts too (a `POST /posts` and a `POST /reports` every minute), so every run meets a
bigger table than the last, and because the knobs run in a fixed order the growth correlates with
the knob sequence. Nothing resets it — the seed does not truncate, and re-running it adds rows on
top. **Record `SELECT count(*) FROM posts` on every `results.md` row, taken just before the run**,
so the confound is visible in the ledger.

## Configuration notes that bite

- **`dev.tfvars` is authoritative** for every sizing knob; `slo.yaml`'s `capacity` block is advisory
  and only computes.
- **`slo.yaml`'s `attribution.vcpu_per_task` (0.25) must equal `task_cpu / 1024`** from
  `dev.tfvars` (256 → 0.25). Change both together: the generated CPU-saturation ratio divides by
  it, and nothing yet cross-checks the two.
- **`seed_on_boot` is one task, one shot.** The seed is neither idempotent nor lock-guarded: two
  tasks booting with it set insert twice the rows, and a redeploy doubles them again. Set it with
  `desired_count = 1`, deploy once, set it back to `false`.
- **`report_scan_rows = 0` means uncalibrated.** Plan 3's calibration sets it on the real instance;
  until then the heavy route does no work.
- **`db_password` is not in any tfvars file on purpose.** It is `DB_PASSWORD` in the root `.env`
  (generate with `openssl rand -hex 24`); `.envrc` exports it as `TF_VAR_db_password` and
  `platform/` puts it in the shared HCP variable set, which is how remote runs receive it. After
  changing it, re-apply `platform/` (`terraform -chdir=platform apply`, from the repo root) before
  the next `/env up`. A validation requires 20–128 URL-safe characters.
- **`pool_connection_timeout_ms` has no default** (plan decision D5). `dev.tfvars` sets 900 as a
  labelled, unmeasured placeholder; plan 3 replaces it with the heavy class threshold plus a margin.
- **The class thresholds in `slo.yaml` are `null`** until plan 3 freezes them after calibration, and
  `npm run slo:check` exits non-zero until then — that is the guard, not a bug.

## Run it

From this directory, with the repo root's `.env` loaded by direnv (tool shells need
`direnv exec <repo-root> <command>`).

1. **`/env up ecs-rds-postgres-pool`** — plans `infra/main` with `dev.tfvars` (the password arrives from the
   shared HCP variable set, see "Configuration notes that bite") and stops for
   your approval before applying. Nothing else here applies Terraform: no project script may.
2. **`./scripts/deploy-service.sh`** — builds the image for `linux/amd64`, pushes it to the ECR
   repository from `ecr_repository_url`, and forces a new deployment of `service_name`. Migrations
   run at container start (`migrate_on_boot`).
3. **`./scripts/upload-k6.sh`** — uploads the load profiles into the environment's own Grafana Cloud
   k6 project, with `base_url` baked into the archive.
4. **`/loadtest ecs-rds-postgres-pool <profile>`** — `discovery`, `constant` or `stress`; appends a
   row to `results.md`.
5. **`/env down ecs-rds-postgres-pool`** when done measuring, followed by the skill's billable-resource
   sweep.

**The load profiles cannot run yet.** They import `infra/k6/tests/lib/slo.js`, which plan 3
generates from the frozen class thresholds; and until then they also require `-e MEAN_SECONDS=…`
(the Little's-law VU sizing derives from those thresholds) and refuse to start without it.
`scripts/upload-k6.sh` passes only `BASE_URL` and `RATE` to the archive, so once `slo.js` exists
every upload throws on that guard until plan 3 passes `-e MEAN_SECONDS` or replaces the guard.

### The service, locally

From `service/`: `npm ci`, then **`npx prisma generate`** before the first `npm test` — the tests
import the generated client. `prisma.config.js` reads `DATABASE_URL` and the engine wants a
syntactically valid one even offline, so a placeholder suffices:

```bash
DATABASE_URL=postgresql://placeholder@localhost:5432/placeholder npx prisma generate
npm test
node --test test/<file>.test.js   # one file: a path, not a name
```

There is no local Postgres and no integration suite, by design.

## Measured results

No runs yet — plan 3 produces the first numbers.
