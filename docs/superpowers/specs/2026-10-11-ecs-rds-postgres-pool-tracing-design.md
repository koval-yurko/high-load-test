# ecs-rds-postgres-pool — request tracing (phase 1: auto-instrumentation)

Status: complete (phase 1). Implemented by `docs/superpowers/plans/2026-10-11-ecs-rds-postgres-pool-tracing.md`; one success criterion deliberately unmet — see "Success criteria".
Project: `ecs-rds-postgres-pool` (this spec covers that one directory only)
Amends: nothing. Phase 2 (manual inner spans: Prisma operation, read body, handler, summarize, send, event-loop delay) is not yet written; it gets its own spec, which will name this one as the thing it extends.

## Why

Discovery run 8787587 (2026-10-11) broke between 100 and 200 offered rps: average latency went from
~58 ms to 0.8–1.2 s, p95 ~9 s, with no failed requests, no service CPU pressure (ECS CPU max 34% of
0.5 vCPU) and a flat 50 connections. The cause had to be inferred from Performance Insights
(`IO:BufFileRead`/`IO:BufFileWrite` dominating `db.load.avg`), not observed on the slow requests
themselves. The service emits metrics only, and a metric cannot say *which* request was slow or *which
SQL statement* it was waiting on.

**Outcome wanted:** pick a slow request from a load run, open its trace, and see the route, how long it
waited for a pool connection, and the exact SQL it ran with that statement's duration.

## Decisions already taken (with the user, this session)

| decision | chosen | rejected, and why |
|---|---|---|
| Trace sink | **Grafana Cloud Tempo**, through the existing service → Alloy gateway → Grafana Cloud OTLP path | AWS X-Ray: Alloy has no X-Ray exporter, so it needs an extra ADOT collector or SigV4 signing plus task-role IAM, and traces would sit apart from the SLO dashboards |
| Instrumentation | **OpenTelemetry auto-instrumentation** (`instrumentation-http`, `instrumentation-pg`) loaded by `--import` | Manual spans first: deferred to phase 2 on purpose, so the user can see what the libraries give for free before writing any span code |
| Sampling | **100%**, with the ratio a configurable knob (`TRACE_SAMPLE_RATIO`) | Fixed low ratio / tail sampling: not now; the knob leaves room for both |

## What auto-instrumentation provides (verified)

Spiked on 2026-10-11 in a scratch directory, not in the project: a minimal ESM app (built-in
`node:http` + a `pg` Pool, Node 24.12) against a local `postgres:16`, loaded with
`node --import ./tracing.mjs`. Spans that appeared, with parentage correct:

| span | meaning | notes |
|---|---|---|
| `GET` (SERVER) | the whole request | name carries **no route template**; `url.path` holds the raw path |
| `pg-pool.connect` | wait for a pool connection | this is the pool queue, per request |
| `pg.connect` | a *new* connection being opened | appears only when the pool had to open one (TCP + TLS + auth) |
| `pg.query:SELECT postgres` | one SQL statement | `db.query.text` (older instrumentation versions: `db.query.text`) = the text **with `$1` placeholders, no values**; verified 2026-10-12 against Tempo that the deployed 0.75.0 emits `db.query.text` |

Without the preload the same app produces no spans. The control confirms the preload is what does it.

**What it does not give**, and why phase 2 exists: no span for Prisma's in-process work (query
compilation and result mapping sit as uncovered gaps between `pg-pool.connect` and `pg.query`), none for
reading the request body, the handler, the `/feeds` summarize CPU step or response serialization, and no
`http.route` / latency `class` on the server span.

## Design

### 1. Preload module — `service/src/tracing.js`

Must run **before** `server.js` imports `node:http` and `pg`, so it cannot live inside `startTelemetry`
(called from `main()`, after those imports). It is loaded with `node --import ./src/tracing.js
src/server.js`.

- Registers `import-in-the-middle/hook.mjs` via `node:module` `register()` (the ESM loader hook the
  http and pg instrumentations need in an ESM service).
- Builds a `NodeTracerProvider` with a `BatchSpanProcessor` and `@opentelemetry/exporter-trace-otlp-http`
  posting to `${OTLP_ENDPOINT}/v1/traces`, the same collector the metrics use.
- Sampler: `ParentBased(TraceIdRatioBased(TRACE_SAMPLE_RATIO))`; ratio defaults to `1`.
- **No-op when `OTLP_ENDPOINT` is unset**, so `npm test` and a local run need no collector, matching how
  `otel.js` already behaves.
- Same resource as the metrics (`service.name`, ECS detector → `service.instance.id`), so a trace and
  its metric series join on the same labels.
