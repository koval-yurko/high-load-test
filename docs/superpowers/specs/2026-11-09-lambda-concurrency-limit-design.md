# lambda-concurrency-limit — Lambda concurrency as the binding constraint

- **Date:** 2026-11-09
- **Status:** **complete** (2026-11-14, marked done by the user; provisioned concurrency and reserved
  concurrency 100 were not run — see `lambda-concurrency-limit/results.md`). Earlier status:
  **approved** (2026-11-09, by the user, after reviewing the written spec). Every design
  section was approved in the terminal on 2026-11-08 and 2026-11-09. Plans 1–3 are written as the
  work reaches them. Corrected during plan 2 (2026-11-09): region, load zone, VU cap, alias
  versions, Grafana SLO rows — see the marked paragraphs.
- **Project directory:** `lambda-concurrency-limit/` (new; nothing is deployed and nothing carries the
  `Project = lambda-concurrency-limit` tag yet)
- **Builds on:** `docs/research/lambda-concurrency-limit.md` (2026-11-08). That document holds the
  verified AWS facts with their sources; this spec repeats each fact it depends on, so it can be read
  alone. **Amends** the research document in two places, with forward-pointers written there:
  its C6 ("a Lambda has nowhere to run a collector cheaply", so no OTel) — OTel is in, as a Lambda
  extension (§7); and its first "short answer" (Function URL as the front door) — the front door is
  an API Gateway REST API (§3).

---

## 1. What this project measures, and what would make it a failure

A Node.js Lambda behind an API Gateway REST API, reading DynamoDB, sized so that **the function's
reserved concurrency — a counter AWS enforces — is what runs out first.** Then three knobs are
released one at a time, each against an identical load profile:

1. a **per-user rate limit** (API Gateway usage plans), which stops one noisy user from taking the
   whole concurrency;
2. **reserved concurrency 20 → 100**, which raises the ceiling;
3. **provisioned concurrency**, which removes cold starts from a traffic spike.

Every capacity number is **computed** from measured latency and the SLO (§5), and each run records
the prediction next to the measurement. A gap between them is a finding.

**The deliverable is the before/after table in `results.md` and the README**, one pair of rows per
knob. A project that provisions cleanly and records no comparison is unfinished.

**Every knob and every exploration setting exists from the first build and is switched only by
configuration** (§10). Changing a knob is a one-line `dev.tfvars` edit and an apply — no code
change, no rebuild, no redeploy. If the measurement plan needs a code change, the build plans missed
something.

## 2. Decisions

All answered by the user on 2026-11-08 and 2026-11-09.

| # | question | answer |
|---|---|---|
| 1 | Front door | **API Gateway REST API** — per-client throttling exists only on REST APIs |
| 2 | Per-user rate limit | **Yes, as knob 1**: one API key and one usage plan per test user. **Amended 2026-11-10** (draft): two keyed usage plans plus a keyless WAF tier, see `2026-11-10-lambda-concurrency-limit-tiered-rate-limits-design.md` |
| 3 | Database | **DynamoDB**, on-demand for every comparison; capacity is configurable for exploration |
| 4 | Knobs and order | per-user limit (at reserved concurrency 20), then reserved concurrency 20 → 100, then provisioned concurrency |
| 5 | SLI | **k6 only**; CloudWatch and traces are evidence, not a second attainment |
| 6 | Is a per-user 429 a miss? | **No** — the limit working; the SLO is judged over the normal users. **Amended 2026-11-10** (draft): the rule covers every tier and a rate-limit 429 carries the header `x-throttle`, see `2026-11-10-lambda-concurrency-limit-tiered-rate-limits-design.md` |
| 7 | Queue for writes (SQS) | **No** |
| 8 | Step Functions as a "wait for a free Lambda" layer | **No** |
| 9 | Arrival process | **Random (Poisson) arrivals**, so measurements match Erlang B |
| 10 | SLO objectives | **95% latency, 99% availability** — the same as the sibling projects |
| 11 | Noisy-neighbour shape | **4 normal users + 1 noisy user** |
| 12 | How knob 3 is judged | **p99 and maximum latency in the first 30 s of the spike**; attainment reported too |
| 13 | Who owns the code | **A script** publishes versions and moves the alias; Terraform owns only the infrastructure |
| 14 | Tracing | **Upstream OpenTelemetry Lambda layers → Grafana Cloud Tempo**, plus a CloudWatch widget for the export time |
| 15 | Workload | **GET only**, over seeded data, so table size and response time stay fixed |

Rejected, with the reason recorded so it is not re-proposed:

- **API Gateway cannot wait for a free Lambda.** Its throttle is a token bucket, and its integration
  timeout limits how long a *running* function may take. When Lambda refuses an invocation, API
  Gateway returns 500 at once and "does not retry any Lambda invocations". Its SQS integration only
  sends; it cannot wait for a reply message.
- **Function URL** returns a clean 429 on a throttle and costs nothing extra, but has no per-user
  throttling.
- **An HTTP API** is cheaper ($1.00 against $3.50 per million) but has no API keys or per-client
  throttling.

## 3. Architecture

