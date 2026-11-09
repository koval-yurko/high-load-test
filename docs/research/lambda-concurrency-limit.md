# Research — `lambda-concurrency-limit`

Status: **complete** — the design is `docs/superpowers/specs/2026-11-09-lambda-concurrency-limit-design.md`
(2026-11-09), which amends C6 and the first paragraph of "The short answer"; forward-pointers are at both.
Nothing here has been load-tested. Every number is one of three kinds, and is labelled: **read from the
account** today with a read-only `aws` call, **documented** by AWS (with the URL in "Sources"), or an
**estimate**.

Next step: write the spec through `superpowers:brainstorming`.

## The short answer

> **Amended 2026-11-09:** the front door is an API Gateway REST API, not a Function URL, and there
> are three knobs, not two — see `docs/superpowers/specs/2026-11-09-lambda-concurrency-limit-design.md`.

A Node.js 22 Lambda behind an **API Gateway REST API**, reading and writing **DynamoDB on-demand**.
The knobs are **reserved concurrency**, **provisioned concurrency** and a **per-user rate limit**
(an API Gateway usage plan per API key). The user chose API Gateway and the per-user limit on
2026-11-08.

- The function's work is made deliberately slow (about 200 ms per request, an estimate to calibrate).
  Then a concurrency limit of 20 caps the function near 100 RPS, which k6 can drive cheaply.
  Concurrency = RPS × average duration in seconds (AWS's own formula).
- **Baseline:** reserved concurrency 20. A constant load above about 100 RPS is throttled by Lambda,
  the client gets HTTP 500, and the SLO burns.
- **Knob 1:** reserved concurrency 20 → 100. Same constant profile; the throttles should stop.
- **Knob 2:** provisioned concurrency on the spike profile. A spike makes new execution environments,
  and each pays a cold start. Provisioned concurrency keeps environments ready, so the spike's p99
  should fall.
- **Knob 3:** a per-user rate limit, on a "noisy neighbour" profile. One user sends far more than
  its share. Before: that user takes the whole reserved concurrency, and every user gets 500s.
  After: the usage plan gives the noisy user 429s, and the other users stay inside the SLO.

The loop is the same as in the two ECS projects. The thing that runs out is different: here it is a
counter that AWS enforces, not a CPU, a disk or a pool.

## What the account looks like today (read 2026-11-08)

`aws lambda get-account-settings`, region `eu-central-1`:

| setting | value |
|---|---|
| `ConcurrentExecutions` (account limit) | **400** (the AWS default is 1,000; this account is lower) |
| `UnreservedConcurrentExecutions` | **352** |
| functions in the account | 10 — **none** belong to this repo |

Corrected 2026-11-09: the reading was made in `eu-central-1`, the region every project here uses; `us-east-1` has an account limit of 10.

**The account is shared with other apps.** Seven functions (`emails-flow-*` and
`LocalsScrapperDevStack-ServerApp-dev`) reserve 48 executions between them. Two more
(`LocalsScrapperDevStack-UserFetch-dev`, `GraphAppBffStack-ServerApp`) reserve nothing, so they run
from the unreserved pool.

## Main challenges

### C1 — The test must never use up the shared pool

A function without reserved concurrency draws from the 352 unreserved executions. If the load test
uses them all, `UserFetch-dev` and `GraphAppBff` are throttled too. That is an outage in an
unrelated app, caused by a lab.

**Answer:** the test function **always** has reserved concurrency, from the first apply. Reserved
concurrency is both a ceiling and a floor: "no other function can use that concurrency". It is free
to configure. AWS keeps at least 100 executions unreserved, so this account can reserve at most
352 − 100 = **252** for the test function (documented rule, account value read today). The knob
sequence must stay at or below 252. A higher value means a service-quota increase, which is
possible but outside Terraform's normal lifecycle.

### C2 — Two kinds of rejection, two status codes

Behind a REST API there are two different rejections, and the client can tell them apart:

| who rejects | why | what the client gets |
|---|---|---|
| Lambda | the reserved concurrency is full | **500**, body `{"message": "Internal server error"}`. API Gateway does not retry. A third-party test saw 429 in the API Gateway access log for the same request. |
| API Gateway usage plan | this user is over its own rate | **429 Too Many Requests** |

**A Lambda throttle is a miss.** It is a 5xx, so the sibling rule ("a 5xx is a miss") already
covers it.

**A per-user 429 is not a miss** (decision 6). The sibling rule says "a 4xx is not a miss".
For the noisy-neighbour test that is the right reading: the noisy user's 429s are the limit working,
and the SLO that matters is the one for the other users. k6 counts any status ≥ 400 as failed, so
k6 must tag requests by user and judge the well-behaved users separately.

### C3 — Why a REST API and not an HTTP API

- **Per-user throttling exists only on REST APIs.** AWS: "Choose REST APIs if you need features
  such as API keys, per-client throttling, …". The comparison table marks "Per-client usage
  throttling" as No for HTTP APIs.
- The cost: $3.50 per million requests, against $1.00 for an HTTP API.
- A REST API has a 29 s integration timeout by default. Our function runs for about 200 ms, so this
  never binds.

**API Gateway cannot wait for a free Lambda.** Its throttle is a token bucket, and its integration
timeout limits how long a *running* function may take. It does not hold a request until capacity is
free. When Lambda refuses the call, API Gateway returns 500 at once and does not retry. Waiting for
capacity needs a queue (decisions 7 and 8: not used).

### C3a — Limits of the per-user rate limit

- **Best-effort, not a hard limit.** AWS: "Usage plan throttling and quotas are not hard limits, and
  are applied on a best-effort basis." Expect a few requests over the limit to pass. The test must
  measure the leak, not assume zero.
- **An API key is not authentication.** AWS: "Don't use API keys for authentication or
  authorization." In this lab a key only identifies a test user. Each user gets one key and one
  usage plan, in Terraform.
- **The keys must reach k6.** They are Terraform outputs, read at run time. They are never written
  into the repo.
- Real per-user identity (a JWT subject) is possible: a Lambda authorizer can return the API key
  (`apiKeySource = AUTHORIZER`). That adds a second function and its own cold starts. Not in scope.

### C4 — The slower the function, the cheaper the test

With 50 ms of work, 252 executions carry about 5,000 RPS. That is expensive to drive from Grafana
Cloud k6 and far above the RPS the ECS projects reached (765 at most). With about 200 ms, a reserved
concurrency of 20 throttles at about 100 RPS (estimates from the formula).

Two traps:
- AWS also limits **requests per second to 10 × concurrency**. A function shorter than 100 ms hits
  that RPS limit before the concurrency limit. A duration of about 200 ms keeps the concurrency limit
  the one that binds.
- The duration must come from real work (DynamoDB reads, some CPU), not only a `setTimeout`. A pure
  sleep costs no CPU, so memory size and provisioned concurrency would make no difference.

### C5 — Cold starts are only in the logs

There is **no Init-duration metric**. `Init Duration` appears only on the `REPORT` log line of a cold
start. The CloudWatch `Duration` metric **does not include** the cold start. So the only place a cold
start shows in the numbers is k6's client-side latency, and the logs.

**Answer (simple):** k6 latency is the SLI. For evidence, one CloudWatch Logs metric filter counts
`REPORT` lines that contain `Init Duration`. That gives a cold-start count per minute.

### C6 — The service-side SLI

> **Amended 2026-11-09:** OTel is in — the upstream OpenTelemetry collector runs as a Lambda
> extension and exports traces to Grafana Cloud Tempo. The SLI is still k6 only. See
> `docs/superpowers/specs/2026-11-09-lambda-concurrency-limit-design.md`, "OpenTelemetry".

The ECS projects compute a second, service-side attainment from OTel histograms, through an Alloy
collector. A Lambda has nowhere to run a collector cheaply.

**Recommendation:** one SLI, from k6. CloudWatch gives the evidence (`Throttles`,
`ConcurrentExecutions`, `Duration` p95, cold-start count) at 1-minute resolution. This follows "two
plain metrics beat an inference model". The `results.md` column `service attainment` becomes
`throttles`.

### C7 — Throttles are not invocations

"Throttled requests don't count as either `Invocations` or `Errors`." A dashboard that shows only
`Errors / Invocations` will show 0% errors during the worst throttle. `Throttles` must be its own
panel and its own alert.

### C8 — The scaling rate will not show at this size

Each function can grow by 1,000 execution environments every 10 seconds. Our ceiling is 252, so the
spike can never meet that limit. The spike will show cold starts and the reserved-concurrency
ceiling, not the scaling rate. Say so in the README, so that nobody reads it as a scaling-rate test.

### C9 — Provisioned concurrency costs money while it exists

Provisioned concurrency is charged per GB-second for as long as it is configured, even with no
traffic. It takes 1–2 minutes to allocate, and none of it is usable until all of it is allocated.
It must sit inside the reserved concurrency (provisioned ≤ reserved). It needs a published version or
alias, so the function needs `publish = true` and an alias that the API Gateway integration points at.

### C10 — Teardown survivors

- The log group `/aws/lambda/<name>` is created by Lambda on the first call, so Terraform does not
  own it. Declare it in Terraform, with retention, before the function.
- The DynamoDB table: on-demand costs nothing at rest, but it holds data and storage is charged. Keep
  `deletion_protection_enabled = false`.
- Provisioned concurrency: removed with the alias. Check that the sweep finds nothing after destroy.
- The k6 project and the Grafana objects: the same as in the siblings.

## What DynamoDB adds

- A new on-demand table takes up to 4,000 writes and 12,000 reads per second, and "instantly
  accommodates up to double the previous peak" (documented). At about 500 RPS the table will not
  throttle, so the Lambda concurrency limit stays the only limit. That is the point of picking it.
- An on-demand table can be capped with **maximum throughput**, but AWS calls the cap "best-effort",
  so it is not a clean knob. Do not use it.
- No VPC, no NAT gateway and no ENIs. The function reaches DynamoDB over the public endpoint. A VPC
  would also slow down `destroy`: AWS needs up to 20 minutes to delete the Hyperplane ENI.

## What changes outside this project

- A new k6 profile, `noisy-neighbour`: N well-behaved users at a steady rate, plus one user far above
  its limit. It runs unchanged before and after knob 3.
- `platform/tfc.tf`: one workspace line (the `/new-project` skill lists every place).
- The root README projects table: change the row from "not built yet".
- The `/loadtest` contract (`loadtest.md`): `throttles` and `cold starts` replace the pool and disk
  columns.

## Decisions (2026-11-08, by the user)

| # | question | answer |
|---|---|---|
| 1 | Front door | **API Gateway REST API** (per-client throttling exists only there) |
| 2 | Per-user rate limit | **Yes**, as a knob the lab tests: one API key and one usage plan per test user |
| 3 | Database | **DynamoDB on-demand** |
| 4 | Knob order | **Reserved concurrency 20 → 100** (constant), **provisioned concurrency** (spike), **per-user limit at reserved concurrency 20** (noisy neighbour) — three knobs |
| 5 | SLI | **k6 only**; CloudWatch is evidence, not a second attainment |
| 6 | Is a per-user 429 a miss? | **No** — it is the limit working. The SLO is judged over the well-behaved users |
| 7 | Queue for writes (SQS) | **No** |
| 8 | Step Functions as a "wait for a free Lambda" layer | **No** — considered and skipped |

Recorded for the spec: API Gateway cannot wait for a free Lambda, and its SQS integration cannot wait
for a reply message. The only synchronous way to wait was Step Functions with retry on
`Lambda.TooManyRequestsException` (decision 8, skipped; unverified in this session).

## Capacity per concurrency — what performance testing measures

The user's requirement (2026-11-08): **at a given reserved concurrency, the SLO stays high, and the
lab can still find how many RPS that concurrency carries.**

Lambda makes this possible because of one property: **one execution environment serves one request
at a time.** Extra load does not make a request slower, as it does on an ECS task, where requests
share a CPU and an event loop. Extra load only needs more environments. So, under the ceiling, the
latency stays flat. At the ceiling, extra requests are refused (500), and they are not slowed down.

That gives a first prediction:

    naive ceiling ≈ reserved concurrency ÷ average duration in seconds

(20 ÷ 0.2 s = 100 RPS; 100 ÷ 0.2 s = 500 RPS.) **This is the 100%-busy point, not the safe
point.** With random arrivals the slots are sometimes all busy well below it, and those requests
are throttled. "Sizing: from latency and SLO to concurrency and RCU" below gives the real
arithmetic: at reserved concurrency 20 and 0.2 s, a throttle rate of 0.1% or less allows only about
**47 RPS**, not 100.

What the design must do so that only the concurrency limit decides the result:

1. **A stable duration.** Each route does a fixed amount of work (DynamoDB calls and a fixed CPU
   loop), so the duration does not drift with load. A wide spread in duration makes the knee soft.
2. **Class thresholds well above the duration.** For example, a 400 ms threshold for 200 ms of work
   (an estimate, set during calibration). Then a warm request under the ceiling is always good, and
   only throttles and cold starts can be misses.
3. **Warm-up before the measured window.** Each profile starts with a ramp that creates the
   environments. Cold starts then fall in the warm-up and not in the measured steps. The spike
   profile is the exception: there the cold starts are what knob 2 removes.
4. **Nothing else may bind first.** DynamoDB on-demand takes 4,000 writes and 12,000 reads per
   second on a new table, and API Gateway takes 10,000 RPS per account. Both are far above 500 RPS.
   The 10 × concurrency RPS limit is not reached while the duration is above 100 ms.

**The performance-testing loop**, for each reserved-concurrency value:

- A **discovery** profile steps the RPS up (as in the sibling projects). The last clean step is the
  measured capacity. Compare it with the prediction above. A large gap means something other than
  concurrency is binding, and it must be explained before any comparison.
- A **constant** profile at about 80% of that capacity must keep the SLO high. This is the "SLO
  stays high at a defined concurrency" check.
- The **duration knob** (`WORK_MS` or a loop count, through an environment variable) and the
  **memory size** change the duration, and so the RPS per unit of concurrency. They are for
  exploration only. They are not one of the three knobs, and a run that changes them is not compared
  with a run that does not.

Not in scope, and suggested as separate projects later: **Lambda Managed Instances** (Nov 2025; one
environment serves several calls at once and scales on CPU) and **Lambda Web Functions** (Oct 2026;
up to 128 concurrent requests per environment). Both use a different concurrency model, so they are
a new scenario, not a knob in this one.

## Sizing: from latency and SLO to concurrency and RCU

The user's requirement (2026-11-08): every capacity number in this project is **computed** from
the measured latency and the SLO, and the arithmetic is written down. The method has four steps.
Numbers marked "example" use assumed inputs; the real inputs come from calibration on the deployed
function.

### Step 1 — Inputs

| symbol | meaning | source |
|---|---|---|
| `λ` | target load, requests per second | the profile |
| `s_c` | share of class `c` in the mix (fast, standard, heavy; sums to 1) | the profile |
| `d_c` | **warm** Lambda duration of class `c`, seconds (mean) | CloudWatch `Duration`, calibration run |
| `o` | API Gateway + network overhead, seconds | k6 latency − Lambda `Duration` |
| `T_c` | latency threshold of class `c` | `slo.yaml` |
| `O` | SLO objective, e.g. 0.99 | `slo.yaml` |
| `r_c` | read units of one request of class `c` | the seed manifest + the RCU rule (step 3) |

### Step 2 — Lambda concurrency

**Mean concurrency (Little's law, AWS's own formula):**

    A = λ × Σ_c s_c × d_c                       (the "offered load", in executions)

**Throttle fraction.** A function with reserved concurrency `C` and no queue is an Erlang loss
system: a request that arrives when all `C` slots are busy is refused. The fraction refused is the
**Erlang B** formula, and it depends only on `A` and `C` (not on the shape of the duration
distribution):

    B(0, A) = 1
    B(k, A) = A × B(k−1, A) ÷ (k + A × B(k−1, A))      for k = 1 … C

**Pick `C` from the error budget.** The budget is `E = 1 − O`. Throttles, cold starts and slow
requests all spend it. Give throttles a fixed part of it (example: half), and choose the smallest
`C` with `B(C, A) ≤ E ÷ 2`.

Computed 2026-11-08 (Python, the recurrence above, checked against B(1,1) = 0.5 and B(2,1) = 0.2),
duration 0.2 s for every class (example):

| λ (RPS) | A | C for B ≤ 1% | C for B ≤ 0.1% | C for B ≤ 0.01% |
|---|---|---|---|---|
| 50 | 10 | 18 | 21 | 24 |
| 100 | 20 | 30 | 35 | 39 |
| 250 | 50 | 64 | 71 | 77 |
| 500 | 100 | 117 | 128 | 137 |

And the other way — the most RPS a given `C` carries at B ≤ 0.1%, against the naive `C ÷ d`:

| reserved concurrency C | RPS at B ≤ 0.1% | naive C ÷ d |
|---|---|---|
| 20 | 47 | 100 |
| 100 | 376 | 500 |
| 252 (this account's maximum, see C1) | 1,069 | 1,260 |

At the naive ceiling itself, B is **15.9%** for C = 20 and **7.6%** for C = 100. Small pools need
much more headroom than big ones. This is the effect the baseline (C = 20) is meant to show.

**Warning — k6 does not send random arrivals.** Erlang B assumes arrivals at random times (a
Poisson process), as real users send them. k6's `constant-arrival-rate` executor starts iterations
at even intervals, so its requests rarely collide, and it will show far fewer throttles than Erlang
B predicts — close to zero until the naive ceiling. The spec must decide which one the lab measures:
even arrivals (a clean, sharp knee at `C ÷ d`), or random arrivals (realistic; needs random gaps in
the k6 script, for example an exponential wait per VU). Either way, the README states which.

### Step 3 — DynamoDB read capacity

**Read units per request.** Eventually consistent reads cost 0.5 RCU per 4 KB, rounded up:

    GetItem:  r = 0.5 × ceil(item size ÷ 4 KB)
    Query:    r = 0.5 × ceil(total size of the items read ÷ 4 KB)     (rounding rule NOT verified)

**Mean RCU at load `λ`:**

    RCU_mean = λ × Σ_c s_c × r_c

**Provisioned RCU to set:** `RCU = RCU_mean × (1 + h)`, with headroom `h` (example: 0.2). Burst
capacity (up to 300 s of unused capacity) absorbs second-to-second variation, but not a sustained
excess: a load above the provisioned RCU drains it within minutes and then throttles.

Example — 1 KB items, a mix of 70% fast, 25% standard, 5% heavy; the standard route reads 20 items
(20 KB → 2.5 RCU), the heavy route 100 items (100 KB → 12.5 RCU):

    r_mean = 0.70 × 0.5 + 0.25 × 2.5 + 0.05 × 12.5 = 1.6 RCU per request
    at 100 RPS: RCU_mean = 160, provisioned with 20% headroom = 192

If DynamoDB instead rounds each item of a `Query` separately, the standard route costs 10 RCU and
the heavy route 50, and the same load needs about 4 times as much. The first calibration run settles
this from `ConsumedReadCapacityUnits` ÷ requests per class.

**The seed sets `r_c`.** More items per partition, or bigger items, make the standard and heavy
routes cost more RCU and more duration. That is how the seed "mimics DB load", and why every
`results.md` row carries the seed manifest.

### Step 4 — Latency against the SLO

A request of class `c` is good when it is not an error and its client-side latency is at most `T_c`:

    latency = o + d_c                   (warm)
    latency = o + init + d_c            (cold start)

- **Thresholds:** pick `T_c` so that the warm latency at its p99 is inside it, with margin. Example:
  `o` = 30 ms and a warm p99 `d` of 250 ms → `T` = 400 ms.
- **Cold starts:** a cold request is a miss if `o + init + d_c > T_c`. The fraction of cold requests
  is (new environments ÷ requests); at steady load it is small, during a spike it is not. That is
  what knob 3 (provisioned concurrency) buys.
- **DB throttles add latency first** (the SDK retries them), so `d_c` grows, and with it `A` in
  step 2. Size RCU first, then concurrency.

**The whole budget, checked per run:**

    throttle fraction (B, or measured 5xx)  +  cold misses  +  slow warm requests  ≤  1 − O

### What the lab records

Each `results.md` row carries the inputs (`λ`, mix, `d_c`, `o`, seed manifest, `C`, RCU) and the
prediction (`A`, `B(C, A)`, `RCU_mean`) next to the measured throttle fraction, consumed RCU and
attainment. A gap between prediction and measurement is the finding, not noise.

A small `scripts/capacity.js` can do steps 2 and 3 from these inputs, with a test that pins the
Erlang B values above. Whether it exists is a spec decision; the formulas here do not depend on it.

## Workload: GET only, over seeded data (decided 2026-11-08)

The user's decision: **only GET requests**. Nothing in the load writes, so the table size, and so
the response time, stay fixed at whatever the seed made. Two runs on the same seed are comparable;
a run on a different seed is not, and `results.md` records the seed size on every row.

This also removes a problem the sibling projects had: there, inserts grew the table during and
between runs (the pool project records `posts rows` per run because it could not control it).

**Routes** keep the sibling's three-class shape, all `GET`:

| class | route (estimate) | DynamoDB call | what makes it cost more |
|---|---|---|---|
| fast | `GET /items/:pk/:sk` | `GetItem` | one item |
| standard | `GET /feeds/:pk` | `Query`, one partition | the items per partition |
| heavy | `GET /reports/:pk` | `Query` over a bigger partition, plus a fixed CPU loop | the item count and the loop |

The cost of each class is set by **the seed shape**, not by request parameters, so the k6 profile
never changes when the seed does.

## Seed

`scripts/seed.js`, copied from `ecs-dynamodb-rps/service/scripts/seed.js` (projects never import
each other). That script already does the hard parts: `BatchWriteItem` in batches of 25, retries of
`UnprocessedItems` and of thrown `ProvisionedThroughputExceededException` / `ThrottlingException`
with backoff, a pace between batches so a provisioned table is not drained, and a hard failure if
any item is left unwritten.

What changes from the sibling:

- **Every size is a parameter**, not a constant: partitions, items per partition, item size in
  bytes, and the size of the heavy-route partitions. Defaults live in one place.
- **"Seed more" is additive.** Keys are deterministic (`feed-0042/item-0007`), so a second run with
  bigger numbers writes only the new keys and leaves the existing ones. A smaller number never
  deletes; shrinking means a re-create.
- **It runs from the laptop against the real table**, through `direnv exec .`. It writes data, not
  infrastructure, so it is allowed under "Terraform is the only way infrastructure exists" — the
  sibling's deploy script seeds the same way.
- **It prints the result as a manifest**: item count, total bytes and the seed parameters. The
  manifest goes into `results.md` with each run, because a run is only comparable to a run on the
  same seed.
- **Seed before the warm-up, never during a run.** The seed writes; the profile must not see them.

## DynamoDB capacity — the second thing to play with (decided 2026-11-08)

The user's requirement: the read capacity and limits of the table are **configurable**, so the lab
can make the database the limit on purpose. Everything below is a Terraform variable in
`dev.tfvars`; changing one is an edit and an apply, with no code change.

| variable | values | what it does |
|---|---|---|
| `billing_mode` | `PAY_PER_REQUEST` (default) or `PROVISIONED` | on-demand, or a fixed capacity |
| `read_capacity` | RCU, when provisioned | the read ceiling |
| `write_capacity` | WCU, when provisioned | only the seed writes; keep it small |
| `max_read_request_units` | on-demand only, optional | a cap on an on-demand table — **best-effort**, not an exact ceiling |
| `sdk_max_attempts` | 1 to 4 | sets `AWS_MAX_ATTEMPTS` on the function; see "A database throttle looks like latency" |

**Warm throughput is not a variable, on purpose.** Raising it is charged, and "the values can't be
decreased". In a lab that is destroyed and re-created, a value that only goes up is a trap.

### Read capacity arithmetic

"For an item up to 4 KB, one read capacity unit (RCU) represents one strongly consistent read
operation per second, or two eventually consistent read operations per second." The service uses
eventually consistent reads, so a `GetItem` of an item up to 4 KB costs 0.5 RCU. Example (estimate):
100 RPS of the fast route on 1 KB items needs 50 RCU. The seed manifest gives the item sizes, so
the spec can compute the RCU each class needs. How a `Query` rounds its total size is **not
verified**; measure it from `ConsumedReadCapacityUnits` on the first run.

### Rules that limit how often the lab can change capacity

- **Switch provisioned → on-demand at most 4 times in a rolling 24 hours.** On-demand → provisioned
  can be done at any time.
- **Decreases of provisioned capacity:** "You start each day with 4 available decreases. Each hour,
  1 additional decrease becomes available, up to the maximum of 4 available at any time." That is
  at most 27 decreases a day (UTC). Increases are not limited this way.
- So a session that steps RCU **down** gets 4 quick steps, then one an hour. Plan an RCU series
  **upwards** (low → high), which is not limited.
- **Seed in on-demand, then switch to provisioned.** That direction is free at any time, and the seed
  does not need WCU.

### Burst capacity makes the first minutes lie

"DynamoDB currently retains up to five minutes (300 seconds) of unused read and write capacity." A
provisioned table that was idle starts each run with up to 300 s of credit, so the first minutes
take more load than the RCU allows. The sibling met the same effect and made a fixed wait before
each run, so that every run starts with a full bucket. Do the same here, and make each discovery step
long enough that the bucket is spent inside the warm-up, not inside a measured step.

### A database throttle looks like latency, and then uses Lambda concurrency

A throttled read returns `ProvisionedThroughputExceededException`, and the AWS SDKs "automatically
retry requests that receive this exception". The default is 3 attempts, or 4 for the DynamoDB client
under the 2026 retry behaviour (`AWS_NEW_RETRIES_2026=true`); which one applies to our SDK version is
**not verified**. Two consequences:

1. **A DB throttle first shows as slower requests, not as errors.** Only when the retries run out
   does the client get a 500.
2. **Slower requests use more Lambda concurrency**, because concurrency = RPS × duration. So a DB
   limit can turn into a Lambda limit: a run that throttles in DynamoDB can also show Lambda
   throttles. That is a real effect worth showing, but it must be read correctly: check
   `ReadThrottleEvents` before blaming the concurrency.

`sdk_max_attempts = 1` turns retries off, so a DB throttle becomes a 500 at once and does not
inflate the duration. The default stays at the SDK default, because that is what a real service
does.

### Evidence

CloudWatch, 1-minute: `ConsumedReadCapacityUnits`, `ProvisionedReadCapacityUnits`,
`ReadThrottleEvents`, `ThrottledRequests`. These go into the dashboard and the run gate, next to the
Lambda `Throttles`.

### Cost

RCU-hour about $0.00013 and WCU-hour about $0.00065 in `us-east-1` (from a summary of the pricing
page, **not verified** as list prices). Example (estimate): 500 RCU for one hour costs about $0.07.
Provisioned capacity is charged while it exists, so `/env down` stays the rule after each session.

## Sources

All read on 2026-11-08. The Lambda docs now call standard functions "Event Functions" (since the
Web Functions launch on 2026-10-12).

- Scaling rate (1,000 environments per 10 s per function), the 10 × concurrency RPS limit, and
  the formula `Concurrency = RPS × average duration`:
  https://docs.aws.amazon.com/lambda/latest/dg/scaling-behavior.html and
  https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html. The second page also says
  "500 concurrency every 10 seconds" in another section; the 1,000 figure is the current one.
- Reserved concurrency, the 100 unreserved minimum, provisioned concurrency and its spin-up:
  https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html
- REST API only for API keys and per-client throttling:
  https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html
- Usage plans are best-effort; API keys are not authentication; the key may come from a Lambda
  authorizer: https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-usage-plans.html
  and https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-key-source.html
- API Gateway throttling is a token bucket, clients "may receive `429 Too Many Requests`":
  https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html
- Lambda async invoke retries a 429 "for up to 6 hours by default"; SQS maximum concurrency 2–1,000;
  HTTP API `SQS-SendMessage`:
  https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-error-handling.html,
  https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-scaling.html,
  https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-aws-services-reference.html
- Function URL returns 429 on a throttle (no longer the front door, kept for comparison):
  https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html. The response body is not
  documented — **unverified**, see it on the first run.
- API Gateway returns 500 and does not retry:
  https://docs.aws.amazon.com/lambda/latest/dg/services-apigateway-errors.html
- ALB returns 502:
  https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-troubleshooting.html
- Metrics, 1-minute granularity, throttles not counted as invocations, `Duration` without cold
  start: https://docs.aws.amazon.com/lambda/latest/dg/monitoring-concurrency.html and
  https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html
- `Init Duration` on the `REPORT` line:
  https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html
- DynamoDB on-demand limits and maximum throughput:
  https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode.html and
  https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode-max-throughput.html
- VPC ENI deletion up to 20 minutes:
  https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html
- DynamoDB capacity: switching modes
  https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-switching-capacity-modes.html;
  decreases https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html;
  burst https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/burst-adaptive-capacity.html;
  RCU https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/provisioned-capacity-mode.html;
  throttle retries https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_BatchWriteItem.html
  and https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html;
  warm throughput https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/warm-throughput.html
- Prices: https://aws.amazon.com/lambda/pricing/ ($0.20 per million requests; x86 duration
  $0.0000166667 per GB-second from the page's examples; the arm64 price is **unverified**) and
  https://aws.amazon.com/api-gateway/pricing/
- Managed Instances: https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances.html;
  Web Functions:
  https://aws.amazon.com/blogs/aws/announcing-aws-lambda-web-functions-for-fast-consistent-web-app-performance-anywhere/
