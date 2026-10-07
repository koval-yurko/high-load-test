# ecs-rds-postgres-pool

A Node.js service on ECS Fargate in front of an RDS PostgreSQL `db.t4g.micro`, built so that the
**application's connection pool** is the binding constraint, then released one knob at a time.

**The question it answers:** when a service's pool is the bottleneck, what does each of the three
standard fixes — a bigger pool, more tasks, an RDS Proxy — actually do to SLO attainment, and where
does the next bottleneck appear? Each knob is a separate apply and a separate row in `results.md`,
measured with the identical k6 profile. Nothing computes a verdict — every panel below is context for
one comparison: pool wait against database CPU.

Full design: `docs/superpowers/specs/2026-09-19-ecs-rds-postgres-pool-design.md`. Service plan:
`docs/superpowers/plans/2026-09-20-ecs-rds-postgres-pool-service.md`. Infrastructure plan:
`docs/superpowers/plans/2026-09-21-ecs-rds-postgres-pool-infrastructure.md`. Calibration and baseline
plan: `docs/superpowers/plans/2026-09-24-ecs-rds-postgres-pool-calibrate-baseline.md`.

**Nothing is deployed yet.** This README is written before the first apply, deliberately — the first
live session is meant to spend itself on measurement and `dev.tfvars` edits, not on reconstructing the
procedure from four plan documents. Every number below that looks like a figure is arithmetic (an
objective, a burn multiplier, a connection count) or a spec estimate labelled as such — nothing here
has been measured, because nothing has run.

## Where to look