```
k6 (Grafana Cloud, random arrivals, one API key per test user)
  → API Gateway REST API (regional, stage dev, API key required, usage plans)
  → Lambda proxy integration on alias `live`
      Node.js 22, arm64; OTel Node layer + OTel collector extension layer
  → DynamoDB table (pk, sk)
OTel collector extension → OTLP/HTTP → Grafana Cloud (Tempo)
CloudWatch metrics → Grafana (dashboard, SLO, alerts) and one CloudWatch dashboard
```

No VPC, no NAT gateway, no ECR, no `heartbeat/`. The function reaches DynamoDB over its public
endpoint. (A VPC would also slow `destroy`: AWS needs up to 20 minutes to delete a Lambda's
Hyperplane ENI.) There is no heartbeat because there is no service-side SLO to keep alive at idle.

### 3.1 The shared account — a hard constraint

The AWS account (region `eu-central-1`) is shared with apps outside this repo. Read on 2026-11-08:
`ConcurrentExecutions` (the account limit) = **400**, `UnreservedConcurrentExecutions` = **352**.
Seven other functions reserve 48; two (`LocalsScrapperDevStack-UserFetch-dev`,
`GraphAppBffStack-ServerApp`) run from the unreserved pool.

A function without reserved concurrency draws from that pool, and a load test that empties it
throttles those apps. Therefore:

- **The function always has reserved concurrency**, from the first apply.
- AWS keeps at least 100 units unreserved, so the function can reserve at most 352 − 100 = **252**.
  `reserved_concurrency` is validated to 1–252 in Terraform.
- An alert fires if the account's unreserved concurrency in use passes 50% of 352 (§8).
- Before the first apply, re-read `aws lambda get-account-settings`: if other apps have reserved more
  since 2026-11-08, the 252 ceiling is lower.

**Corrected 2026-11-09, during plan 2:** the region is `eu-central-1`, not `us-east-1`. The root `.env` sets
`AWS_REGION=eu-central-1` for every project here, and the 400 / 352 reading was made there. `us-east-1`
has an account limit of **10** (read 2026-11-09). The reading was re-checked on 2026-11-09 in
`eu-central-1`: still 400 and 352, so the 252 ceiling stands.

### 3.2 What Terraform owns (`infra/main`)

- **Lambda function**, Node.js 22, arm64, created with a placeholder zip. `lifecycle.ignore_changes`
  covers `filename` and `source_code_hash`, so script deploys do not show as drift. The function keeps
  `publish = true`: a configuration change publishes a new version, and `deploy-service.sh --config-only`
  moves the alias to it.

  **Corrected 2026-11-09, during plan 2:** the spec said `publish` was ignored and `deploy-service.sh` was needed only for code.
  The alias points to a published version, and a version freezes its environment variables, memory and
  layers, so a `dev.tfvars` change never reached the alias by itself.
- **Alias `live`**: created by Terraform, `lifecycle.ignore_changes = [function_version]`.
- **Reserved concurrency** = `var.reserved_concurrency`.
- **Provisioned concurrency** on `live` = `var.provisioned_concurrency`; `count = 0` when it is 0.
  Provisioned ≤ reserved, validated.
- **Log group** `/aws/lambda/<name>` with retention, declared before the function so that Lambda
  does not create it outside Terraform.
- **Log metric filter** counting `REPORT` lines that contain `Init Duration` — the only place a cold
  start appears; there is no Init-duration metric.
- **IAM role**: `dynamodb:GetItem` and `dynamodb:Query` on the table, plus logs.
- **DynamoDB table** with the capacity variables (§10), `deletion_protection_enabled = false`.
- **API Gateway REST API**: three GET resources, Lambda proxy integrations on `live`, stage `dev`,
  API keys required. **Six API keys**: `normal-1` … `normal-4`, `noisy`, `load`. The five user keys
  share one usage plan whose throttle is `var.user_rate_limit_rps` (burst = 2 ×; no throttle when 0).
  The `load` key has its own usage plan with no throttle.
- **CloudWatch dashboard** (§8.2).
- Modules `../grafana` and `../k6`, as in the sibling projects.
- Function environment variables, all from Terraform variables: `TABLE_NAME`,
  `HEAVY_CPU_ITERATIONS`, `AWS_MAX_ATTEMPTS`, and the OTel settings (§7).

### 3.3 What the scripts own (`scripts/`)

- **`deploy-service.sh`** — the code and its versions: `npm ci --omit=dev` → `npm test` → zip →
  `aws lambda update-function-code --publish` → wait for `LastUpdateStatus = Successful` →
  `aws lambda update-alias --name live --function-version <new>` → when provisioned concurrency is
  on, wait until its status is `READY` (allocation takes 1–2 minutes, and none of it is usable until
  all of it is allocated). Prints the version. It never runs `terraform apply`.
- **`upload-k6.sh`** — builds and uploads the k6 profiles, passing the seed manifest values and the
  rates as environment variables, as in the sibling projects.

