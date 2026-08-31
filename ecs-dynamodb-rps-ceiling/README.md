# ecs-dynamodb-rps-ceiling

Find the request rate at which a Node.js service on ECS Fargate + DynamoDB stops meeting a
class-based SLO — and, the part that actually matters, **prove which resource bound first: the
service or the database.** A ceiling without an attributed cause is a number, not a result.

> **Status — 2026-08-31.** The environment is **live** and has been since `2026-08-29T18:27:55Z`.
> **No load test has run yet.** Capacity is deliberately still at the free-tier 25/25 — **raising it
> is a separate decision** (see Phase 3), and it is now *pinned* in `terraform/dev.tfvars`, which
> outranks the generated `capacity.auto.tfvars`.
>
> The service now **emits its own SLI**: an OpenTelemetry exponential histogram, exported through a
> cluster-wide Grafana Alloy collector, landing in Grafana Cloud as a native histogram. Class
> thresholds are applied at query time, so changing the objective needs no deploy. A Lambda
> heartbeat generates traffic every minute, so an error budget accrues between load tests.
>
> Measured 2026-08-31 with nothing running: **SLI = 0.99874** against a 99% objective.

## The SLI, and the two numbers that are not the same

The SLO is the **service-side** figure: the proportion of requests meeting their own class
threshold, measured from the first line of the request callback to the response's `finish` event.
It is emitted continuously and does not depend on a k6 run having happened.

A k6 run reports a *different* number — client-side, including Frankfurt RTT and ALB queueing. Both
legitimately answer "did it meet the SLO", and `results.md` therefore has two columns,
`k6 attainment` and `service attainment`. Never record one number in both.

```bash
# the SLI, as the alert rules compute it (needs a READ-capable Grafana token;
# K6_PROMETHEUS_RW_* is write-scoped and cannot query)
PROXY="$GRAFANA_URL/api/datasources/proxy/uid/grafanacloud-prom/api/v1"
curl -s -H "Authorization: Bearer $GRAFANA_AUTH" --data-urlencode 'query=<the class-ratio query>' "$PROXY/query"
```

**Two things to know before reading any number from it:**

- **The population is classified traffic only** (`class=~"fast|standard|heavy"`). The ALB is
  internet-facing, and scanner 404s on unmatched paths were 68% of the idle population — every one
  counted as an SLO violation until the population was restricted. A route added to `handlers.js`
  without a `slo.yaml` entry is silently unmeasured; that is the safe direction, but it is a
  direction.
- **Idle and under-load measure different regimes.** At ~4 req/min the fast class sits at 98.3%
  against its 50 ms threshold, because DynamoDB connections go cold between heartbeats and
  `GetItem` peaks at 105 ms. Sustained load keeps them warm. Do not read an idle dip as a
  regression.

---

## Where everything lives

| what | where | notes |
|---|---|---|
| **Service (ALB)** | http://ecs-dynamodb-rps-ceiling-1443343290.eu-central-1.elb.amazonaws.com | plain HTTP, internet-facing |
| **Terraform Cloud** | https://app.terraform.io/app/failwin/workspaces/ecs-dynamodb-rps-ceiling | org `failwin`, project `high-load-test`, **local** execution — state only |
| **Grafana Cloud** | https://k0valchuk.grafana.net | stack root |
| **Grafana Cloud k6** | https://k0valchuk.grafana.net/a/k6-app/projects/8474786 | where cloud run results land |
| **ECS service** | https://eu-central-1.console.aws.amazon.com/ecs/v2/clusters/ecs-dynamodb-rps-ceiling/services?region=eu-central-1 | 1 task, 0.25 vCPU / 512 MB |
| **DynamoDB table** | https://eu-central-1.console.aws.amazon.com/dynamodbv2/home?region=eu-central-1#table?name=ecs-dynamodb-rps-ceiling | metrics tab is the one to watch |
| **CloudWatch logs** | https://eu-central-1.console.aws.amazon.com/cloudwatch/home?region=eu-central-1#logsV2:log-groups | log group `/ecs/ecs-dynamodb-rps-ceiling`, 1-day retention |
| **ECR** | https://eu-central-1.console.aws.amazon.com/ecr/repositories/private/042945885621/ecs-dynamodb-rps-ceiling?region=eu-central-1 | `:latest` only |

AWS account `042945885621`, region `eu-central-1`. Console links are constructed from the region
and resource names; the ALB, Terraform Cloud and Grafana values come from `terraform output` and
`.env`.

**No Grafana dashboard exists yet.** `grafana/alerts.tf` is written but has never been applied and
no Grafana provider is wired — see *Known gaps*. Until that changes, "check Grafana" means the k6
results page above, and everything else is read from CloudWatch or the service's own `/stats`.

### Service endpoints

| endpoint | work | class | threshold |
|---|---|---|---|
| `GET /healthz` | none — **never touches DynamoDB** | — | — |
| `GET /items/:pk/:sk` | `GetItem` | fast | < 50 ms |
| `POST /items` | `PutItem` under a `w#` prefix | fast | < 50 ms |
| `GET /feeds/:pk` | `Query`, 20 items | standard | < 200 ms |
| `POST /reports` | `Query` 20 + `pbkdf2` + `PutItem` | heavy | < 800 ms |
| `GET /stats` | event-loop lag, **windowed** | — | — |

Traffic runs at a **frozen 55/15/25/5** mix (read/write/feed/report). Every number this project
produces is stated *at that mix*; change it and every recorded figure is void.

