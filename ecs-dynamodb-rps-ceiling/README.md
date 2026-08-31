# ecs-dynamodb-rps-ceiling

This README is organised around the questions a reader arrives with, from "is it up?" down to "how
do I run it myself?" Every Grafana link goes to the live [attribution dashboard](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution),
and opens the last 6 hours by default — widen the time range in Grafana if you're looking further
back.

---

## 1. What is this?

A Node.js service running on AWS ECS Fargate, backed by a provisioned-capacity DynamoDB table, in
`eu-central-1`. It exists to answer one question with evidence rather than a guess: **at what
request rate does a class-based latency SLO start breaking, and which resource breaks it — the
service or the database?** Four endpoints are graded against three latency classes (fast/standard/
heavy), traffic is driven at a fixed 55/15/25/5 read/write/feed/report mix, and the project's
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

**Bad reading:** `HealthyHostCount` at 0, or `LiveTaskCount` below desired, or a run of 5XX. That
points at the ECS task, not the database — check the ECS service events and CloudWatch logs
described in the [Appendix](#8-appendix--running-it-yourself).

---

## 3. Are we meeting the SLO?

Panel: [SLI ratio — proportion meeting per-class threshold](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=19&from=now-6h&to=now)

**Good reading:** the line sits above 99% (the primary objective from `slo.yaml`) — green.

**Bad reading:** the line dips below 99%, or below 99.9% at 3× the threshold (the tail
objective) — see [How much error budget is left?](#4-how-much-error-budget-is-left).

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

**Good reading:** budget remaining stays near 100% between load tests; a deliberate stress test
(shape C, below) is expected to burn it — that's what it's for.

**Bad reading:** budget draining outside of a deliberate test means the SLO is being missed in
production-equivalent conditions right now — treat it the same as an active incident.

---

## 5. What is the bottleneck right now?

This is the project's core idea: don't just measure a ceiling, name which resource caused it. Four
panels together answer that, read in this order.

| what you see | what is binding | what to change | panel |
|---|---|---|---|
| `ThrottledRequests` > 0 | DynamoDB is out of provisioned capacity | raise RCU/WCU | [ThrottledRequests (headline)](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=2&from=now-6h&to=now), [read vs write](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=3&from=now-6h&to=now) |
| Throttled = 0, but DynamoDB's own request latency is climbing | DynamoDB itself is slow, independent of capacity headroom | look at item size or a hot partition — this is not something more capacity fixes | [SuccessfulRequestLatency by operation](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=5&from=now-6h&to=now) |
| Throttled = 0, DynamoDB's clock is flat, but the gap between it and the service's own wall-clock is widening, and CPU saturation is heading to 1.0 | the service's CPU or event loop, not the database | scale the service out (1 → 4 tasks) | [DB wall-clock vs DynamoDB's own clock](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=21&from=now-6h&to=now), [Queueing delay by route](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=22&from=now-6h&to=now), [CPU saturation](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=23&from=now-6h&to=now) |
| everything above is flat, but ALB response time is up and `HealthyHostCount` is low | the edge (ALB) or an in-progress deployment | not a capacity story at all — check the deployment, not the database or the service code | [ALB TargetResponseTime](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=15&from=now-6h&to=now), [ALB HealthyHostCount](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=17&from=now-6h&to=now) |

Two more panels feed row three specifically: [Event-loop delay p99 by task](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=24&from=now-6h&to=now)
breaks the CPU story down per task, which is what makes a 1→4 scale-out decision visible — a
single flat aggregate line would hide whether the load is spread evenly. [Read capacity: consumed
vs provisioned](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=7&from=now-6h&to=now)
and its write counterpart ([panel 8](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=8&from=now-6h&to=now))
show how much headroom is left on row one, before throttling starts.

**A caveat that looks like a bug and isn't:** the Queueing delay panel (22) shows `NaN` for any
route that had zero traffic in the selected time window. That's a 0/0 average, not a broken panel.
At idle, the once-a-minute heartbeat only touches each route roughly once a minute, so a short
window can easily miss a given route entirely and show `NaN` for it. Widen the window, or wait for
load — under sustained traffic every route gets samples and the `NaN` resolves on its own.

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

---

## 7. What did the last load test show?

**No load test has been run against this environment yet, and `results.md` does not exist.** This
section will point to it once one has: every RPS, latency, and attainment figure this project
reports must come from a k6 run (or a Grafana query) executed in the same working session that
reports it — remembered or extrapolated numbers are not allowed by this repo's rules. Until a run
happens, there is nothing here to read except "not yet measured."

When a run has happened, `results.md` will record, per run: RPS achieved, the bound resource and
the panel evidence for it (using the table in [§5](#5-what-is-the-bottleneck-right-now)), SLO
attainment, error budget burned, p95/p99 latency by class, and the infrastructure change (if any)
that distinguishes that run from the previous one.

**Read the attainment as two separate columns, not one:** `k6 attainment` is measured client-side
by the load-test tool and includes network round-trip time to the ALB; `service attainment` is the
server-side SLI from [§3](#3-are-we-meeting-the-slo), which excludes that network time. They will
not match, and that is expected — the service figure will typically read as the higher of the two.
Never collapse them into a single number.

---

## 8. Appendix — running it yourself

This is the full operator runbook: nine phases, from first setup through measuring, improving, and
tearing the environment down. Read sections 1–7 above first if you're trying to understand the
project rather than operate it — everything below assumes you already know why each step exists.

### Where everything lives

| what | where | notes |
|---|---|---|
| **Service (ALB)** | http://ecs-dynamodb-rps-ceiling-1443343290.eu-central-1.elb.amazonaws.com | plain HTTP, internet-facing, no TLS |
| **Terraform Cloud** | https://app.terraform.io/app/failwin/workspaces/ecs-dynamodb-rps-ceiling | org `failwin`, project `high-load-test`, **local** execution — state only |
| **Grafana Cloud** | https://k0valchuk.grafana.net | stack root |
| **Grafana attribution dashboard** | https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution | the dashboard linked throughout this README (uid `agbp7d`) |
| **Grafana Cloud k6** | https://k0valchuk.grafana.net/a/k6-app/projects/8474786 | where cloud run results land |
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

The DynamoDB table currently holds 1,000 items spread across 50 partitions (20 items each), at
25/25 provisioned read/write capacity — the free-tier ceiling.

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
curl -fsS -o/dev/null -w '%{http_code}\n' "$BASE/stats"      # 404 -- the endpoint is gone
# No response carries Server-Timing any more. Phase timings live in Grafana:
#   panel 21 (DB wall-clock vs DynamoDB's own clock) and panel 23 (CPU saturation).
aws ecs describe-services --cluster ecs-dynamodb-rps-ceiling \
  --services ecs-dynamodb-rps-ceiling \
  --query 'services[0].[runningCount,desiredCount,pendingCount]' --output text
aws dynamodb describe-table --table-name ecs-dynamodb-rps-ceiling \
  --query 'Table.ProvisionedThroughput' --output table
```

**What good looks like:** `/healthz` answers `{"ok":true}`; `/feeds/…` returns a 20-item summary;
`/stats` returns **404**, because measurement no longer leaves the service over HTTP; the service is
`running=1 pending=0`; the ALB target is `healthy`. To see where a request spent its time, open the
attribution row in Grafana rather than reading a response header — that is the whole point of the
2026-08-31 change.

**Confirm the seed is intact** — every partition must hold exactly 20 items, or the feed `Query`
stops costing 2.5 RCU and the capacity model is wrong:

```bash
curl -fsS "$BASE/feeds/feed-49" | jq .count      # must be 20
```

### Phase 2 — Run a load test

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

#### The three shapes

| shape | file | purpose |
|---|---|---|
| **A — discovery** | `k6/discovery.js` | ramps until the SLO breaks and **aborts at the knee** |
| **B — constant** | `k6/constant.js` | holds at the discovered knee; the repeatable baseline |
| **C — stress** | `k6/stress.js` | ~3× the knee; **supposed to breach** and burn error budget |

B and C **throw** if `RATE` is unset — the knee is measured, never guessed. C has no
`abortOnFail`, because aborting would discard the very budget burn it exists to measure.

Discovery aborts at the knee, so the arrival rate at that instant *is* the capacity number:

```
knee_rps = START_RATE + (MAX_RATE − START_RATE) × (elapsed_seconds / RAMP_SECONDS)
         = 50 + 1950 × (elapsed / 900)
```

If it finishes without aborting, the ceiling is above `MAX_RATE` — raise it and re-run rather
than reporting 2000 as the answer.

### Phase 3 — Check state, and attribute the ceiling

**This is the deliverable.** `ThrottledRequests` is the discriminator: it is measured inside
DynamoDB, so the Node event loop cannot contaminate it. See [§5](#5-what-is-the-bottleneck-right-now)
for the reader-facing version of this table; the CloudWatch queries behind it:

```bash
W="$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ)"; N="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

aws cloudwatch get-metric-statistics --namespace AWS/DynamoDB --metric-name ThrottledRequests \
  --dimensions Name=TableName,Value=ecs-dynamodb-rps-ceiling \
  --start-time "$W" --end-time "$N" --period 60 --statistics Sum --output table

for OP in GetItem PutItem Query; do
  aws cloudwatch get-metric-statistics --namespace AWS/DynamoDB \
    --metric-name SuccessfulRequestLatency \
    --dimensions Name=TableName,Value=ecs-dynamodb-rps-ceiling Name=Operation,Value=$OP \
    --start-time "$W" --end-time "$N" --period 60 --statistics Average Maximum --output table
done
```

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

A widening gap with `ThrottledRequests` at zero is the strongest evidence of a **service** ceiling
— it compares two independent clocks instead of trusting one absolute number.

**Throttling shows up as latency before it shows up as errors.** The SDK retries with backoff and
those retries sit *inside* the wall-clock db time. Always check `ThrottledRequests` before blaming
the service.

### Phase 4 — Improve: scale the service out (1 → 4 tasks)

**One change only.** If Phase 3 attributed the ceiling to the *database*, skip this and go to
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

Re-run the Phase 3 attribution. The expected outcome is that the bound resource has **moved to
the database** — which is what Phase 6 exists for.

### Phase 6 — Improve: raise database capacity

Only if the database now binds. Raising capacity that is not the constraint spends money and
proves nothing.

Capacity comes from the model, never a hand-typed number. Raise `target_rps` in `slo.yaml`, then
regenerate `terraform/capacity.auto.tfvars`:

```
RCU/rps = 0.55×0.5 + 0.25×2.5 + 0.05×2.5 = 1.025
WCU/rps = 0.15×1   + 0.05×1              = 0.200
```

Confirm the plan is an **in-place** capacity change. If it proposes to *replace* the table, stop —
the seeded data would be lost. Then apply — **approval gate.**

### Phase 7 — Check state and re-measure again

Drain 6 minutes, re-run B and C, attribute again. Both constraints should now be released; record
the new ceiling and the new $/hour.

### Phase 8 — Record the results

Every number must come from a run in this session, quoted with the k6 output or CloudWatch query
that produced it. No remembered figures, no extrapolation.

Per run: RPS achieved, **bound resource and its evidence**, SLO attainment, error budget burned,
burn-rate multiple, p95/p99 by class, `db_wall_avg_by_route`/`cpu_seconds_per_second`, event-loop lag,
`ThrottledRequests`, provisioned RCU/WCU, $/hour, and the one change distinguishing it from the
previous run.

A result is never written as "N RPS". It is **"N RPS at the 55/15/25/5 mix"**, with the bound
resource named.

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
- **The SLO window is `7d` and cannot be anything else here.** Grafana's SLO API refuses windows
  outside 7–32 days; Grafana Cloud Free retains metrics for 14. Those two limits leave one usable
  value.
- **`traffic_source` is bounded in the service, not the collector.** Recording a raw user-agent
  would put unbounded cardinality on a public ALB. Adding a new source means editing
  `trafficSource()` in `src/otel.js` and redeploying.
- **Client-side latency measured from a laptop is ~80 ms and is almost all RTT to Frankfurt.**
  Server-side `db` is ~4 ms. Runs originating in-zone will not pay that cost.
- **The `/healthz` no-header assertion** proves "no DB call" only because `health()` calls neither
  `repo` nor `timer.measure`. A future handler that called `repo` *without* wrapping it in
  `timer.measure` would emit no header while hitting DynamoDB, and the test would still pass.

## Reference

- Plan: `docs/superpowers/plans/2026-08-29-ecs-dynamodb-rps-ceiling.md` — task-by-task, with a
  status header listing seven corrections execution uncovered.
- Spec: `docs/superpowers/specs/2026-08-29-ecs-dynamodb-rps-ceiling-design.md` — the binding
  authority for design decisions.
- Capacity/cost chart: `capacity-model.html`.