**Corrected 2026-11-09, during plan 2:** `deploy-service.sh` has two more modes. `--config-only` moves the alias to the newest
published version (no build, no upload), for a configuration change applied by Terraform. `--check`
compares the settings of the version that alias `live` runs (memory, environment variables, layers)
with `$LATEST` and reports any difference, with `--config-only` as the fix. Both are script runs, not
code changes.

These two `aws lambda` calls are operational, like the ECS projects' `update-service`: they create no
lasting resource that Terraform does not own (published versions are deleted with the function).

## 4. Workload, data and seed

### 4.1 Routes (all GET)

| class | route | work | share |
|---|---|---|---|
| fast | `GET /items/{pk}/{sk}` | `GetItem` | 70% |
| standard | `GET /feeds/{pk}` | `Query` of one feed partition | 25% |
| heavy | `GET /reports/{pk}` | `Query` of one report partition, then a CPU loop of `HEAVY_CPU_ITERATIONS` | 5% |

- Only GET, so nothing in the load writes: the table size and the response time stay what the seed
  made. A run is comparable only to runs on the same seed.
- The CPU loop counts **iterations, not milliseconds**. Lambda gives CPU in proportion to memory, so a
  fixed iteration count takes less time with more memory; a loop measured in milliseconds would hide
  that.
- Responses: 200 with JSON items; 404 for an unseeded key (k6 only asks for seeded keys, so a 404 is a
  bug and k6 counts it as a miss); 500 for a DynamoDB error after the SDK's retries.
- **The mix is fixed for the life of the project.** Changing it voids every recorded run.

### 4.2 Data model and seed

Each item is `{pk, sk, body}`; `body` is padded to `ITEM_BYTES`, so item size is exact.

| seed parameter | default | sets |
|---|---|---|
| `FEEDS` | 200 | partitions `feed-0000…` |
| `ITEMS_PER_FEED` | 20 | the standard route's RCU and duration |
| `REPORTS` | 20 | partitions `report-000…` |
| `ITEMS_PER_REPORT` | 100 | the heavy route's RCU and duration |
| `ITEM_BYTES` | 1024 | item size |

`service/scripts/seed.js` is copied from `ecs-dynamodb-rps/service/scripts/seed.js` (projects never
import each other). It keeps that script's behaviour: `BatchWriteItem` in batches of 25 (the API
limit), retries of `UnprocessedItems` and of thrown `ProvisionedThroughputExceededException` /
`ThrottlingException` with backoff, pacing between batches, and a hard failure if any item is left
unwritten. What changes:

- Every size is a parameter (the table above).
- **Additive:** keys are deterministic, so a seed with bigger numbers writes only the new keys.
  Nothing is deleted; shrinking means re-creating the table.
- It writes **`seed-manifest.json`** (gitignored): the parameters, item count and total bytes.
  `upload-k6.sh` passes the values to k6, and every `results.md` row copies them.
- It also stores the manifest in the table, as the item `_manifest`, and reads it from there. A
  re-created table with an old local manifest would otherwise skip every key. A smaller seed, or a
  new `ITEM_BYTES`, is refused and writes nothing.
- It runs from the laptop (`direnv exec . npm run seed`) with the table in on-demand mode, before the
  warm-up, never during a run.

## 5. Sizing — from latency and SLO to concurrency and RCU

### 5.1 Inputs

| symbol | meaning | source |
|---|---|---|
| `λ` | target load, requests per second | the profile |
| `s_c` | share of class `c` (0.70 / 0.25 / 0.05) | §4.1 |
| `d_c` | mean Lambda `Duration` of class `c`, seconds, **with OTel on** | CloudWatch, calibration |
| `o` | API Gateway + network overhead | API Gateway `Latency − IntegrationLatency` |
| `T_c` | latency threshold of class `c` | `slo.yaml` |
| `O` | objective: 0.95 latency, 0.99 availability | `slo.yaml` |
| `r_c` | RCU per request of class `c` | the seed manifest + §5.3 |

`d_c` is the CloudWatch `Duration`, which **includes the time extensions run after the function
returns** ("The duration is the sum of all invocation time (runtime + extensions)"). That is the time
a concurrency slot is occupied, so it is the right `d` for §5.2 — not the latency the client sees.

### 5.2 Lambda concurrency — Erlang B

Mean concurrency (Little's law; AWS's own formula, `Concurrency = RPS × average duration`):

    A = λ × Σ_c s_c × d_c

A function with reserved concurrency `C` and no queue is an Erlang loss system: a request that
arrives when all `C` slots are busy is refused. The refused fraction is Erlang B, which depends only
on `A` and `C`:

    B(0, A) = 1
    B(k, A) = A × B(k−1, A) ÷ (k + A × B(k−1, A))      for k = 1 … C

**Throttle budget:** half the availability budget, `B ≤ (1 − 0.99) ÷ 2 = 0.5%`. Choose the smallest
`C` with `B(C, A) ≤ 0.005`, or, for a fixed `C`, the largest `λ` that keeps it.

Computed 2026-11-08/09 (Python, the recurrence above, checked against B(1,1) = 0.5 and B(2,1) = 0.2),
duration 0.2 s for every class — **an example; real values come from calibration**:

