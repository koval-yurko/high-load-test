# ecs-dynamodb-rps-ceiling

This README is organised around the questions a reader arrives with, from "is it up?" down to "how
do I run it myself?" Every Grafana link goes to the live [attribution dashboard](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution),
and opens the last 6 hours by default — widen the time range in Grafana if you're looking further
back.

---

## 1. What is this?

A Node.js service running on AWS ECS Fargate, backed by a provisioned-capacity DynamoDB table, in
`eu-central-1`. It exists to answer two questions with evidence rather than a guess: **at what
request rate does a class-based latency SLO start breaking, and was DynamoDB refusing requests
when it did?** Nothing computes a verdict from those two — a person reads them side by side.
Four endpoints are graded against three latency classes (fast/standard/heavy), traffic is
driven at a fixed 55/15/25/5 read/write/feed/report mix, and the project's
method is to find that breaking point, release one constraint at a time (more service capacity,
then more database capacity), and re-measure — never both at once, or the comparison is worthless.

The service emits its own Service Level Indicator continuously (an OpenTelemetry histogram sent to
Grafana Cloud), so "are we meeting the SLO" does not depend on a load test having just run — a
Lambda heartbeat keeps traffic flowing once a minute even when nobody is testing.

**Running cost right now, idle:** approximately **$0.055/hour** (Fargate task + ALB base + ALB LCU
+ DynamoDB provisioned capacity at 25 RCU/25 WCU, which is within the AWS free tier). See
[Cost](#cost) below for the breakdown and source.

---

## 2. Is the service up?

| check | panel |
|---|---|
| Is the ECS task running and healthy? | [ECS LiveTaskCount](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=12&from=now-6h&to=now) |
| Is the load balancer routing to it? | [ALB HealthyHostCount](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=17&from=now-6h&to=now) |
| Is traffic reaching it, and is it answering? | [ALB RequestCount](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=14&from=now-6h&to=now) and [HTTP status codes](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=16&from=now-6h&to=now) |

**Good reading:** `HealthyHostCount` equals the desired task count (normally 1; 4 if autoscaling
has scaled out), and the status-code panel is almost entirely 2XX — the only traffic besides the
heartbeat is internet scanners hitting unmatched paths, which the ALB returns as 4XX, not 5XX.

**Bad reading:** `HealthyHostCount` at 0, or `LiveTaskCount` below desired, or a run of 5XX. The
task is failing its health check — check the ECS service events and CloudWatch logs described in the
[Appendix](#8-appendix--running-it-yourself). Check the throttle-events panel alongside them rather
than reading this as the task's own fault: on 2026-09-01, SDK retry backoff on a throttled DynamoDB
call pinned event-loop utilisation at 1.000 with CPU at 3–16%, and a saturated event loop fails
health checks too.

---

## 3. Are we meeting the SLO?

Panel: [SLI ratio — proportion meeting per-class threshold](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=19&from=now-6h&to=now)

**Read this before reading the number.** The SLO is defined over **load-bearing traffic**. This
continuous line is *informational* — between load tests the only traffic is a 1/min heartbeat, and a
99% objective over ~60 fast-class requests an hour permits 0.6 misses per hour. One slow request
moves the hourly figure by 1.7 points. **Authoritative attainment is run-scoped**, over a load run's
own window — that is what [results.md](#7-what-did-the-last-load-test-show) records, and it is the
number this project exists to produce. Decision and evidence:
`docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-slo-scope-design.md`.

**Good reading, during or just after a load run:** the line sits above 99% (the primary objective
from `slo.yaml`) — green.

**Good reading, at idle:** roughly 98–99%, and *not* a service problem. Measured 2026-09-01, the
same fast class in two regimes:

| | idle, ~1 req/min | under 60 rps |
|---|---|---|
| p50 | 4.99 ms | 2.99 ms |
| p95 | 31.93 ms | 4.76 ms |
| p99 | 129.41 ms | 15.38 ms |
| meets the 50 ms threshold | 96.67% | **99.43%** |

The whole idle tail is inside the DynamoDB call (`db` p99 equals total p99), and it is not every
request — p50 is 5 ms, so the connection usually survives. About 3.3% of idle fast requests pay a
fresh TLS handshake because the socket was reaped. That is a **known, accepted defect**, recorded in
§5 of the spec above with the conditions that would reopen it. It cannot occur under sustained load.

**Bad reading:** the line dips below 99% *during a load run*, or below 99.9% at 3× the threshold
(the tail objective) — see [How much error budget is left?](#4-how-much-error-budget-is-left).

One thing to know before trusting this number: it is **server-side**. It is measured from the
first line of the request handler to the response's `finish` event, so it excludes network time
between a client and the ALB entirely. That means it reads *higher* than a number you'd measure
from your own laptop, and higher than the client-side `slo_met` rate a k6 run reports for the same
traffic. Both are legitimate answers to "did we meet the SLO" — they are just measuring from
different vantage points, which is why [results.md](#7-what-did-the-last-load-test-show) records
them as two separate columns rather than one.

---

## 4. How much error budget is left?

Panel: [SLO app](https://k0valchuk.grafana.net/a/grafana-slo-app/slos)

Error budget is the allowance for *not* meeting the objective before the SLO is considered broken:
at a 99% objective, up to 1% of requests in the window may miss their class threshold without the
SLO being violated. The window here is **7 days**, not the more familiar 30 — that was forced, not
chosen: Grafana Cloud's SLO API only evaluates windows of 7–32 days, and the free tier only retains
metrics for 14 days, so 7 is the only value that satisfies both.

Two alert rules watch the budget burn rate rather than waiting for the window to close — see
[Is it about to break?](#6-is-it-about-to-break) for what they mean.

**Good reading:** a deliberate stress test (shape C, below) burns budget — that's what it's for.

**Do not expect this to sit near 100% between load tests, and do not read that as an incident.** The
7-day window has been in breach since before the first load run, for the reason in
[§3](#3-are-we-meeting-the-slo): the idle population is ~4 req/min and its noise floor exceeds the
objective. The budget figure is informational for the same reason the SLI is.

**What is still worth acting on:** the two burn-rate rules below. They fire on the *rate* of budget
spend over 14-minute and 84-minute windows, not on the 7-day total, so a depressed headline number
does not degrade them — verified 2026-09-01 by driving them through `firing` and back. A fast-burn
alert outside a deliberate test is a real incident.

---

## 5. What is the bottleneck right now?

Two questions, two metrics, read side by side. Nothing here computes a verdict.

| question | where to look | what it means |
|---|---|---|
| **How long is the endpoint taking?** | [SLI ratio](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=19&from=now-6h&to=now) and the latency panels | the service-side request duration the SLO is computed from |
| **Was DynamoDB rejecting us?** | [Throttle events, read and write](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=2&from=now-6h&to=now) — one line for `ReadThrottleEvents`, one for `WriteThrottleEvents`, plotted separately rather than summed | non-zero means DynamoDB refused requests; the SDK retried them with backoff, inside the service |

Latency up **and** throttle events non-zero → the database was the constraint; the knob is capacity.
Latency up **and** throttle events at zero → it was not; look at the service.

**Read the throttle panel first, and judge nothing about the service while it is non-zero.** When
DynamoDB throttles, the AWS SDK retries with backoff *inside the Node process*, so every service-side
signal turns red for a database-side cause. Measured 2026-09-01 at 250 rps against 25 provisioned RCU,
with DynamoDB rejecting 5,588 reads per minute: the service's own database timing read 642–938 ms
while DynamoDB's own clock read 0.9–2.2 ms, and event-loop utilization pinned at 1.000 with CPU at
only 3–16%. That is why nothing here computes a verdict —
`docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-attribution-simplified-design.md`.

**And a trap in the other direction:** DynamoDB's `SuccessfulRequestLatency` *falls* when the table
throttles — 0.887 ms mid-throttle against 1.473 ms at idle — because rejected requests are never
served and so never enter the statistic. A flat or falling DynamoDB latency is not evidence that
DynamoDB is healthy.

Three more panels are worth reading when throttle events are at zero and the service still looks
slow: [Event-loop delay p99 by task](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=24&from=now-6h&to=now)
breaks the CPU story down per task, which is what makes a 1→4 scale-out decision visible — a
single flat aggregate line would hide whether the load is spread evenly. [Read capacity: consumed
vs provisioned](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=7&from=now-6h&to=now)
and its write counterpart ([panel 8](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=8&from=now-6h&to=now))
show how much headroom is left on provisioned capacity, before throttling starts.

**A caveat that looks like a bug and isn't:** the Queueing delay panel (22) shows `NaN` for any
route that had zero traffic in the last 60 seconds. That's a 0/0 average, not a broken panel. At
idle, the once-a-minute heartbeat touches each route roughly once a minute, so a given 60-second
window frequently misses a route entirely — observed 2026-09-01 flipping between all-`NaN` and real
values across a 20-second gap.

**Changing the dashboard time range does not fix it.** The rate window in panels 21, 22 and 23 is a
literal `[60s]` emitted by `scripts/generate-slo.js`, not `$__rate_interval` — only the SLI ratio
(panel 19) follows the picker. Widening `from=now-6h` to `now-24h` changes which 60-second window
you land on, not its width. The only remedy is traffic: under sustained load every route gets many
samples per window and the `NaN` cannot occur.

---

## 6. Is it about to break?

Panel: [alert rules](https://k0valchuk.grafana.net/alerting/list)

Rather than waiting for the 7-day SLO window to close, four rules watch how fast the error budget
is being *spent* right now, so a bad trend pages before the budget is actually gone. There are two
pairs — one for the 99% primary objective, one for the stricter 99.9% tail objective — and each
pair has a fast-burn and a slow-burn rule:

- **14.4× over 14 minutes** ("fast burn"): if this rate of misses kept up, the entire 7-day budget
  would be gone in about 12 hours. It fires on a short window so a sharp spike (a bad deploy, DynamoDB
  throttling under a spike test) pages quickly, without waiting for a slow trend to prove itself.
- **6× over 84 minutes** ("slow burn"): if this rate kept up, the budget would be gone in a little
  over a day. It fires on a longer window so a milder, sustained degradation — the kind a short
  spike-detector would miss — still gets caught before the budget actually runs out.

In practice: a fast-burn alert means "something just broke, hard, right now." A slow-burn alert
means "we're bleeding budget steadily and need to fix it before the window runs out, but nothing
is on fire this second."

**How long they actually take.** Measured 2026-09-01 by deliberately overloading the service for six
minutes (250 rps against 25 provisioned RCU) and watching the rules walk:

| | fast burn (14.4× / 14m) | slow burn (6× / 84m) |
|---|---|---|
| load starts → `pending` | 1m 49s | 2m 33s |
| load starts → `firing` | **4m 01s** | ~6m |
| load stops → `inactive` | **16m** | ~84m — still firing 22 minutes after |

Two things that surprise people. **Recovery is measured from the last bad sample, not the last
request:** the service kept emitting breached latencies for ~3.5 minutes after the load generator
stopped, because it was still draining a backlog. And **the slow-burn pair keeps firing for over an
hour after a six-minute incident** — that is its 84-minute window rolling off, working as designed,
but it means "still firing" is not evidence that anything is still wrong.

---

## 7. What did the last load test show?

**Nothing has been measured yet: no load test has been run against this environment, and
`results.md` does not exist.** This section will point to it once one has. Every RPS, latency and
attainment figure this project reports must come from a k6 run or Grafana query executed in the same
working session that reports it — remembered or extrapolated numbers are not allowed here. What a run
records, and the two separate attainment columns it records it in, is
[Phase 8](#phase-8--record-the-results).

---

## 8. Appendix — running it yourself

This is the full operator runbook, from first setup through measuring, improving, and tearing the
environment down. Read sections 1–7 above first if you're trying to understand the
project rather than operate it — everything below assumes you already know why each step exists.

### Where everything lives

| what | where | notes |
|---|---|---|
| **Service (ALB)** | `terraform -chdir=terraform output -raw base_url`, or `BASE_URL` in the root `.env` | plain HTTP, internet-facing, no TLS, no auth — **the hostname is deliberately not in this repo** |
| **Terraform Cloud** | https://app.terraform.io/app/failwin/workspaces/ecs-dynamodb-rps-ceiling | org `failwin`, project `high-load-test`, **remote** execution, working directory `terraform` |
| **Grafana Cloud** | https://k0valchuk.grafana.net | stack root |
| **Grafana attribution dashboard** | https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution | the dashboard linked throughout this README (uid `agbp7d`) |
| **Grafana Cloud k6** | https://k0valchuk.grafana.net/a/k6-app/projects/8474786 | project `high-load-test`; holds the three uploaded tests and every cloud run result |
| **ECS service** | https://eu-central-1.console.aws.amazon.com/ecs/v2/clusters/ecs-dynamodb-rps-ceiling/services?region=eu-central-1 | 1 task, 0.25 vCPU / 512 MB |
| **DynamoDB table** | https://eu-central-1.console.aws.amazon.com/dynamodbv2/home?region=eu-central-1#table?name=ecs-dynamodb-rps-ceiling | metrics tab is the one to watch |
| **CloudWatch logs** | https://eu-central-1.console.aws.amazon.com/cloudwatch/home?region=eu-central-1#logsV2:log-groups | log group `/ecs/ecs-dynamodb-rps-ceiling`, 1-day retention |
| **ECR** | https://eu-central-1.console.aws.amazon.com/ecr/repositories/private/042945885621/ecs-dynamodb-rps-ceiling?region=eu-central-1 | `:latest` only |

AWS account `042945885621`, region `eu-central-1`. Console links are constructed from the region
and resource names; the ALB, Terraform Cloud and Grafana values come from `terraform output` and
`.env`.

### Service endpoints

| endpoint | work | class | threshold |
|---|---|---|---|
| `GET /healthz` | none — **never touches DynamoDB** | — | — |
| `GET /items/:pk/:sk` | `GetItem` | fast | < 50 ms |
| `POST /items` | `PutItem` under a `w#` prefix | fast | < 50 ms |
| `GET /feeds/:pk` | `Query`, 20 items | standard | < 200 ms |
| `POST /reports` | `Query` 20 + `pbkdf2` + `PutItem` | heavy | < 800 ms |

Traffic runs at a **frozen 55/15/25/5** mix (read/write/feed/report). Every number this project
produces is stated *at that mix*; change it and every recorded figure is void.

The table is seeded with 1,000 items across 50 feed partitions (20 each) and runs at 25/25
provisioned read/write capacity — the free-tier ceiling. Actual item count drifts above the seed
because the heartbeat's `POST /items` writes land under a `w#` prefix; they never enter a feed
partition, so the feed `Query` keeps costing 2.5 RCU.

### Phase 0 — Setup (done once; already done)

```bash
cp .env.example .env          # fill in AWS, Terraform Cloud, Grafana, k6 tokens
cd ecs-dynamodb-rps-ceiling
npm ci
terraform -chdir=terraform init
```

`.env` must carry `TF_CLOUD_PROJECT=high-load-test` and `TF_WORKSPACE=ecs-dynamodb-rps-ceiling`.
Without them `terraform init` silently creates the workspace in the org's *default* project.

Then, once approved: `terraform apply`, push the image, seed the table.

```bash
npm test                                  # unit tests
docker compose -f docker-compose.test.yml up -d
DYNAMO_ENDPOINT=http://localhost:8000 npm run test:integration   # integration tests
docker compose -f docker-compose.test.yml down
```

Integration tests **skip** unless `DYNAMO_ENDPOINT` is set, so a bare `npm test` is green.

### Phase 1 — Check current state

Run this before and after every phase. It is read-only and generates no load.

```bash
BASE=$(terraform -chdir=terraform output -raw base_url)

curl -fsS "$BASE/healthz"                                    # {"ok":true}
curl -fsS "$BASE/feeds/feed-07" | jq .                       # a real feed page
aws ecs describe-services --cluster ecs-dynamodb-rps-ceiling \
  --services ecs-dynamodb-rps-ceiling \
  --query 'services[0].[runningCount,desiredCount,pendingCount]' --output text
aws dynamodb describe-table --table-name ecs-dynamodb-rps-ceiling \
  --query 'Table.ProvisionedThroughput' --output table
```

**What good looks like:** `/healthz` answers `{"ok":true}`; `/feeds/…` returns a 20-item summary; the
service is `running=1 pending=0`; the ALB target is `healthy`. Responses carry no timing data at all —
to see where a request spent its time, open Grafana: row 1 *Latency and DynamoDB throttling*, then
panel 21 (DB wall-clock vs DynamoDB's own clock) and panel 23 (CPU saturation).

**Confirm the seed is intact** — every partition must hold exactly 20 items, or the feed `Query`
stops costing 2.5 RCU and the capacity model is wrong:

```bash
curl -fsS "$BASE/feeds/feed-49" | jq .count      # must be 20
```

### Phase 2 — Run a load test

**Capacity is still pinned to the 25/25 free tier** by two lines at the top of
`terraform/dev.tfvars`. At that pin the binding constraint is the DynamoDB free tier, not the service
— measured 2026-09-01, 250 rps drove 5,588 rejected reads/minute. **A run at 25/25 must not be
recorded as an RPS ceiling.** Delete those two lines so the generated `capacity.auto.tfvars`
(1025/200) applies, then `plan` and apply — **approval gate**, and it raises the bill from
~$0.055/hour to **$0.3212/hour** (~$234/month if forgotten). That is Task 1 of
`docs/superpowers/plans/2026-09-02-ecs-dynamodb-rps-ceiling-scale-and-measure.md`, which is the
authoritative version of everything from here to Phase 9.

All runs go through Grafana Cloud k6 from **Frankfurt** (`amazon:de:frankfurt`), same city as
`eu-central-1`, so RTT is not charged against the latency budget.

```bash
cd ecs-dynamodb-rps-ceiling
BASE=$(terraform -chdir=terraform output -raw base_url)

k6 cloud run -e BASE_URL="$BASE" --summary-export=summary.json k6/discovery.js
echo "exit=$?"     # 0 = all thresholds held, 99 = a threshold was breached
```

**Use `-e` flags, not a shell prefix.** `k6 run` honours the shell environment but `k6 inspect`
does not, and `BASE_URL` has no guard — unset, requests silently go to `undefined/…`.

**Capture the exit code on the k6 line itself.** Behind a pipe you get the pipe's status.

#### Mandatory 6-minute drain before *every* run

DynamoDB banks unused capacity for ~300 s. A run starting from a partly-drained burst bucket is
not comparable to one starting full. **A run performed without the drain must not be recorded.**

```bash
echo "draining; started $(date -u +%H:%M:%S)"; sleep 360
```

#### Running from the Grafana Cloud UI — no terminal

Two steps, in this order. **Uploading a script is not enough to run it** — a UI run passes no `-e`
flags, so until step 2 is done the profiles resolve `BASE_URL` to `http://localhost:1` and every
request fails instantly.

**Step 1 — upload the scripts** (terminal, once per script change):

```bash
cd ecs-dynamodb-rps-ceiling
for f in discovery constant stress; do k6 cloud upload k6/$f.js; done
```

This updates each stored test in place — same `options.cloud.name` → same test id — in project
[`high-load-test` (8474786)](https://k0valchuk.grafana.net/a/k6-app/projects/8474786):

| test | id |
|---|---|
| `ecs-dynamodb-rps-ceiling discovery` | 1330768 |
| `ecs-dynamodb-rps-ceiling constant` | 1330772 |
| `ecs-dynamodb-rps-ceiling stress` | 1330773 |

> ### ⚠️ Step 2 — define the environment variables BEFORE running anything
>
> On **[Settings → Environment variables](https://k0valchuk.grafana.net/a/k6-app/settings/environment-variables)**
> in the k6 app, set:
>
> | variable | value | when |
> |---|---|---|
> | `BASE_URL` | `terraform -chdir=terraform output -raw base_url`, or `BASE_URL` from the root `.env` | before the first UI run, and again after any apply that **recreates the ALB** — the DNS name changes |
> | `RATE` | the knee discovery measured | only after shape A has run; leaving it unset is correct until then |
>
> **This is manual and there is no way around it.** The k6 Cloud v5 API is **read-only** — its own
> OpenAPI spec at `api.k6.io/cloud/v5/openapi_spec` lists 24 paths, every one a `GET` — and the
> Grafana Terraform provider has no k6 environment-variable resource, so neither a script nor
> `terraform apply` can set these. Only a browser can write to that page.
>
> **Symptoms of skipping it.** With `BASE_URL` unset the run fails immediately with connection
> errors to `localhost:1` — loud, and deliberately so. With `RATE` unset the run does *not* fail: B
> and C fall back to 50 rps and tag every sample `rate_source=default`. **That run is not a capacity
> measurement**, and the tag is the only thing that says so.

**The deployed hostname is deliberately not in this repo.** This repo is public and the ALB is plain
HTTP with no auth, so a hostname in a commit is a hostname anyone can send load to. It lives in the
root `.env` and on that settings page, nowhere else.

**Local runs need neither step.** `-e` wins over everything, so a terminal run supplies its own
values and ignores what the settings page holds:

```bash
set -a; source ../.env; set +a     # .env has no `export`; without this the vars never reach k6
k6 cloud run -e BASE_URL="$BASE_URL" -e RATE=<knee> k6/constant.js
```

`k6 cloud upload` also accepts `-e` and bakes those values into the stored archive, which is an
alternative to the settings page. Two cautions if you use it: a baked value **cannot be read back**
— the API returns only `{"archive": "<hash>.tar"}`, never its contents — and which source wins when
a value is both baked and set on the settings page is **unverified**. Prefer the settings page,
where the value is visible and editable.

A UI run produces **no local `summary.json`**. `/loadtest` reads the run from the k6 Cloud API
instead, so a UI-started run can still be recorded — see the skill for which endpoint it reads.

#### The three shapes

| shape | file | purpose |
|---|---|---|
| **A — discovery** | `k6/discovery.js` | ramps until the SLO breaks and **aborts at the knee** |
| **B — constant** | `k6/constant.js` | holds at the discovered knee; the repeatable baseline |
| **C — stress** | `k6/stress.js` | ~3× the knee; **supposed to breach** and burn error budget |

C has no `abortOnFail`, because aborting would discard the very budget burn it exists to measure.

**B and C used to throw when `RATE` was unset.** They no longer do — a UI-started run passes no `-e`
flags, so a module-scope throw made them impossible to store in the cloud at all. `RATE` now falls
back to the default in `k6/lib/env.js`, and **every sample is tagged `rate_source`**: `explicit` when
a knee was passed, `default` when it was not. **A run tagged `rate_source=default` is not a capacity
measurement and must not be recorded as one** — that tag is what replaced the guard.

Discovery aborts at the knee, so the arrival rate at that instant *is* the capacity number:

```
knee_rps = START_RATE + (MAX_RATE − START_RATE) × (elapsed_seconds / RAMP_SECONDS)
         = 50 + 1950 × (elapsed / 900)
```

If it finishes without aborting, the ceiling is above `MAX_RATE` — raise it and re-run rather
than reporting 2000 as the answer.

### Phase 3 — Check state: how long did it take, and was DynamoDB rejecting us?

Both questions are panels on the attribution dashboard. **Do not shell out to
`aws cloudwatch get-metric-statistics` for them** — Grafana is the one place to look, and the
dashboard queries the same CloudWatch metrics through its own datasource, at full resolution:

| question | panel |
|---|---|
| Was DynamoDB rejecting us? | [DynamoDB throttle events (read and write)](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=2&from=now-6h&to=now) — non-zero means yes |
| How long did DynamoDB itself take? | [SuccessfulRequestLatency by operation](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=5&from=now-6h&to=now) — `GetItem`, `PutItem`, `Query`, Average and Maximum |

Widen the dashboard time range to cover the run; these links open the last 6 hours.

**These panels read CloudWatch directly, and that is deliberate.** The collector also forwards the
same metrics to Prometheus, but that copy is not equivalent: Alloy requests a 300-second window and
CloudWatch aligns its 60-second buckets to the request rather than the wall-clock minute, so a spiky
`Sum` loses its peak. Measured 2026-09-01 over the 250 rps run, `ReadThrottleEvents` peaked at
**5588** natively and only **4360** in the forwarded copy — a 21% understatement of the number this
README reports. Smooth `Average` metrics survive intact, which is why the forwarded copy is still the
right source for the queueing subtraction below. Full reasoning:
`docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-datasource-fidelity-design.md`.

**Do not read `db_wall_avg_by_route` on its own.** It is wall-clock around an `await`, so it absorbs
event-loop queueing. Its value is the *gap*:

```
queueing_delay(route) ≈ db_wall_avg_by_route
                      − Σ SuccessfulRequestLatency over the operations that route issues
```

The subtrahend is **per route**, not one average over the table: `/items/:pk/:sk` → `GetItem`,
`/items` → `PutItem`, `/feeds/:pk` → `Query`, `/reports` → `Query + PutItem`. That mapping is
`attribution.operations` in `slo.yaml`, and `queueing_ms_by_route` in `grafana/queries.json` is
generated from it — do not hand-write this subtraction.

**The two sides of that subtraction are ~2 minutes out of step.** `db_wall_avg_by_route` is emitted
by the service and reaches Grafana via OTLP within seconds; the `SuccessfulRequestLatency` being
subtracted is scraped from CloudWatch by the collector and lands about two minutes later. Measured
2026-09-01, the forwarded series is the native one shifted +2 min with values preserved exactly, so
at steady state the error is hundredths of a millisecond — but at a transition it is as large as the
excursion, worst observed 7.4 ms against a 642–938 ms signal (~1%). Fine for deciding *where* the
queue is; do not read the gap as instantaneous while load is changing.

**Both traps in [§5](#5-what-is-the-bottleneck-right-now) apply to these panels directly** — a
falling `SuccessfulRequestLatency` is not a healthy database, and the service's db timing, event-loop
delay and event-loop utilization are not evidence about the service while throttle events are
non-zero. Read that section before drawing a conclusion from the panels above.

**Throttling shows up as latency before it shows up as errors.** The SDK retries with backoff and
those retries sit *inside* the wall-clock db time. Always check `ReadThrottleEvents` and
`WriteThrottleEvents` before blaming the service.

### Phase 4 — Improve: scale the service out (1 → 4 tasks)

**One change only.** If Phase 3 already showed non-zero throttle events, skip this and go to
Phase 6 instead — scaling tasks would change nothing, and recording why the order was swapped is
itself a result.

```hcl
# terraform/dev.tfvars
autoscaling_enabled = true
```

```bash
terraform -chdir=terraform plan -var-file=dev.tfvars
```

Expect **exactly two resources added** (`aws_appautoscaling_target.ecs[0]`,
`aws_appautoscaling_policy.cpu[0]`) and nothing else. If anything else appears, more than one
thing is changing and the comparison is worthless. Then apply — **this is an approval gate.**

Scale-out cooldown is 30 s, scale-in 120 s: out fast, in slow, so a spike is not answered and
then un-answered inside one run.

### Phase 5 — Check state, then re-measure identically

Wait for the service to stabilise, drain 6 minutes, then re-run **B and C byte-identically** —
same `RATE`, same scripts, same load zone.

```bash
aws ecs wait services-stable --cluster ecs-dynamodb-rps-ceiling --services ecs-dynamodb-rps-ceiling
sleep 360
k6 cloud run -e BASE_URL="$BASE" -e RATE=<knee> --summary-export=summary.json k6/constant.js
k6 cloud run -e BASE_URL="$BASE" -e RATE=<knee> --summary-export=summary.json k6/stress.js
```

Re-run the Phase 3 checks. The expected outcome is that throttle events are now non-zero — the
database becomes the next constraint to release, which is what Phase 6 exists for.

### Phase 6 — Improve: raise database capacity

Only if the Phase 5 re-run left `ReadThrottleEvents` or `WriteThrottleEvents` non-zero. Raising
capacity that is not the constraint spends money and proves nothing — with both at zero over the run
window, DynamoDB was not refusing requests and there is nothing here to release.

Capacity comes from the model, never a hand-typed number. Raise `target_rps` in `slo.yaml`, then
regenerate `terraform/capacity.auto.tfvars`:

```
RCU/rps = 0.55×0.5 + 0.25×2.5 + 0.05×2.5 = 1.025
WCU/rps = 0.15×1   + 0.05×1              = 0.200
```

Confirm the plan is an **in-place** capacity change. If it proposes to *replace* the table, stop —
the seeded data would be lost. Then apply — **approval gate.**

### Phase 7 — Check state and re-measure again

Drain 6 minutes, re-run B and C, and check the two metrics again. Both constraints should now be
released; record the new ceiling and the new $/hour.

### Phase 8 — Record the results

Every number must come from a run in this session, quoted with the k6 output or CloudWatch query
that produced it. No remembered figures, no extrapolation.

Per run: RPS achieved, SLO attainment, error budget burned, burn-rate multiple, p95/p99 by class,
`db_wall_avg_by_route`/`cpu_seconds_per_second`, event-loop lag, the peak per-minute
`ReadThrottleEvents` and `WriteThrottleEvents`, provisioned RCU/WCU, $/hour, and the one change
distinguishing it from the previous run.

A result is never written as "N RPS". It is **"N RPS at the 55/15/25/5 mix"**.

### Phase 9 — Scale down and tear out

```bash
terraform -chdir=terraform destroy -var-file=dev.tfvars     # approval gate
```

**A clean destroy is not evidence of a clean account.** Sweep afterwards:

```bash
aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=Project,Values=ecs-dynamodb-rps-ceiling \
  --query 'ResourceTagMappingList[].ResourceARN' --output table

aws ec2 describe-nat-gateways --filter Name=state,Values=available --output table   # must be none
aws ec2 describe-addresses --query 'Addresses[?AssociationId==null]' --output table
aws logs describe-log-groups --log-group-name-prefix /ecs/ecs-dynamodb-rps-ceiling --output table
```

Once autoscaling has run, Application Auto Scaling leaves two `TargetTracking-…` CloudWatch
alarms that carry **no `Project` tag** and are therefore invisible to the tag sweep. They are
normally removed with the policy — check explicitly.

**Do not delete anything the sweep finds without asking** — a survivor may belong to another
project in this account.

---

## Cost

| item | rate | source |
|---|---|---|
| Fargate 0.25 vCPU + 0.5 GB | $0.0142/hr | Pricing API, eu-central-1 |
| ALB base (excl. LCU) | $0.0270/hr | Pricing API, `Load Balancer-Application` |
| ALB LCU | $0.0080/LCU-hr | Pricing API |
| DynamoDB RCU / WCU | $0.0001586 / $0.0007930 per unit-hr | `pricing.json` |

- **Idle now (25/25):** approximately **$0.055/hr** → roughly $1.32/day → roughly $40/month.
  25/25 sits exactly at the free tier (25 × 744 h = 18,600 unit-hours), so DynamoDB capacity is
  free unless other DynamoDB usage in the account already consumed it — Fargate and ALB are billed
  regardless.
- **At higher provisioned capacity** (after Phase 6): recompute from `pricing.json` and the
  capacity actually applied; do not carry forward a number from a different configuration.

**The forgotten environment, not the load test, is the cost risk.** Prices are never typed from
memory — they live in `pricing.json` with the query that produced them.

## Known gaps

- **Terraform does not rebuild the container image.** Any change under `src/` needs an explicit
  build / push / `--force-new-deployment` cycle. This is easy to forget and fails silently: the
  collector receives nothing from a service that looks healthy in every other respect.
- **A UI-started run needs `BASE_URL` and `RATE` set by hand first, and nothing can automate it.**
  The k6 Cloud v5 API is read-only (24 paths, all `GET`) and the Grafana provider has no k6
  environment-variable resource, so the settings page is browser-only. Uploading a script does not
  carry the values with it. Missing `BASE_URL` fails loudly against `localhost:1`; missing `RATE`
  fails **silently** at 50 rps, marked only by the `rate_source=default` tag.
- **The SLO window is `7d` and cannot be anything else here.** Grafana's SLO API refuses windows
  outside 7–32 days; Grafana Cloud Free retains metrics for 14. Those two limits leave one usable
  value.
- **`traffic_source` classification is fixed but unconfirmed against a real run.** `trafficSource()`
  at `src/otel.js:94` keys on a `k6/` **prefix**, and k6 v1.4.0's own default user-agent is
  `Grafana k6/1.4.0` — which contains `k6/` without starting with it, so both 2026-09-01 runs landed
  under `other`. The profiles now set `userAgent: 'k6/1.4.0'` via `k6/lib/env.js`; this had to be an
  *option* rather than the `--user-agent` CLI flag, because a UI-started run passes no flags. Verify
  a `traffic_source="k6"` series actually appears on the first run — an empty one reads exactly like
  a healthy silence. The label is bounded in the service rather than the collector (a raw user-agent
  would put unbounded cardinality on a public ALB), so adding a source means editing `src/otel.js`
  and redeploying.
- **Client-side latency measured from a laptop is ~80 ms and is almost all RTT to Frankfurt.**
  Server-side `db` is ~4 ms. Runs originating in-zone will not pay that cost.

## Reference

- **Current plan** (everything not yet done — the capacity raise, the discovery run, the before/after
  comparison, teardown): `docs/superpowers/plans/2026-09-02-ecs-dynamodb-rps-ceiling-scale-and-measure.md`.
  It applies inline every amendment the earlier plans accumulated; prefer it over Phases 2–9 above.
- **Design authority**, in force order — the base design
  `docs/superpowers/specs/2026-08-29-ecs-dynamodb-rps-ceiling-design.md`, amended by
  `…/2026-08-30-…-sli-collection-design.md` (the SLI is emitted by the service, not by k6),
  `…/2026-08-31-…-attribution-via-metrics-design.md` (measurement leaves over OTel, not over HTTP),
  `…/2026-09-01-…-attribution-simplified-design.md` (two metrics, no computed verdict) and
  `…/2026-09-01-…-slo-scope-design.md` (the SLO is defined over load-bearing traffic).
  Do not act on the base design's D7 or D10 — both were reversed, and each carries a pointer at the
  decision itself.
- Capacity/cost chart: `capacity-model.html`.