| open | then |
|---|---|
| `https://k0valchuk.grafana.net/dashboards` | folder `high-load-test / ecs-rds-postgres-pool` → dashboard **ecs-rds-postgres-pool — attribution**. Rows 1, 3, 3b, 4, 5, 6, 7; references below name the row and panel. |
| `https://k0valchuk.grafana.net/alerting/list` | folder `high-load-test / ecs-rds-postgres-pool` → the burn-rate rules (generated), the SLI-absent rule (generated) and the five hand-written database-saturation rules — see [§6](#6-is-it-about-to-break) |
| `https://k0valchuk.grafana.net/a/grafana-slo-app/slos` | the SLO entry for this project's `latency-classes` and `availability` objectives — error budget and 7-day attainment. Exists once `infra/grafana/slo.tf` is generated and applied |
| `https://k0valchuk.grafana.net/a/k6-app/projects` | the project named **ecs-rds-postgres-pool** → its k6 tests and the runs since the last `/env up` (the project is destroyed with the environment, so it is absent between runs) |

---

## 1. Is the service up?

| check | where |
|---|---|
| Is the ECS task running? | [dashboard][dash] → row 4 *Service (ECS)* → **ECS LiveTaskCount** |
| Is the load balancer routing to it? | [dashboard][dash] → row 5 *Edge (ALB)* → **ALB HealthyHostCount** |
| Is traffic arriving, and answered? | [dashboard][dash] → row 5 → **ALB RequestCount**, **HTTP status codes (2XX / 4XX / 5XX)** |

**Good:** `HealthyHostCount` equals `desired_count` (1 at baseline, up to 4 at knob 2), almost all 2XX.
Stray 4XX are internet scanners — the ALB is public with no auth (decision D7).

**Bad:** `HealthyHostCount` at 0, or a run of 5XX — but check [§3](#3-what-is-the-bottleneck) first. A
saturated pool times out (`pool_connection_timeout_ms` firing `ConnectionTimeoutError`) and an
instance past its connection ceiling answers `FATAL: sorry, too many clients already`; both are 5xx
for a database-side reason, not a service bug.

## 2. Are we meeting the SLO?

[dashboard][dash] → row 6 *Service SLI* → **SLI ratio: proportion meeting per-class threshold**
(panel 19), and beside it **Server p99 per class vs its threshold** — each class's threshold from
`slo.yaml` as a dashed line. `npm run slo:check` exits non-zero if a threshold is ever `null`.

- A **5xx is a miss however fast it was**; a 4xx is not. This project has **no admission control** —
  there is deliberately no `SHED_ELU_THRESHOLD` (see the environment-variable contract below) — so no
  4xx here is ever a load-shedding response, and the two attainment columns in `results.md` (k6's and
  Grafana's) stay aligned under load. The sibling's admission-control divergence has no analogue here.
- The number is **server-side** — handler entry to response finish, excluding client↔ALB network
  time. It reads higher than k6's client-side view. Both are kept, as separate columns.
- **The continuous line is informational.** Between runs the only traffic is the heartbeat Lambda,
  one `POST /posts` and one `POST /reports` a minute. **Authoritative attainment is run-scoped.**

**Error budget:** the SLO app entry named in [Where to look](#where-to-look). Three objectives: latency
primary objective 95% (meets its class threshold), latency tail objective 99% (meets 3×), availability objective 99.9% (not 5xx).
Window fixed at 7 days — Grafana's SLO API accepts only 7–32 days and the free tier retains 14. The
floor under the primary objective, and why 95% rather than something lower, is in [How to move the
infrastructure for the SLO](#how-to-move-the-infrastructure-for-the-slo).

## 3. What is the bottleneck?

This is the project's whole point. Two things, read side by side, over the run's own time window:

| question | where | meaning |
|---|---|---|
| How long did requests wait for a pool connection? | [dashboard][dash] → row 3b *The pool* → **Pool wait p99 by class**, split by `pool_opened`, and the **waiting** / **idle** / **total** gauges | the pool's own queue, per class |
| Was the database itself the constraint? | [dashboard][dash] → row 1 → **DBLoad relative to vCPUs**; row 3 → **Connections vs the connection ceiling** | whether the instance had CPU and connection headroom left |

Four reading rules, in order of how often they get read backwards:

- **Pool wait high, database CPU low → the pool is the constraint.** That is the baseline's intended
  state, and what knob 1 (`pool_size = 25`) releases.
- **Pool wait high *and* the database at or above its vCPU count → both are saturated, and no request
  can be attributed to either one.** A comparison measured in that state is not a result — re-run at a
  lower rate or stop and report why.
- **A wait spike that coincides with `db_pool_total` (the "total" gauge, row 3b) rising is connection
  setup, not queueing.** TCP, TLS and Postgres authentication land in the same `db.pool.wait.duration`
  series as "queued behind four other requests"; only the gauge tells them apart.
- **`DBLoadRelativeToNumVCPUs` is not the headroom metric on this project.** The mechanism and the
  reason are in [§6's caveat](#6-is-it-about-to-break) — read that first. In short: **expect** it to
  read roughly `pool_size ÷ vCPUs` at the knee, well above what the database's CPU is actually doing,
  and read **`DBLoadCPU ÷ vCPUs`** instead for the real CPU share. `DBLoadCPU` is a real
  `AWS/RDS`/Performance-Insights CloudWatch metric, but it is not wired into this dashboard or into
  any alert (one rule per metric, and computing the ratio would need a math expression across two —
  see [§6](#6-is-it-about-to-break)); read it directly from the CloudWatch console, filtered to this
  instance, alongside the dashboard's `DBLoadRelativeToNumVCPUs` panel.

## 6. Is it about to break?

Every alert rule's `runbook_url` annotation points at this section — `service/scripts/generate-slo.js`
builds the link at generation time, and it was dead until this heading existed. Three sources, one
Grafana folder (`ecs-rds-postgres-pool`): the burn rules and the SLI-absent rule generated by `/slo`
into `infra/grafana/alerts.tf` and `infra/grafana/canary.tf`, and the five hand-written saturation
rules in `infra/grafana/saturation.tf`.

| rule | fires when | means |
|---|---|---|
| **Fast burn** × 3 objectives | budget burning at 14.4× over 14 min | gone in ~12 h — something just broke, hard |
| **Slow burn** × 3 objectives | 6× over 84 min | gone in ~1 day — bleeding steadily |
| **SLI absent** | no SLI sample for 10 min | the *measurement* stopped; nothing else here can be trusted |
| **Database CPU saturated** | `DBLoadRelativeToNumVCPUs > 1` for 2 min | more runnable/waiting sessions than vCPUs — read the caveat below before treating this as the CPU headroom number |
| **Connections near the ceiling** | `DatabaseConnections > max_connections_alert` for 2 min | the next connection gets `FATAL: sorry, too many clients already`, a 5xx that burns the availability budget |
| **Burst credits exhausted** | `CPUSurplusCreditBalance > 0` (5 min lookback) for 2 min | the instance is spending surplus CPU credit — it ran past its burst budget and the run is not comparable to one that did not |
| **Proxy borrow latency high** (knob 3 only) | `DatabaseConnectionsBorrowLatency > proxy_borrow_latency_threshold` for 2 min | requests are waiting on the proxy for a backend connection |
| **Proxy sessions pinned** (knob 3 only) | `DatabaseConnectionsCurrentlySessionPinned > 0` for 2 min | the proxy is a passthrough measuring nothing — the multiplexing knob 3 exists to test is not happening |

The three objectives are latency primary (95% meet their class threshold), latency tail (99% meet
3×), and availability (99.9% not 5xx). Each burn threshold is arithmetic on its objective —
`multiplier × (1 − objective)` — giving 72%/30%, 14.4%/6% and 1.44%/0.6% fast/slow respectively;
every generated rule's own `computation` annotation shows the working. **No latency figure appears
here or in any generated rule**: the class thresholds live in `slo.yaml` (fast 50 ms, standard 100 ms, heavy 1000 ms) and
are set by decision, not measured.

**Why SLI-absent exists:** every burn rule treats "no data" as OK — correctly, since no traffic is
not a burn — so a dead heartbeat, a stopped OTLP export, a stopped collector, or a Grafana Cloud
ingest problem leaves every burn rule silent and the dashboard flat, and both look healthy. This rule
is what separates *quiet* from *blind*.

**Why the saturation rules are separate from the burn rules:** the burn rules read the SLI, which is
service-side — they say something is slow or failing, not why. The saturation rules name the database
(and, once knob 3 is applied, the proxy in front of it) directly, so a red latency panel can be read
against the thing that is actually saturated rather than guessed at. Each is one rule per CloudWatch
metric, never a math expression across two, because CloudWatch publishes these sparsely — a quiet
minute is no datapoint, not a zero — and a combined rule would go NO DATA the moment either side is
empty, exactly during the incident it exists to catch. `no_data_state = "OK"` throughout, for the
same reason: no datapoint means no load, which is healthy.

**The credit rule watches the *surplus* balance, not the balance itself.** This instance runs in
RDS's unlimited credit mode (not configurable from Terraform — the attribute does not exist on
`aws_db_instance`), so an empty `CPUCreditBalance` does not throttle CPU; the instance starts spending
surplus credit instead, and `CPUSurplusCreditBalance > 0` is exactly that moment. A run that trips
this rule ran past its burst budget and is disqualified (spec §7.2) — its CPU is not the CPU of the
next run.

**The two proxy rules sit in NO DATA — read as OK — until `proxy_enabled = true`.** They are appended
to the rule group only while the proxy exists (`saturation.tf`'s `proxy_rules` local), so they alert
on nothing before knob 3 and disappear again once the proxy is destroyed.

**A caveat on "Database CPU saturated":** it alerts on `DBLoadRelativeToNumVCPUs`, which counts every
runnable session *and* every session actively waiting. A session inside `pg_sleep` — the heavy
route's timed hold — is `active` in `pg_stat_activity` with wait event `Timeout: PgSleep`, so
Performance Insights counts it too (decision D1); that part is documented behaviour, not a
measurement. What follows from it is an expectation, not yet a result: **expect** the metric to read
roughly `pool_size ÷ vCPUs` at the knee — well above what the database's CPU is actually doing — and
write it as an expectation until a run confirms it. Read `DBLoadCPU ÷ vCPUs` from CloudWatch alongside
it for the real CPU share; nothing here alerts on that ratio directly, because it is not a CloudWatch
metric — computing it would mean a math expression across two queries, which the one-rule-per-metric
rule above exists to avoid.

---

# Runbook

## What it provisions

All of it from `infra/main`, the root module of the HCP Terraform workspace `ecs-rds-postgres-pool`
(the workspace itself is created by `platform/`). Every resource carries `Project =
ecs-rds-postgres-pool` through the AWS provider's `default_tags`. AWS account `042945885621`, region
`eu-central-1` (`.env.example`'s `AWS_REGION`) — the same account and stack the sibling
(`ecs-dynamodb-rps`) uses; `aws_account_id` has no default in `variables.tf` on purpose, so a
workspace not attached to the shared `high-load-test` HCP variable set fails loudly instead of
skipping the precondition that checks it.

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

### Where everything lives

| what | where |
|---|---|
| **Service URL** | `terraform -chdir=infra/main output -json \| jq -r .base_url.value` — **deliberately not written here as a literal, and not in `.env` either.** This repo is public, the ALB is internet-facing with no auth, and a copied hostname is only ever the stale one after a rebuild. Terraform owns it |
| **Terraform Cloud** | https://app.terraform.io/app/failwin/workspaces/ecs-rds-postgres-pool — org `failwin`, project `high-load-test`, workspace `ecs-rds-postgres-pool` |
| **Grafana Cloud k6** | https://k0valchuk.grafana.net/a/k6-app/projects → **ecs-rds-postgres-pool**, in the `high-load-test / ecs-rds-postgres-pool` folder |
| **ECS service** | https://eu-central-1.console.aws.amazon.com/ecs/v2/clusters/ecs-rds-postgres-pool/services?region=eu-central-1 |
| **RDS instance** | https://eu-central-1.console.aws.amazon.com/rds/home?region=eu-central-1#database:id=ecs-rds-postgres-pool |
| **CloudWatch logs** | `/ecs/ecs-rds-postgres-pool` (app), `/ecs/ecs-rds-postgres-pool-collector` (Alloy collector), `/aws/rds/instance/ecs-rds-postgres-pool/postgresql` (database), `/aws/rds/proxy/ecs-rds-postgres-pool` (proxy, knob 3 only) — 1-day retention (`var.log_retention_days`, `ecs.tf`/`collector.tf`/`rds.tf`/`proxy.tf`) |

AWS account `042945885621`, region `eu-central-1`. The AWS and TFC links are built from fixed names,
so they resolve while the environment is applied and 404 after a teardown; the k6 projects page
simply lists no `ecs-rds-postgres-pool` project between runs.

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
(`infra/main/ecs.tf`). A misspelt name is not a Terraform error — the service silently falls back to
its default — so a change here is a change in both files.

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
| `REPORT_SCAN_ROWS` | number | 0 — the heavy route's CPU cost; 0 makes it return immediately (`dev.tfvars` sets 25000) | `report_scan_rows` |
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
`null` by default and knob 3 refuses to plan until it is set. The proxy costs roughly 40 percent of
the idle bill while it exists (see [Cost](#cost)): run it last and destroy promptly.

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
  it, and `service/test/generate-slo.test.js` cross-checks the two.
- **`seed_on_boot` is one task, one shot.** The seed is neither idempotent nor lock-guarded: two
  tasks booting with it set insert twice the rows, and a redeploy doubles them again. Prefer
  `./scripts/seed.sh` (below) — a one-off task that runs once regardless of
  `desired_count` and leaves no boot flag to remember to turn back off.
- **`report_scan_rows = 0` means the heavy route does no work.** `dev.tfvars` sets 25000 and
  `report_sleep_ms = 320`; both are chosen, not measured. If the baseline shows the pool is not what
  binds first (pool wait near zero while `DBLoadCPU` is high, or the reverse), edit the two lines,
  re-apply, and re-run the baseline.
- **`db_password` is not in any tfvars file on purpose.** It is `DB_PASSWORD` in the root `.env`
  (generate with `openssl rand -hex 24`); `.envrc` exports it as `TF_VAR_db_password` and
  `platform/` puts it in the shared HCP variable set, which is how remote runs receive it. After
  changing it, re-apply `platform/` (`terraform -chdir=platform apply`, from the repo root) before
  the next `/env up`. A validation requires 20–128 URL-safe characters.
- **`pool_connection_timeout_ms` is the heavy class threshold plus 100 ms** (plan decision D5):
  1100 for the 1000 ms heavy threshold. Change them together.
- **The class thresholds in `slo.yaml` are 50 / 100 / 1000 ms**.
  `npm run slo:check` exits non-zero if any is ever set back to `null`.

## The service, locally

From `service/`: `npm ci`, then **`npx prisma generate`** before the first `npm test` — the tests
import the generated client. `prisma.config.js` reads `DATABASE_URL` and the engine wants a
syntactically valid one even offline, so a placeholder suffices:

```bash
DATABASE_URL=postgresql://placeholder@localhost:5432/placeholder npx prisma generate
npm test
node --test test/<file>.test.js   # one file: a path, not a name
```

**There is no local Postgres and no integration suite, by design.** TLS and migrations are exercised
for the first time against the real AWS instance — there is nothing to run locally that resembles the
production connection path closely enough to be worth the machinery (unlike the sibling, which has a
full DynamoDB Local loop).

## Phase 0 — Setup (already done once)

Everything from here needs a real AWS account and costs money.

```bash
cp .env.example .env              # AWS, Terraform Cloud, Grafana, k6 tokens
direnv allow                      # from the repo root, and again after every .env edit
terraform -chdir=platform apply   # the shared stack, once, from the repo root
cd ecs-rds-postgres-pool
(cd service && npm ci)            # all Node tooling lives in service/
terraform -chdir=infra/main init
```

Provision, deploy the service into it, then seed once:

```bash
terraform -chdir=infra/main apply -var-file=dev.tfvars   # approval gate
./scripts/deploy-service.sh                              # build amd64 → push → force new deployment → health
./scripts/seed.sh              # ONCE; not idempotent
```

Re-run `./scripts/deploy-service.sh` after **every** change under `service/src/` — Terraform does not
rebuild the image, and skipping it fails silently (the service stays healthy on old code).
`--skip-build` only rolls the service. The seed runs inside the VPC on a throwaway Fargate task built
from the service's own task definition; nothing truncates `posts` first, so a second run doubles it.
No script runs `terraform apply` or `destroy`: the `permissions.ask` rule matches command text, so an
apply buried in a script would never reach the approval gate. Tool shells need
`direnv exec <repo-root> <command>`; direnv itself is interactive-only.

When setup breaks, it is almost always one of these:

| symptom | cause |
|---|---|
| `"organization" must be set … TF_CLOUD_ORGANIZATION` | direnv did not load — `direnv allow` at the repo root |
| plan fails on `data.grafana_folder.root` | `terraform -chdir=platform apply` was skipped; it creates the workspace, variable set and the `high-load-test` Grafana folder |
| `Error creating workspace … Name has already been taken` | the workspace was created by an earlier `init`; `terraform -chdir=platform import 'tfe_workspace.project["ecs-rds-postgres-pool"]' <org>/ecs-rds-postgres-pool`, then apply |
| `upload-k6.sh`: "infra/main has no k6_project_id output" | the environment is not applied, so its k6 project does not exist — apply first |
| workspace lands in the org's *default* project | `.env` is missing `TF_CLOUD_PROJECT=high-load-test` |
| `Error: No configuration files` | bare `terraform apply` at the project root — use `-chdir=infra/main` |
| `CannotPullContainerError` at task start | an arm64 image; the script builds `--platform linux/amd64` for a reason |
| healthy service, still the old code | the image was not rebuilt — run `deploy-service.sh` |

## Phase 1 — Is it alive?

```bash
BASE=$(terraform -chdir=infra/main output -raw base_url)
curl -fsS "$BASE/healthz"                       # {"ok":true}
terraform -chdir=infra/main output -raw psql    # a psql command; then: SELECT count(*) FROM posts;
```

## Phase 2 — Run a load test

Three shapes, in this order — B and C need the number A produces:

| shape | file | what it's for |
|---|---|---|
| **A — discovery** | `infra/k6/tests/discovery.js` | ramps the request rate in fixed steps, one threshold per step. **The knee is the lowest step whose threshold breached.** |
| **B — constant** | `infra/k6/tests/constant.js` | holds at the discovered rate. The repeatable baseline for before/after comparison. |
| **C — stress** | `infra/k6/tests/stress.js` | above the knee. Deliberately breaches the SLO — the only way the saturation and burn-rate alerts get tested. |

The class thresholds the runs are judged against are in `slo.yaml` (fast 50 ms, standard 100 ms,
heavy 1000 ms) and drawn on the dashboard: row 6 → **Server p99 per class vs its threshold**. After
editing them: `(cd service && npm run slo:generate && npm run slo:check)`, then apply `infra/main`.
**Changing a threshold invalidates every earlier result.**

**1. Upload the profiles.** A UI run executes the **archive stored in the cloud**, never the file on
disk, and nothing warns you when it is stale:

```bash
./scripts/upload-k6.sh --check          # what is up there, and is any of it stale?
./scripts/upload-k6.sh                  # discovery only — the knee is not known yet
./scripts/upload-k6.sh --rate <knee>    # all three, constant/stress pinned to the measured knee
```

It takes `BASE_URL` from `terraform output` and bakes it and `RATE` into the archive. Without
`--rate`, `constant` and `stress` are not uploaded: archived at the placeholder rate and tagged
`rate_source=default`, they would not be a capacity measurement.

**2. Check the run gate before every run.** This instance runs in unlimited burst-credit mode: record
`CPUCreditBalance` and `CPUSurplusCreditBalance` first — a run does not start until the balance is
full, and a run that makes `CPUSurplusCreditBalance > 0` is disqualified and re-run. Also record
`SELECT count(*) FROM posts` (the `posts rows` column in `results.md`).

**3. Start the run** from the [k6 projects page][k6] → **ecs-rds-postgres-pool**. When discovery
finishes, open its thresholds: each step has one named `slo_met{scenario:rps_N}`, and **k6 reports a
threshold as breached, not passed — the boolean is `true` when it was crossed.** The knee is the
lowest step that breached; `RATE` for B and C is the step before it.

**From a terminal instead** — no upload needed, `-e` wins over everything:

```bash
BASE_URL=$(terraform -chdir=infra/main output -json | jq -r '.base_url.value // empty')
k6 cloud run -e BASE_URL="$BASE_URL" -e RATE=<knee> infra/k6/tests/constant.js
echo "exit=$?"                     # 0 = the gates held, 99 = one breached
```

Capture that exit code on the k6 line itself — behind a pipe you get the pipe's status. Four
thresholds decide it: `slo_met` (95% meet their class threshold), `slo_met_tail` (99% meet 3×),
`http_req_failed` (< 0.1%), and `dropped_iterations` (zero — a run that ran out of VUs delivered less
than `RATE`). For `constant` at the knee expect exit `0`; for `stress` expect `99` with `slo_met`
breached — proof the SLO can fail.

## Phase 3 — Read the result

Set the dashboard time range to the run's window.

| question | where |
|---|---|
| What rate did we reach, client-side? | [k6][k6] → **ecs-rds-postgres-pool** → the run |
| Did the SLO hold, server-side? | [dashboard][dash] → row 6 → **SLI ratio**, and **Server p99 per class vs its threshold** |
| **Was the pool queueing?** | [dashboard][dash] → row 3b → **Pool wait p99 by class** — read this first |
| Was the database the constraint? | [dashboard][dash] → row 1 → **DBLoad relative to vCPUs** (above 1.0 = yes) |
| How close to the connection ceiling? | [dashboard][dash] → row 3 → **Connections vs the connection ceiling** |
| Did the burn-rate alerts fire? | [alert rules][alerts] |
| How much budget did it cost? | [SLO app][slo] |

Two attainment columns, never one number in both: **k6 attainment** (the run's own `slo_met`;
client-side, includes the client↔ALB round trip) and **service attainment** (the Grafana SLI over the
run's window; handler entry to response finish only). Compute `budget burn ×` from the service figure:
observed miss rate ÷ the sustainable miss rate for that objective. If the pool queued **and** the
database was saturated, the run measured neither and should not be recorded as a result.

## Phase 4 — Improve: release the pool (knob 1)

**One change per run, from the same commit.** Baseline is `pool_size = 5`, `desired_count = 1`,
`proxy_enabled = false`. Set `pool_size = 25` in `infra/main/dev.tfvars` and apply — **approval
gate.** The bottleneck should move from pool wait toward database CPU.

## Phase 5 — Re-measure identically

Check the run gate (credits full), re-run **B and C unchanged** — same `RATE`, same scripts, same
thresholds — and re-read Phase 3.

## Phase 6 — Improve: more tasks, then the proxy (knobs 2 and 3)

Only one per run. **Knob 2:** `desired_count = 4` (25 × 4 = 100 connections against an estimated
~112 ceiling) — first run `SHOW max_connections` and re-derive `max_connections_alert`, as in
[The knob sequence](#the-knob-sequence). **Knob 3:** `proxy_enabled = true`, last, after setting
`proxy_borrow_latency_threshold`; destroy it promptly (~40% of the idle bill). Each is an apply —
**approval gate.** The class thresholds are a last resort and only when the number was wrong to begin
with: changing one to make a run pass is moving the goalposts.

## Phase 7 — Re-measure again

Check the run gate, re-run B and C, read Phase 3. Record the new ceiling and the new $/hour.

## Phase 8 — Record the results

Append one row per run to `results.md` (`/loadtest` does this, including for UI-started runs). Every
figure needs the run that produced it — the k6 summary JSON or the Grafana query. Record: what
distinguished this run (the single infra change), rate achieved, both attainment columns, p95/p99 per
class, error rate, error budget burned, whether alerts fired, pool wait p99 and the waiting-gauge
peak, `DBLoadCPU ÷ vCPUs` and `DBLoadRelativeToNumVCPUs`, `DatabaseConnections`, the credit balance,
**`SELECT count(*) FROM posts` taken just before the run**, and the `$/hr` at the time (an estimate
until `pricing.json` exists — see [Cost](#cost)). A result is never "N RPS": it is "N RPS at the
55/15/25/5 mix".

## Phase 9 — Tear down

```bash
terraform -chdir=infra/main destroy -var-file=dev.tfvars     # approval gate; an RDS instance takes minutes

aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=Project,Values=ecs-rds-postgres-pool \
  --query 'ResourceTagMappingList[].ResourceARN' --output table
```

Then the billable-resource sweep the `/env` skill runs, and a manual check by name for anything it
might miss: the RDS **final snapshot** (`skip_final_snapshot = true` should prevent it), automated
backups, the `/aws/rds/instance/ecs-rds-postgres-pool/postgresql` and `/ecs/ecs-rds-postgres-pool` log
groups (and `/aws/rds/proxy/ecs-rds-postgres-pool` if knob 3 ran), the DB subnet and parameter groups,
any EIP, and the Grafana Cloud k6 project.

---

## How to move the infrastructure for the SLO

Two distinct moves. Confusing them is the most expensive mistake available here.

### Changing the infrastructure

One `dev.tfvars` line, one apply, then the **identical** k6 profiles re-run — same `RATE`, same
scripts, same shapes. Never change the profile itself to chase a passing run, or the comparison is
worthless.

| knob | `dev.tfvars` line | connections (`pool_size × desired_count`) | precondition |
|---|---|---|---|
| 1 — release the pool | `pool_size = 25` | 25 × 1 = 25 | none |
| 2 — add tasks | `desired_count = 4` | 25 × 4 = 100, against the instance's real ceiling | `SHOW max_connections` on the instance, then re-derive `max_connections_alert` — see [The knob sequence](#the-knob-sequence) |
| 3 — proxy | `proxy_enabled = true` | multiplexed | confirm `DatabaseConnectionsBorrowLatency`'s unit in the CloudWatch console on the real proxy, then set `proxy_borrow_latency_threshold` — the Terraform module refuses to plan knob 3 without it |

Both preconditions are **not optional**: skipping the first means `max_connections_alert` fires on a
guessed ceiling; skipping the second risks a silent 1000× unit error that looks like a spectacular
result. Full arithmetic and reasoning are in [The knob sequence](#the-knob-sequence) — this table is
the pointer for the moment a run's SLO fails and you're deciding which line to change.

### Changing the SLO itself

`slo.yaml` is the **only** source. Regenerating (`npm run slo:generate`) rewrites
`infra/grafana/locals.tf`, `infra/grafana/alerts.tf`, `infra/k6/tests/lib/slo.js`,
`infra/grafana/classmap.json` and `infra/grafana/queries.json` — the Grafana rules and the k6
thresholds move **together**, from the one file. A hand-edit of any generated file, or of the k6
thresholds without touching `slo.yaml`, is drift the next `slo:generate` will silently overwrite or
disagree with. An objective change needs an `infra/main` apply (approval gate) to actually reach
Grafana; regenerating alone only changes files on disk.

**The floor under the primary objective is 93.06%.** At the 14.4× fast-burn multiplier, the rule's
threshold is `14.4 × (1 − objective)`, and a miss rate cannot exceed 100%: `14.4 × (1 − objective) ≤
100%` requires `objective ≥ 93.06%`. Below that floor the fast-burn rule would need an impossible miss
rate and could never fire — `service/test/generate-slo.test.js` enforces this, the same test the
sibling project carries.

**Which knob to reach for when a class misses its threshold:** the pool first (knob 1 — this
project's whole premise is that the pool binds before the database does), then task count (knob 2),
then the proxy (knob 3). The class threshold itself is a last resort, and only when the number
was wrong to begin with (a different instance class, a re-think) — **changing a threshold to make a run pass
is moving the goalposts**, and it needs a recorded reason in the commit, not a silent edit.

---

## Cost

**Estimates, not measured.** The repository's rule is that a published price comes from a query with
the query recorded — this project owns its own `pricing.json`, not yet created, and these figures are
replaced by queried ones before any are published (spec §7.6).

| item | estimate |
|---|---|
| idle baseline (ALB + Fargate tasks), measured by the sibling project | $0.055/hr |
| `db.t4g.micro`, single-AZ | ~$0.018/hr |
| 20 GiB gp3 | ~$0.003/hr |
| Performance Insights, 7-day retention | free |
| **idle, no proxy** | **~$0.076/hr**, roughly $55/month |
| RDS Proxy (per vCPU-hour, floor of 2 vCPU for T-class) | ~$0.030/hr |
| **idle, with proxy** | **~$0.106/hr**, roughly $77/month |
| knob 2 and 3 runs, at four tasks rather than one | higher for the duration of those runs only |

**The proxy is the line to check first** — roughly 40 percent of the idle bill for a component whose
measured benefit may be zero (the pre-registered expectation in the spec is that four long-lived
tasks holding warm pools barely need it). That is an argument for running knob 3 last and destroying
it immediately, not for skipping it. **The forgotten environment, not the load test, is the real cost
risk** — an idle instance left running over a weekend outweighs any single measured run.

## Known gaps

- **Terraform does not rebuild the container image.** Any change under `service/src/` needs
  `./scripts/deploy-service.sh`. Fails silently — the service looks healthy while running old code.
- **Uploading the k6 profiles is manual, silent when skipped, and needed after every `/env up`.**
  `grafana_k6_load_test` takes a single script string and these import from `tests/lib/`, so there is
  no Terraform resource for it. The k6 project itself is destroyed and recreated with the
  environment, so a fresh environment always starts with an empty project.
- **The k6 environment-variables settings page cannot be automated** — no public API path, no
  Terraform resource. `upload-k6.sh` works around it by baking the values into the archive; the
  settings page can only ever contradict what was last uploaded, never override it.
- **The SLO window is fixed at 7 days** — Grafana's SLO API refuses windows outside 7–32 days and the
  free tier retains 14.
- **There is no local Postgres, so TLS and migrations fail first in AWS.** Unlike the sibling's full
  DynamoDB Local loop, this project's integration path is exercised for the first time against the
  real instance.
- **`results.md` is empty until the first run** — this README describes the procedure that produces
  the first row, not a result.

## Measured results

No runs yet — this plan produces the first numbers.

[dash]: https://k0valchuk.grafana.net/dashboards
[alerts]: https://k0valchuk.grafana.net/alerting/list
[slo]: https://k0valchuk.grafana.net/a/grafana-slo-app/slos
[k6]: https://k0valchuk.grafana.net/a/k6-app/projects