| C | λ at B ≤ 0.5% | λ at B ≤ 0.1% | naive C ÷ d | B at the naive ceiling |
|---|---|---|---|---|
| 20 | 55 | 47 | 100 | 15.9% |
| 100 | 404 | 376 | 500 | 7.6% |
| 252 | — | 1,069 | 1,260 | — |

`C ÷ d` is the point where every slot is busy, not a safe operating point. Small pools need much more
headroom than big ones; the baseline at C = 20 is meant to show that.

Example for knob 2: at λ = 300, A = 60, B(20, 60) = **67.4%**, B(100, 60) ≈ **0%**; the smallest C
for B ≤ 0.5% is 78.

### 5.3 DynamoDB read capacity

"For an item up to 4 KB, one read capacity unit (RCU) represents one strongly consistent read
operation per second, or two eventually consistent read operations per second." The service reads
eventually consistent:

    GetItem:  r = 0.5 × ceil(item size ÷ 4 KB)
    Query:    r = 0.5 × ceil(total size of items read ÷ 4 KB)   — rounding NOT verified (§12)
    RCU_mean = λ × Σ_c s_c × r_c
    provisioned RCU = RCU_mean × 1.2

Example with the seed defaults: fast 0.5, standard 20 KB → 2.5, heavy 100 KB → 12.5;
`r_mean = 0.70 × 0.5 + 0.25 × 2.5 + 0.05 × 12.5 = 1.6` RCU per request; at 100 RPS, 160 RCU mean,
192 provisioned. If DynamoDB rounds each item of a `Query` separately, standard costs 10 and heavy 50,
and the same load needs about 4 times as much. Calibration settles it from
`ConsumedReadCapacityUnits ÷ requests` per class.

**Size RCU first, then concurrency.** A DynamoDB throttle is retried by the SDK, so it first shows as
a longer `d`, which raises `A`; a database limit can therefore appear as Lambda throttles. Check
`ReadThrottleEvents` before blaming concurrency.

### 5.4 Latency against the SLO

    latency (warm) = o + (Duration − PostRuntimeExtensionsDuration)
    latency (cold) = the same + init