---

## Phase 0 — Setup (done once; already done)

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
npm test                                  # 52 unit tests
docker compose -f docker-compose.test.yml up -d
DYNAMO_ENDPOINT=http://localhost:8000 npm run test:integration   # 9 more
docker compose -f docker-compose.test.yml down
```

Integration tests **skip** unless `DYNAMO_ENDPOINT` is set, so a bare `npm test` is green.

---

## Phase 1 — Check current state

Run this before and after every phase. It is read-only and generates no load.

```bash
BASE=$(terraform -chdir=terraform output -raw base_url)

curl -fsS "$BASE/healthz"                                    # {"ok":true}, and NO Server-Timing
curl -fsS -D- -o/dev/null "$BASE/feeds/feed-07" | grep -i server-timing
curl -fsS "$BASE/stats" | jq .
aws ecs describe-services --cluster ecs-dynamodb-rps-ceiling \
  --services ecs-dynamodb-rps-ceiling \
  --query 'services[0].[runningCount,desiredCount,pendingCount]' --output text
aws dynamodb describe-table --table-name ecs-dynamodb-rps-ceiling \
  --query 'Table.ProvisionedThroughput' --output table
```

**What good looks like:** `/healthz` returns no `Server-Timing` header at all (that absence is the
proof it did no DB work); `/feeds/…` carries `db`, `cpu` and `app`; the service is
`running=1 pending=0`; the ALB target is `healthy`.

**Confirm the seed is intact** — every partition must hold exactly 20 items, or the feed `Query`
stops costing 2.5 RCU and the capacity model is wrong:

```bash
curl -fsS "$BASE/feeds/feed-49" | jq .count      # must be 20
```

---

## Phase 2 — Run a load test

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

### Mandatory 6-minute drain before *every* run

DynamoDB banks unused capacity for ~300 s. A run starting from a partly-drained burst bucket is
not comparable to one starting full. **A run performed without the drain must not be recorded.**

```bash
echo "draining; started $(date -u +%H:%M:%S)"; sleep 360
```

### The three shapes

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

---

## Phase 3 — Check state, and attribute the ceiling

**This is the deliverable.** `ThrottledRequests` is the discriminator: it is measured inside
DynamoDB, so the Node event loop cannot contaminate it.

| `ThrottledRequests` | `SuccessfulRequestLatency` | `el_delay_p99` | bound |
|---|---|---|---|
| **zero** | flat | **climbing** | **service** |
| **rising** | **climbing** | flat | **database** |
| rising | climbing | climbing | both — ceilings too close; re-check the CPU calibration |
| zero | flat | flat | neither — the knee is elsewhere (ALB, generator, network) |

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

**Do not read `db_ms` on its own.** It is wall-clock around an `await`, so it absorbs event-loop
queueing — measured, it inflated **12.1×** (10.9 ms → 131.9 ms) with the database unchanged.
Its value is the *gap*:

```
queueing_delay ≈ db_ms − SuccessfulRequestLatency
```

A widening gap with `ThrottledRequests` at zero is the strongest evidence of a **service** ceiling
— it compares two independent clocks instead of trusting one absolute number.

**Throttling shows up as latency before it shows up as errors.** The SDK retries with backoff and
those retries sit *inside* `db_ms`. Always check `ThrottledRequests` before blaming the service.

---

## Phase 4 — Improve: scale the service out (1 → 4 tasks)

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

---

## Phase 5 — Check state, then re-measure identically

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

---

## Phase 6 — Improve: raise database capacity

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

---

## Phase 7 — Check state and re-measure again

Drain 6 minutes, re-run B and C, attribute again. Both constraints should now be released; record
the new ceiling and the new $/hour.

---

## Phase 8 — Record the results

Every number must come from a run in this session, quoted with the k6 output or CloudWatch query
that produced it. No remembered figures, no extrapolation.

Per run: RPS achieved, **bound resource and its evidence**, SLO attainment, error budget burned,
burn-rate multiple, p95/p99 by class, `db_ms`/`cpu_ms`/`app_ms`, event-loop lag,
`ThrottledRequests`, provisioned RCU/WCU, $/hour, and the one change distinguishing it from the
previous run.

A result is never written as "N RPS". It is **"N RPS at the 55/15/25/5 mix"**, with the bound
resource named.

---

## Phase 9 — Scale down and tear out

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

- **Idle now (25/25):** ~**$0.041/hr** → ~$0.99/day → ~$30/month. 25/25 sits exactly at the free
  tier (25 × 744 h = 18,600 unit-hours), so it is free unless other DynamoDB capacity in the
  account already consumed it.
- **At 1025/200:** ~**$0.35/hr** → ~$234/month.

**The forgotten environment, not the load test, is the cost risk.** Prices are never typed from
memory — they live in `pricing.json` with the query that produced them.

---

## Known gaps

- ~~**No Grafana dashboard.**~~ Resolved 2026-08-31. `grafana/` is a Terraform module; the alert
  rules are generated, applied, scoped by `job` and `class`, and all four evaluate (`health=ok`).
  A burn alert was driven to `firing` and reverted, so the path is proven rather than assumed.
- ~~**`/slo` has no generation script.**~~ Resolved 2026-08-31. `npm run slo:generate` /
  `slo:check` render the k6 thresholds, the capacity tfvars, the collector class map, the alert
  rules and the SLO's own objective from `slo.yaml`. Fidelity was proven by regenerating the
  committed outputs and requiring them back byte for byte.
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