- Instrumentations: `HttpInstrumentation` and `PgInstrumentation`, configured to cut noise:
  - ignore incoming `/healthz` (ALB health checks);
  - ignore all outgoing http (the OTLP exporter and the CloudWatch publisher would otherwise appear as
    client spans every few seconds);
  - a `requestHook` on the server span that sets `http.route` from `matchRoute` and `class` from
    `ROUTE_CLASS` — the one small addition that makes TraceQL filterable by class. `matchRoute` and
    `ROUTE_CLASS` are the single source of truth already in `handlers.js`; this imports them, it does
    not copy them.
  - `enhancedDatabaseReporting` stays **off**: it would put parameter values (1 KB `body` strings) on
    every span.

### 2. Image — `service/Dockerfile`

`CMD ["node", "--import", "./src/tracing.js", "src/server.js"]`. The one-off seed task runs the same
image and will emit traces too; that is acceptable noise, since its statements are exactly what a
reader of the table-growth confound wants to see.

### 3. Knob — `infra/main`

- `variables.tf`: `trace_sample_ratio` (number, default `1`, validated to `0 ≤ x ≤ 1`).
- `dev.tfvars`: `trace_sample_ratio = 1`.
- `ecs.tf`: `TRACE_SAMPLE_RATIO` in the app container environment.
- `outputs.tf`: added to the `knobs` output so `/loadtest` records it on every `results.md` row.
  **Tracing runs inside the 0.5 vCPU task under test**, so it is part of the configuration being
  measured and must be held constant across runs being compared.
- README environment-variable contract table gains the row (a misspelt name silently falls back to the
  default — the same trap the README already warns about).

### 4. Collector — `infra/grafana/alloy.alloy.tftpl`

Add traces to the receiver's `output`, route them through the existing `otelcol.processor.batch`, and
give that processor's `output` a `traces` target (the existing `otlphttp` exporter already carries all
signals). The class-mapping `transform` stays metrics-only. Header comment updated: the file is no
longer "service metrics" only.

### 5. Credentials — a manual step for the user

The Grafana Cloud access-policy token behind `GRAFANA_OTLP_PASSWORD` is scoped `metrics:write`
(`.env.example`; `variables.tf` description). Tempo ingest needs **`traces:write`** added. No code can
do this; the plan has an explicit "user adds scope, then `platform/` re-applied" step, and
`.env.example` and the variable description are updated to say so.

### 6. Reading traces — documentation, no new Grafana code

Grafana Cloud's stack already has the Tempo datasource, so Explore + TraceQL works with no Terraform.
The README gains a short "Reading a trace" section with copy-pasteable queries, e.g. slow requests
`{ resource.service.name = "ecs-rds-postgres-pool" && duration > 1s }`, and by class once the hook is in.
A dashboard panel is deliberately out of scope for phase 1.

## Out of scope for phase 1

Manual inner spans (Prisma operation, read body, handler, summarize, send), event-loop-delay attribute,
exemplar links from the latency histograms to traces, tail sampling, any dashboard panel, the X-Ray
sink. Phase 2 is the manual-span set agreed in the design discussion; it gets its own spec, which will
name this one as the thing it extends.

## Risks and open verification items

1. **Prisma path is not yet verified.** The spike used `pg` directly. `@prisma/adapter-pg` 7.10.0 was
   read and calls `pool.connect()` then `client.query({text, values})` on that connection, so
   `pg.query` spans should appear for `$queryRaw`, including for transaction statements, but the first
   plan task must prove it against a local Postgres before anything is deployed.
2. **Node 22 image not yet exercised.** The spike ran on Node 24.12; the Dockerfile is Node 22. The
   same preload must be run in the built image before relying on it.
3. **Overhead.** 100% sampling plus the loader hook on 0.5 vCPU is untested. Acceptance requires one
   same-rate comparison of the service with tracing at ratio `0` vs `1` (latency and ECS CPU), recorded
   in `results.md`, so the cost of the instrument is a number and not an assumption.
4. **Grafana Cloud trace quota** at 100% sampling is unknown; the first load run should be watched for
   ingest limits and the ratio lowered with the knob, not by editing code.
5. **Loader-hook cost.** `import-in-the-middle` adds start-up time and memory. `deploy-service.sh`'s
   health wait and the `wait_for_steady_state` setting already in `ecs.tf` should absorb it; confirm.

## Success criteria

- A trace for a slow `/reports` request in Tempo shows `pg-pool.connect` and a `pg.query` whose
  `db.query.text` is the report CTE, with its duration.
- The same for `/feeds/:id/posts` and `/posts/:id`.
- `npm test` passes with no collector configured; `terraform fmt -check`, `validate` and a reviewed
  `plan` are clean.
- Tracing overhead at a fixed rate is recorded (risk 3). **Not met:** descoped by the user on 2026-10-12 (plan Task 10 not run). Until it is, the cost of `trace_sample_ratio = 1` on the 0.5 vCPU task is unmeasured.

## Execution constraints (from the repo's rules)

`terraform apply` is its own plan task and stops for approval. `deploy-service.sh` is required after the
`service/` change because Terraform does not rebuild the image. The change is a `feat` commit with scope
`ecs-rds-postgres-pool` (the tracing code) plus `ecs-rds-postgres-pool/terraform` for the knob.