The client does not wait for the OTel export ("Lambda returns the response to the client, even if
extensions are still running"), so the export is in `d` (§5.2) but not in the latency.

`T_c` = `o` + the p99 of warm latency of class `c` measured in calibration, plus a margin, rounded up;
written into `slo.yaml` once and frozen.

Per run: `throttle fraction + cold-start misses + slow requests ≤ 1 − O`, checked for both
objectives.

### 5.5 `scripts/capacity.js`

Computes §5.2 and §5.3 from the inputs and prints `A`, `B(C, A)`, the λ for a target B, the smallest C
for a target B, and RCU. A `node --test` test pins B(1,1) = 0.5, B(2,1) = 0.2, B(20,20) = 0.159 and
the λ values of the table in §5.2. Every profile rate in §6 comes from it.

## 6. SLO, profiles and the per-user limit

### 6.1 `slo.yaml`

The single source, as in the sibling projects; it generates the k6 thresholds and the Grafana SLO.

- Objectives 95% latency, 99% availability; window 7 days (Grafana's SLO API refuses less than 7);
  **run-scoped attainment is authoritative**.
- A request is **good** when its status is 2xx and its latency is ≤ `T_c`.
- A 5xx is a miss — that includes a Lambda throttle, which reaches the client as API Gateway's 500
  `{"message": "Internal server error"}`.
- **The SLO is judged only over the normal users** (k6 tag `user` = `normal-*`) in the
  `noisy-neighbour` profile, and over the `load` user in the other profiles. The noisy user's 429s are
  reported but are not misses. A normal user's 429 is not a miss either, but it is a design failure,
  reported in its own column with a target of about 0%.
- `T_c` gets **provisional** values in plan 1 (300 / 400 / 1,000 ms, marked `frozen: false`), because
  k6 needs numbers to run `k6 inspect`. Plan 3, phase 0 replaces them in `slo.yaml` and regenerates —
  a configuration change, not a code change.

### 6.2 Random arrivals in k6

k6's `constant-arrival-rate` starts iterations at even intervals, so requests rarely collide and the
run would show far fewer throttles than Erlang B predicts. Each profile therefore runs
`constant-arrival-rate` at **4 × the target rate**, and each iteration sends its request with
probability 0.25 (thinning). That gives near-Poisson arrivals at the target rate.

**Corrected 2026-11-09, during plan 1:** k6 VUs share no state, so a run cannot record the gaps
between all its requests. A unit test of the thinning code checks the gaps instead. Thinning at
p = 0.25 gives gaps that are geometric multiples of the grid interval, so their coefficient of
variation is √(1 − p) = **0.87**, not 1 (Poisson); even arrivals give 0. The test pins 0.87.

**Load zone:** Grafana Cloud k6 runs from **Frankfurt** (`amazon:de:frankfurt`), next to
`eu-central-1`, so the measured API Gateway overhead `o` is not an ocean crossing.

**Corrected 2026-11-09, during plan 2:** this paragraph said Ashburn, next to `us-east-1`; the region was wrong (see the shared
account), so the zone was too.

### 6.3 Profiles (`infra/k6/tests/`)

| profile | key(s) | shape | judged on |
|---|---|---|---|
| `discovery` | `load` | warm-up, then rising RPS steps | last clean step against the §5.2 prediction |
| `constant` | `load` | warm-up, then 10 min at the target | attainment, throttle %, consumed RCU |
| `spike` | `load` | 3 min at 10% of the peak, jump to the peak, hold 2 min | p99 and max latency in the **first 30 s** of the spike; attainment reported |
| `noisy-neighbour` | `normal-1…4`, `noisy` | 10 min | the normal users' attainment; 429s per user |

**Corrected 2026-11-09, during plan 2:** Grafana Cloud k6 refuses an upload above **100 VUs** (error `E2004`, an organization
cap). With no `-e` values, `k6 inspect --execution-requirements` reported `discovery` 920, `noisy-neighbour`
400, `spike` 400 and `constant` 160. Two causes: `vus()` set `maxVUs` to 4 × the rate, and sequential
scenarios overlap by their `gracefulStop` (default 30 s), so k6 adds their VUs. Now `vus(rate, cap = 100)`
sizes by Little's law: busy VUs = sent rate × mean latency, the mean being the mix-weighted class
threshold from `slo.yaml` (0.36 s), times 2 for random bunching, at least 5, at most the cap. Sequential
scenarios set `gracefulStop: '0s'` (an iteration still running at the end is interrupted: at most one
request per VU, under 1 s). Parallel scenarios split the cap: `spike` gives `base` 20 and `surge` 80;
`noisy-neighbour` gives the noisy user 52 and each of four normal users 12 (4 × 12 + 52 = 100). At the
cap a run needs rate × mean client latency ≤ cap (the × 2 is headroom, not the limit); past that,
`dropped_iterations` fails the run. Accepted by upload at C = 100 (about 404 RPS), discovery to 420, a
400 RPS spike and the noisy-neighbour defaults.

**Corrected 2026-11-09, during plan 2 (final review):** acceptance by upload is not feasibility. The
real bound is requests in flight, about rate × client latency, against the scenario's VUs. Consequences:
knob 2 compares C = 20 and C = 100 at about 300 RPS, not at C = 100's 404 RPS capacity (the example
above: A = 60 at d = 0.2 s; about 300 × 0.22 s ≈ 66 in flight, under 100). The spike peak is at most
about 80 RPS: during the cold-start head each request holds a VU for about 1 s, and 80 ÷ 1 s fits the
surge scenario's 80 VUs.

Rates and step sizes come from `capacity.js` after calibration and are passed through `upload-k6.sh`
flags; once frozen, a profile does not change.

### 6.4 The per-user limit (knob 1)

> **Amended 2026-11-10 (draft):** knob 1 becomes three limits (normal, partner, anonymous) and the sizing rule below adds all of them. See `2026-11-10-lambda-concurrency-limit-tiered-rate-limits-design.md`, section 6.

Simulated 2026-11-09 (random arrivals into a token bucket of rate 12 RPS):

| user | rate | burst 1 | burst 5 | burst 12 | burst 24 |
|---|---|---|---|---|---|
| normal | 10 RPS | 45.4% refused | 4.4% | 0.30% | **0.004%** |
| noisy | 60 RPS | | | | **80%** (≈ 12 RPS passes) |

Random arrivals bunch, so a limit barely above a user's mean refuses many requests unless the burst
is large. **Burst = 2 × rate**, fixed in Terraform.

The rule, applied after calibration: with `L` the per-user limit and `R20` the λ at C = 20 and
B ≤ 0.5%, each normal user sends 0.8 × `L`, the noisy user 5 × `L`, and 4 × 0.8 × `L` + `L` ≤ `R20`.
Example: `R20` = 55, `L` = 12 → 4 × 10 + 12 = 52 RPS passes after knob 1, against 100 RPS before.

AWS: "Usage plan throttling and quotas are not hard limits, and are applied on a best-effort basis."
The knob 1 run measures how far the real limit leaks past the simulation. An API key identifies a
test user only; AWS: "Don't use API keys for authentication or authorization."

## 7. OpenTelemetry

- **Layers** (upstream `open-telemetry/opentelemetry-lambda`, v0.24.0, AWS account `184161586896`):
  `opentelemetry-nodejs-0_24_0:1` and `opentelemetry-collector-arm64-0_24_0:1`. The versions are
  Terraform variables.
- **Enabled by** `AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-handler` and
  `OPENTELEMETRY_COLLECTOR_CONFIG_URI=/var/task/collector.yaml`.
- **`service/collector.yaml`**: OTLP receiver → `batch` → `decouple` (last) → OTLP/HTTP exporter to
  `https://otlp-gateway-<region>.grafana.net/otlp`, with `Authorization=Basic <base64(instance:token)>`
  read from an environment variable. `decouple` lets the response return before the export ("allows
  the lambda function to finish before traces/metrics/logs have been exported"); the export is still
  billed and still occupies the slot (§5.1).
- **DynamoDB spans** come from the AWS SDK v3 instrumentation, "included and loaded automatically by
  default", with the `aws.dynamodb.table_names` attribute.
- **Switches:** `otel_enabled` (layers and wrapper on or off) and `trace_sample_ratio`
  (`OTEL_TRACES_SAMPLER=parentbased_traceidratio`, `OTEL_TRACES_SAMPLER_ARG`).
- **The token** comes from a sensitive Terraform variable fed by the shared variable set (root `.env`),
  scoped `traces:write`. It reaches the function as an environment variable.
- **Overhead is measured, not assumed** (phase 0): the same low-rate `constant` run with
  `otel_enabled = false` and `true`; the difference in `Duration`, `PostRuntimeExtensionsDuration`
  and init time is recorded. All sizing uses OTel-on values, and every comparison run keeps the same
  OTel setting and sample ratio.

## 8. Observability and alerts

### 8.1 Grafana (`infra/grafana`) — the main view

Dashboard rows:

1. **Is it up?** API Gateway `Count`, `4XXError`, `5XXError`, `Latency`, `IntegrationLatency`.
2. **SLO**: API Gateway `5XXError` Average (the 5xx fraction) against the 1% budget, and per-route
   `Latency` p95 against each class threshold. There is no `grafana_slo` object.
   **Corrected 2026-11-09, during plan 2:** `grafana_slo` takes only a Prometheus query, the function emits no service-side metrics
   and the SLI is k6 only (decision 5), so the object has no data to read.
   There is no server-side latency burn alert: no per-request latency data exists outside k6.
3. **Concurrency**: `ConcurrentExecutions` with the reserved line; `Throttles` in its own panel
   (throttled requests "don't count as either `Invocations` or `Errors`"); account
   `UnreservedConcurrentExecutions`. No predicted-`A` line: `A` changes per run, so it goes in
   `results.md`, not on the dashboard.
4. **Where the time goes**: `Duration` (Average, p99), `PostRuntimeExtensionsDuration`, their
   difference, cold starts from the log filter.
5. **Provisioned concurrency**: `ProvisionedConcurrencyUtilization`,
   `ProvisionedConcurrencySpilloverInvocations`.
6. **DynamoDB**: `ConsumedReadCapacityUnits` against `ProvisionedReadCapacityUnits`,
   `ReadThrottleEvents`, `SuccessfulRequestLatency` per operation. `ThrottledRequests` is left out: it
   needs an Operation dimension, and `ReadThrottleEvents` already covers reads.
7. **Per user**: requests, 429s and attainment per k6 `user` tag — in the k6 app, not Grafana. API
   Gateway publishes no per-API-key metric, so CloudWatch cannot build this row.

All Lambda metrics have 1-minute granularity. Traces in Tempo; the README links a saved TraceQL query.

Alert rules, to the contact point "Slack - Kovalchuk & Co":

| alert | condition | why |
|---|---|---|
| Availability burn (fast and slow) | API Gateway `5XXError` Average, factors from `slo.yaml` | standard; availability only, as no server-side latency data exists |
| Lambda throttles | `Throttles > 0` for 2 min | the concurrency limit was hit |
| Shared pool in danger | `UnreservedConcurrentExecutions` > 176 (50% of 352) | protects the other apps; should never fire |
| DynamoDB throttles | `ReadThrottleEvents > 0` | the database binds, so a knob run is invalid |
| Provisioned concurrency left on | `ProvisionedConcurrencyUtilization` has data for > 2 h | billed while it exists |

CloudWatch-based rules use `no_data_state = OK`.

Per-route `Latency` exists only with detailed metrics on the stage (`aws_api_gateway_method_settings`,
`metrics_enabled = true`). They are billed as CloudWatch custom metrics: 3 methods × 7 metrics, prorated
by the hour, cents per session. API Gateway access logs and execution logs stay off: both need the
account-wide API Gateway CloudWatch role (`aws_api_gateway_account`), and the account is shared.

### 8.2 CloudWatch dashboard (`infra/main`) — the AWS-side view

Widget "Where the Lambda time goes", alias `live`, Average and p99, 1 minute:
`Duration`; `PostRuntimeExtensionsDuration` (the OTel export — "The cumulative amount of time that
the runtime spends running code for extensions after the Event Function code has completed");
`Duration − PostRuntimeExtensionsDuration` (the code's own time); export ÷ `Duration` as a
percentage. Plus throttles, concurrency and DynamoDB reads.

### 8.3 `results.md`

One row per run: date, profile, infra change (or `exploration`), seed manifest, λ target and
achieved, predicted `A`, `B` and RCU, k6 attainment (latency and availability), throttle %, 429 %
(normal and noisy), p95/p99 per class, `Duration` and export time, cold starts, consumed RCU,
DynamoDB throttles, reserved and provisioned concurrency, OTel setting, k6 run id. `loadtest.md`
defines how each column is read and which must not be blank.

## 9. Measurement sequence

| phase | change | profile(s) | expected |
|---|---|---|---|
| 0. Calibrate | `otel_enabled` off, then on | `constant` at a low rate | measures `d_c`, `o`, export time, RCU per class, init time; freeze `T_c` and every profile rate |
| 1. Baseline | C = 20, no per-user limit | `discovery`, `constant`, `noisy-neighbour` | the "before" rows |
| 2. Knob 1 | `user_rate_limit_rps` 0 → `L` | `noisy-neighbour` | normal users: SLO breached → kept |
| 3. Knob 2 | `reserved_concurrency` 20 → 100 | `constant` at about 300 RPS (not C = 100's 404 RPS capacity), then `discovery` | ~67% throttled → ~0% (example values) |
| 4. Knob 3 | `provisioned_concurrency` 0 → `N` | `spike` | cold-start tail in the first 30 s shrinks |

- Phase 3's "before" row is the same `constant` profile run at C = 20.
- `N` = the Erlang B concurrency for the spike peak at B ≤ 0.5%, and `N` ≤ reserved concurrency.
- **Knob 3 barely moves attainment, and the README says so.** Example: a spike from 10 to 300 RPS at
  0.2 s needs about 71 new environments (the profile is bounded to about 80 RPS by the VU cap, so
  about 16 new environments at d = 0.2 s) — 0.39% of the 18,000 requests in 60 s, 2.4% of those in the
  first 10 s; both inside the 5% latency budget. Provisioned concurrency buys the tail, not the
  average, which is why it is judged on p99 and max (decision 12).
- The 1,000-environments-per-10-seconds scaling rate cannot show at this size (ceiling 252); the
  README says the spike is not a scaling-rate test.
- **DynamoDB capacity is exploration** (provisioned RCU, maximum read units, SDK attempts), outside
  this sequence. Every comparison runs on-demand. Exploration rows say `exploration` and are never
  compared with knob rows. Rules that constrain it: provisioned → on-demand at most 4 times in a
  rolling 24 hours (the other direction any time); provisioned decreases: 4 available, +1 per hour,
  at most 27 per day — so step RCU upward; burst capacity keeps up to 300 s of unused capacity, so
  wait for a full bucket before each provisioned run and spend it inside the warm-up.
- Each apply is its own step and stops for approval.

## 10. Configuration — every switch

| switch | where | default | used by |
|---|---|---|---|
| `reserved_concurrency` | `dev.tfvars` | 20 (1–252) | baseline, knob 2 |
| `user_rate_limit_rps` | `dev.tfvars` | 0 = no limit; burst = 2 × | knob 1 |
| `provisioned_concurrency` | `dev.tfvars` | 0 = no resource | knob 3 |
| `otel_enabled`, `trace_sample_ratio` | `dev.tfvars` | `true`, 1 | phase 0 |
| `otel_layer_version` | `dev.tfvars` | `0_24_0` | upgrades |
| `memory_size`, `heavy_cpu_iterations` | `dev.tfvars` | set in phase 0 | exploration |
| `sdk_max_attempts` | `dev.tfvars` | SDK default | exploration |
| `billing_mode`, `read_capacity`, `write_capacity`, `max_read_request_units` | `dev.tfvars` | `PAY_PER_REQUEST` | exploration |
| `log_retention_days` | `dev.tfvars` | 7 | — |
| `FEEDS`, `ITEMS_PER_FEED`, `REPORTS`, `ITEMS_PER_REPORT`, `ITEM_BYTES` | seed env | §4.2 | the seed |
| rates, steps, durations | `upload-k6.sh` flags | from `capacity.js` | profiles |

**Not a switch, on purpose:** DynamoDB warm throughput. Raising it is charged and "the values can't
be decreased" — a trap in a lab that is destroyed and re-created.

The function reads every runtime setting from environment variables set by Terraform.
A code change needs `deploy-service.sh`. **Corrected 2026-11-09, during plan 2:** a configuration change needs it too, in `--config-only` mode, because a
version freezes its configuration. After `terraform apply`, run `deploy-service.sh --config-only` for
`otel_enabled`, `trace_sample_ratio`, `otel_layer_version`, `memory_size`, `timeout_seconds`,
`heavy_cpu_iterations` and `sdk_max_attempts`. These need no script: `reserved_concurrency`, `provisioned_concurrency`,
`user_rate_limit_rps`, every DynamoDB setting and `log_retention_days`.

## 11. Lifecycle, cost, and changes outside the project

**Up** (`/env up`): `terraform apply` (approval) → `deploy-service.sh` → seed → `upload-k6.sh`.

**Down** (`/env down`): `terraform destroy`, then the tag sweep. Survivors to check: the log group
(declared in Terraform), published versions (deleted with the function), the CloudWatch dashboard
(`PutDashboard` accepts tags only at creation; whether the Terraform resource sets them is not
verified — if not, the sweep checks it by name), the table, the k6 project (owned by `infra/k6`).

**Cost per session (estimates):** Lambda and API Gateway under $1 for all runs (REST API about $3.50
per million; a 10-minute run at 400 RPS is 240,000 requests); DynamoDB on-demand cents; provisioned
concurrency about $0.75 per hour for 100 × 0.5 GB (x86 price; arm64 not verified), removed right after
phase 4. Grafana Cloud k6 VU-hour allowance: **not checked** — plan 3 checks it before phase 1.

**Outside the project:**

- `platform/tfc.tf`: the workspace line (the `/new-project` skill lists every place).
- Root `README.md`: the projects table row.
- `CLAUDE.md`: the deployment paragraph ("Lambda will publish a version") becomes "a script publishes
  the version and moves the alias; Terraform ignores both"; the layout note that a Lambda project has
  no `heartbeat/`; a k6 note on random arrivals (thinning).
- `docs/research/lambda-concurrency-limit.md`: forward-pointers at C6 and at the "short answer".

## 12. Unverified, to settle on the first deploy

| item | how it is settled |
|---|---|
| `Query` RCU rounding (total vs per item) | phase 0: `ConsumedReadCapacityUnits ÷ requests` per class |
| Node.js OTel layer on arm64 (the layer name has no architecture) | **settled 2026-11-09, plan 2:** `opentelemetry-nodejs-0_24_0:1` lists `nodejs22.x` and `arm64`, the collector layer `opentelemetry-collector-arm64-0_24_0:1` lists `arm64` (`aws lambda get-layer-version-by-arn`, `eu-central-1`) |
| DynamoDB span names | first trace |
| Whether a new invocation waits while the extension exports | phase 0: `Duration` against throttles at a fixed rate |
| API Gateway status for a Lambda throttle (docs: 500; one third-party test saw 429 in the access log) | phase 1 |
| SDK default max attempts | **settled in plan 1:** `@aws-sdk/client-dynamodb` 3.1164.0 reads `AWS_MAX_ATTEMPTS`, default 3, `standard` retry mode — true only if plan 2 bundles `node_modules` instead of using the SDK built into the Lambda runtime |
| The collector expands `${env:…}` in `collector.yaml` | first deploy: a trace appears in Tempo |
| Layer v0.24.0 ships the `decouple` processor under that name | first deploy: the collector starts (no config error in the logs) |
| The `otlphttp` exporter appends `/v1/traces` to the `/otlp` base endpoint | first deploy: a trace appears in Tempo |
| CloudWatch dashboard tags through Terraform | **settled 2026-11-09, plan 2:** `aws_cloudwatch_dashboard` has no `tags` argument (`hashicorp/aws` 6.x), so the tag sweep cannot see it; `destroy` deletes it and the README's teardown checks it by name |
| Grafana Cloud k6 VU-hour allowance | plan 3, before phase 1 |
| Account limits unchanged since 2026-11-08 | **settled 2026-11-09, plan 2:** `eu-central-1` still 400 / 352 |
| Alias-level Lambda metrics use `Resource = <function>:live` | plan 3, phase 0: the CloudWatch widget shows data |

## 13. Execution shape

| plan | what | gate |
|---|---|---|
| 1 | service (handler, routes, config), `collector.yaml`, seed, `capacity.js` with tests, the four k6 profiles (`k6 inspect`), `slo.yaml` with thresholds open | none — no AWS |
| 2 | `infra/main`, `infra/grafana`, `infra/k6`, the scripts, the `platform/` line, README, `loadtest.md`; ends at a reviewed `terraform plan` | none |
| 3 | apply → deploy → seed → phases 0–4 → README results → destroy and sweep | every apply and the destroy stop for approval |

**Plan 3 contains no implementation**: only `dev.tfvars` edits, applies, script runs and k6 runs. If it
needs a code change, plans 1–2 missed something, and that is fixed there, not patched in plan 3.

Per-task verification for HCL: `fmt -check`, `validate`, a reviewed `plan`. No SLO or RPS number is
reported without the k6 output or Grafana query that produced it, from a run in the same session.

## 14. Sources

All read 2026-11-08/09. The Lambda docs now call standard functions "Event Functions".

- Lambda concurrency, reserved/provisioned, 100 unreserved minimum, formula:
  https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html
- Scaling rate: https://docs.aws.amazon.com/lambda/latest/dg/scaling-behavior.html
- Metrics, `Throttles`, `Duration`, `PostRuntimeExtensionsDuration`:
  https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html,
  https://docs.aws.amazon.com/lambda/latest/dg/monitoring-concurrency.html
- Extensions and duration: https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html,
  https://docs.aws.amazon.com/lambda/latest/dg/runtimes-extensions-api.html
- API Gateway errors from Lambda: https://docs.aws.amazon.com/lambda/latest/dg/services-apigateway-errors.html
- REST vs HTTP API: https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html
- Usage plans: https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-usage-plans.html
- Throttling: https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html
- DynamoDB: capacity modes, switching, quotas, burst, RCU, warm throughput —
  https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-switching-capacity-modes.html,
  https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html,
  https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/burst-adaptive-capacity.html,
  https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/provisioned-capacity-mode.html,
  https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/warm-throughput.html
- OTel Lambda: https://github.com/open-telemetry/opentelemetry-lambda (releases, collector README,
  decouple processor README, nodejs README), https://opentelemetry.io/docs/faas/lambda-auto-instrument/
- Grafana Cloud OTLP: https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp/
- CloudWatch dashboards: https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_PutDashboard.html
