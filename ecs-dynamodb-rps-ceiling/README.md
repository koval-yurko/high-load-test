# ecs-dynamodb-rps-ceiling

Organised around the questions a reader arrives with, from "is it up?" down to "how do I run it
myself?" Every Grafana link opens the live [attribution dashboard](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution)
at the last 6 hours — widen the range in Grafana if you're looking further back.

---

## 1. What is this?

A Node.js service on AWS ECS Fargate, backed by a provisioned-capacity DynamoDB table, in
`eu-central-1`. It exists to answer two questions with evidence rather than a guess: **at what
request rate does the latency SLO start breaking, and was DynamoDB refusing requests when it did?**
Nothing computes a verdict from those two — a person reads them side by side.

Four endpoints are graded against three latency classes (fast / standard / heavy) and driven at a
fixed 55/15/25/5 read/write/feed/report mix. The method is: find the breaking point, release **one**
constraint (first service capacity, then database capacity), re-measure. Never both at once, or the
comparison is worthless.

The service emits its own latency measurement continuously to Grafana Cloud, and a Lambda heartbeat
keeps a trickle of traffic flowing once a minute — so "are we meeting the SLO" does not depend on a
load test having just run.

**Cost while idle:** about **$0.055/hour**. See [Cost](#cost).

---

## 2. Is the service up?

| check | panel |
|---|---|
| Is the ECS task running? | [ECS LiveTaskCount](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=12&from=now-6h&to=now) |
| Is the load balancer routing to it? | [ALB HealthyHostCount](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=17&from=now-6h&to=now) |
| Is traffic arriving, and answered? | [ALB RequestCount](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=14&from=now-6h&to=now) and [HTTP status codes](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=16&from=now-6h&to=now) |

**Good:** `HealthyHostCount` equals the desired task count (1 normally, 4 if autoscaling has scaled
out) and the status panel is almost all 2XX. The stray 4XX are internet scanners hitting paths that
don't exist.

**Bad:** `HealthyHostCount` at 0, or a run of 5XX. Before blaming the service, check the throttle
panel in [§5](#5-what-is-the-bottleneck-right-now) — when DynamoDB throttles, the SDK's retry backoff
happens *inside* the Node process and can fail the health check for a database-side reason.

---

## 3. Are we meeting the SLO?

Panel: [SLI ratio](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=19&from=now-6h&to=now)
— the proportion of requests meeting their class threshold (fast < 50 ms, standard < 200 ms,
heavy < 800 ms). A request only counts as meeting it if it also succeeded: a **5xx is a miss however
fast it was**, which is the same rule k6's `slo_met` applies, so the two attainment columns in
results.md measure the same thing. A 4xx is not a miss — a client error is not charged to the
service (decided 2026-09-02, recorded in `slo.yaml`).

**The continuous line is informational, not the verdict.** Between load tests the only traffic is a
1/min heartbeat, so a single slow request moves the hourly figure by more than a point. **Authoritative
attainment is run-scoped** — measured over a load run's own window, which is what results.md records
and what this project exists to produce.

**Good during a run:** above 99%.

**Good at idle:** roughly 98–99%, and not a service problem. About 3% of idle requests pay a fresh
TLS handshake to DynamoDB because the connection was reaped while unused; under sustained load that
cannot happen. Measured 2026-09-01, the fast class: p95 of 31.9 ms and 96.67% attainment at idle,
against p95 of 4.8 ms and 99.43% at 60 rps. This is a known, accepted defect, recorded in
`docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-slo-scope-design.md`.

**Bad:** the line dips below 99% *during a load run*.

One thing to know: this number is **server-side**, measured from the first line of the request
handler to the response finishing. It excludes network time between client and load balancer, so it
reads higher than what a k6 run reports for the same traffic. Both are legitimate — results.md
records them as two separate columns rather than reconciling them.

---

## 4. How much error budget is left?

Page: [SLO app](https://k0valchuk.grafana.net/a/grafana-slo-app/slos)

Error budget is the allowance for missing the objective: at 99%, up to 1% of requests in the window
may exceed their class threshold before the SLO is broken. The window is **7 days** — that was
forced, not chosen: Grafana's SLO API only accepts 7–32 days and the free tier only keeps metrics
for 14.

**Do not expect this near 100% between load tests, and do not read that as an incident.** For the
reason in [§3](#3-are-we-meeting-the-slo), the idle traffic population is too small to judge the
objective against, and the 7-day figure has been in breach since before the first load run.

**What is worth acting on** are the burn-rate alerts below. They watch the *rate* of spend over 14
and 84 minutes, not the 7-day total, so the depressed headline number does not affect them.

---

## 5. What is the bottleneck right now?

Two questions, two metrics, read side by side. Nothing here computes a verdict.

| question | where to look | what it means |
|---|---|---|
| **How long is the endpoint taking?** | [SLI ratio](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=19&from=now-6h&to=now) and the latency panels | the server-side request duration the SLO is computed from |
| **Was DynamoDB rejecting us?** | [Throttle events](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=2&from=now-6h&to=now) — read and write, plotted separately | non-zero means DynamoDB refused requests and the SDK retried them with backoff |

- Latency up **and** throttles non-zero → the database was the constraint. The knob is capacity.
- Latency up **and** throttles at zero → it wasn't. Look at the service.

**Read the throttle panel first, and judge nothing about the service while it is non-zero.** Retry
backoff happens inside the Node process, so every service-side signal turns red for a database-side
cause. Measured 2026-09-01 at 250 rps against 25 RCU: the service's own database timing read
642–938 ms while DynamoDB's own clock read 0.9–2.2 ms, and event-loop utilization pinned at 1.000
with CPU at 3–16%.

**And the trap in the other direction:** DynamoDB's own latency metric *falls* when the table
throttles (0.887 ms mid-throttle against 1.473 ms idle), because rejected requests are never served
and never enter the statistic. Flat or falling DynamoDB latency is not evidence of a healthy database.

When throttles are at zero and the service still looks slow, three more panels help:
[event-loop delay per task](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=24&from=now-6h&to=now)
(per-task, which is what makes a 1→4 scale-out decision visible), and consumed-vs-provisioned
capacity for [reads](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=7&from=now-6h&to=now)
and [writes](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=8&from=now-6h&to=now),
which show the headroom left before throttling starts.

**A caveat that looks like a bug and isn't:** the queueing-delay panel shows `NaN` for any route with
no traffic in the last 60 seconds — a 0/0 average, common at idle. Widening the dashboard time range
does not fix it; only traffic does.

---

## 6. Is it about to break?

Page: [alert rules](https://k0valchuk.grafana.net/alerting/list)

Rather than waiting seven days for the window to close, six rules watch how fast the budget is being
spent right now — a fast-burn and a slow-burn rule for each of three objectives: latency primary
(99% meet their class threshold), latency tail (99.9% meet three times it), and availability
(99.9% are not 5xx):

- **Fast burn (14.4× over 14 minutes)** — at this rate the whole budget is gone in ~12 hours. Means
  *something just broke, hard, right now.*
- **Slow burn (6× over 84 minutes)** — budget gone in a little over a day. Means *we're bleeding
  steadily and it needs fixing, but nothing is on fire this second.*

A seventh rule, **SLI absent**, fires when no SLI sample has arrived for ten minutes. It exists
because every burn rule treats "no data" as OK — correctly, since no traffic is not a burn — which
means a dead heartbeat, a stopped collector or a broken export leaves all six silent and the
dashboard flat, and both look healthy. This rule is what separates *quiet* from *blind*. When it
fires, the service is not slow; the measurement has stopped, and nothing else on this page can be
trusted until it clears.

All seven route to the stack's existing Slack contact point, named on each rule rather than
inherited from the default policy, so a `terraform plan` shows where they go.

**How long they actually take**, measured 2026-09-01 by overloading the service for six minutes:

| | fast burn | slow burn |
|---|---|---|
| load starts → firing | **4m 01s** | ~6m |
| load stops → clear | **16m** | ~84m |

Two things that surprise people. Recovery is measured from the last bad sample, not the last request
— the service kept emitting breached latencies for ~3.5 minutes after load stopped while it drained
its backlog. And the slow-burn rule keeps firing for over an hour after a six-minute incident, as its
84-minute window rolls off. "Still firing" is not evidence that anything is still wrong.

---

## 7. What did the last load test show?

**Nothing has been measured yet** — no load test has been run against this environment and
`results.md` does not exist. Every number this project reports must come from a k6 run or Grafana
query executed in the same session that reports it; remembered or extrapolated figures are not
allowed. What a run records is [Phase 8](#phase-8--record-the-results).

---

## 8. Appendix — running it yourself

The operator runbook. Read sections 1–7 first if you want to understand the project rather than
operate it.

### Where everything lives

| what | where |
|---|---|
| **Service URL** | `terraform -chdir=terraform output -raw base_url`, or `BASE_URL` in the root `.env` — **deliberately not in this repo** |
| **Terraform Cloud** | https://app.terraform.io/app/failwin/workspaces/ecs-dynamodb-rps-ceiling |
| **Grafana dashboard** | https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution |
| **Grafana Cloud k6** | `https://k0valchuk.grafana.net/a/k6-app/projects/<id>` — the three uploaded tests and every run result. **The id changes on every apply**; get it from `terraform -chdir=terraform output -raw k6_project_id`, which is also the source of truth for `K6_CLOUD_PROJECT_ID` in `.env`. `8474786` was the hand-made project that preceded `docs/k6-project-as-code.md`. |
| **ECS service** | https://eu-central-1.console.aws.amazon.com/ecs/v2/clusters/ecs-dynamodb-rps-ceiling/services?region=eu-central-1 |
| **DynamoDB table** | https://eu-central-1.console.aws.amazon.com/dynamodbv2/home?region=eu-central-1#table?name=ecs-dynamodb-rps-ceiling |
| **CloudWatch logs** | log group `/ecs/ecs-dynamodb-rps-ceiling`, 1-day retention |

AWS account `042945885621`, region `eu-central-1`.

### Service endpoints

| endpoint | work | class | threshold |
|---|---|---|---|
| `GET /healthz` | none — never touches DynamoDB | — | — |
| `GET /items/:pk/:sk` | `GetItem` | fast | < 50 ms |
| `POST /items` | `PutItem` | fast | < 50 ms |
| `GET /feeds/:pk` | `Query`, 20 items | standard | < 200 ms |
| `POST /reports` | `Query` + hash + `PutItem` | heavy | < 800 ms |

Traffic runs at a **frozen 55/15/25/5** mix. Every number this project produces is stated *at that
mix*; change it and every recorded figure is void.

The table is seeded with 1,000 items across 50 feed partitions, 20 each.

### Phase 0 — Setup (done once; already done)

```bash
cp .env.example .env          # AWS, Terraform Cloud, Grafana, k6 tokens
cd ecs-dynamodb-rps-ceiling
npm ci
terraform -chdir=terraform init
```

`.env` must carry `TF_CLOUD_PROJECT=high-load-test` and `TF_WORKSPACE=ecs-dynamodb-rps-ceiling` —
without them `terraform init` silently creates the workspace in the org's *default* project.

Then, once approved: `terraform apply`, push the image, seed the table.

Tests: `npm test` for unit tests. Integration tests need a local DynamoDB and **skip silently**
without one, so a bare `npm test` is green either way:

```bash
docker compose -f docker-compose.test.yml up -d
DYNAMO_ENDPOINT=http://localhost:8000 npm run test:integration
docker compose -f docker-compose.test.yml down
```

### Phase 1 — Is it alive?

```bash
BASE=$(terraform -chdir=terraform output -raw base_url)
curl -fsS "$BASE/healthz"                 # {"ok":true}
curl -fsS "$BASE/feeds/feed-07" | jq .    # a real feed page, 20 items
```

Responses carry no timing data — for where a request spent its time, open the Grafana dashboard
([§5](#5-what-is-the-bottleneck-right-now)). Everything about the infrastructure's shape (task
count, table capacity) is in Terraform; read it there, not from the AWS CLI.

### Phase 2 — Run a load test

**Three shapes, run in this order.** Each has a different job and B and C depend on A's answer:

| shape | file | what it's for |
|---|---|---|
| **A — discovery** | `k6/discovery.js` | Twenty **steps**, 100 → 2000 rps in 100 rps increments, 60 s each, every step its own scenario with its own threshold. **The knee is the lowest step whose threshold breached**; that number is the capacity, and everything else needs it, so this runs first. |
| **B — constant** | `k6/constant.js` | Holds steady at the discovered rate. This is the repeatable baseline — the run you compare before and after an infrastructure change. |
| **C — stress** | `k6/stress.js` | ~3× the discovered rate. Deliberately breaches the SLO and burns error budget, which is how autoscaling and the alerts get tested at all. It has no abort, because aborting would discard the very burn it exists to measure. |

**Two settings must be aligned before the first run.**

**1. Table capacity — `terraform/dev.tfvars`.** Two lines at the top pin the table to 25/25, the
DynamoDB free tier. At that pin the binding constraint is the free tier, not the service: 250 rps
produced 5,588 rejected reads per minute. **A run at 25/25 must not be recorded as an RPS ceiling.**
Delete those two lines so the generated `terraform/capacity.auto.tfvars` (1025 RCU / 200 WCU) takes
over, then `plan` and apply — **approval gate**, and it raises the bill from ~$0.055/hour to
**$0.3212/hour** (~$234/month if left running).

**2. k6 environment variables** — on
[Settings → Environment variables](https://k0valchuk.grafana.net/a/k6-app/settings/environment-variables)
in the k6 app. A run started from the UI passes no flags, so these are the only way it learns them:

| variable | value | when |
|---|---|---|
| `BASE_URL` | the service URL | before the first UI run, and again after any apply that recreates the load balancer — the hostname changes |
| `RATE` | the rate discovery measured | after shape A has run; leaving it unset is correct until then |

This page is browser-only — the k6 Cloud API is read-only and Terraform has no resource for it.
With `BASE_URL` unset a run fails immediately and loudly. With `RATE` unset it does **not** fail: B
and C quietly fall back to 50 rps and tag every sample `rate_source=default`. That tag is the only
thing marking such a run as not a capacity measurement.

**Wait 6 minutes before every run.** DynamoDB banks unused capacity for about 300 seconds, so a run
starting from a partly-drained burst bucket is not comparable to one starting full. **A run performed
without the drain must not be recorded.**

Then start the run from the k6 app —
`https://k0valchuk.grafana.net/a/k6-app/projects/$(terraform -chdir=terraform output -raw k6_project_id)`.
When discovery finishes, open its thresholds. Each step has one, named `slo_met{scenario:rps_N}`,
and k6 reports a threshold as **breached**, not passed — in the summary export the boolean is `true`
when it was crossed. **The knee is the lowest `rps_N` whose threshold breached, and `RATE` for B and
C is the step before it.** With 100 rps steps that is the knee to within 100 rps, which is the
resolution every recorded figure carries.

Why steps and not a ramp: k6 evaluates a threshold over every sample since the test began, so on a
continuous ramp the cumulative figure crosses 99% long after the real knee — ten good minutes dilute
the misses — and reading the rate at abort time overstated capacity by however long that took. One
scenario per step gives each rate its own population and its own verdict. The cumulative `slo_met`
abort is still in the script, but only as a stop so a clearly broken service does not run all
twenty steps; it is not the measurement.

If no step breached, the ceiling is above 2000 rps — raise `MAX_RATE` and re-run rather than
reporting 2000 as the answer.

**Running from a terminal instead** needs neither settings-page value; `-e` wins over everything:

```bash
set -a; source ../.env; set +a     # .env has no `export`; without this the vars never reach k6
k6 cloud run -e BASE_URL="$BASE_URL" -e RATE=<knee> k6/constant.js
echo "exit=$?"                     # 0 = the gates held, 99 = one of them breached
```

Capture that exit code on the k6 line itself — behind a pipe you get the pipe's status instead.
**Four thresholds decide the exit code:** `slo_met` (99% meet their class threshold), `slo_met_tail`
(99.9% meet three times it), `http_req_failed` (error rate under 0.1%), and `dropped_iterations`
(zero — a run that ran out of virtual users delivered less than `RATE` and must not be recorded as a
measurement at `RATE`). The per-class p99 lines in the summary are **reported only**: k6 has no
non-gating threshold, so they are written as `p(99)>=0` to appear in the output without being able
to fail it. All runs go from Frankfurt, the same city as the region, so network round-trip is not
charged against the latency budget.

### Phase 3 — Read the result

All in Grafana, no CLI. Set the dashboard time range to the run's window.

| question | where |
|---|---|
| What rate did we reach, and did the SLO hold? | the k6 run result, in the project at `output -raw k6_project_id` — client-side view |
| Did the SLO hold, server-side? | [SLI ratio](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=19) |
| **Was DynamoDB rejecting us?** | [throttle events](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=2) — read this first |
| How much capacity headroom was left? | [read](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=7) and [write](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=8) capacity |
| Was the service itself the limit? | [event-loop delay per task](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=24) |
| Did the burn-rate alerts fire? | [alert rules](https://k0valchuk.grafana.net/alerting/list) |
| How much budget did it cost? | [SLO app](https://k0valchuk.grafana.net/a/grafana-slo-app/slos) |

Both traps in [§5](#5-what-is-the-bottleneck-right-now) apply here: while throttle events are
non-zero, no service-side signal is evidence about the service — and a falling DynamoDB latency is
not a healthy database.

### Phase 4 — Improve: scale the service out (1 → 4 tasks)

**One change only.** If Phase 3 already showed non-zero throttle events, skip this and go to Phase 6
— scaling tasks would change nothing, and recording why the order was swapped is itself a result.

```hcl
# terraform/dev.tfvars
autoscaling_enabled = true
```

`terraform -chdir=terraform plan -var-file=dev.tfvars` must show **exactly two resources added**
(the autoscaling target and its CPU policy) and nothing else. Anything more means more than one
thing is changing and the comparison is worthless. Then apply — **approval gate.**

Scale-out cooldown is 30 s, scale-in 120 s: out fast, in slow, so a spike isn't answered and then
un-answered inside one run.

### Phase 5 — Re-measure identically

Wait for the service to stabilise, drain 6 minutes, re-run **B and C unchanged** — same `RATE`, same
scripts, same load zone — and re-read Phase 3. The expected outcome is that throttle events are now
non-zero: the database has become the next constraint, which is what Phase 6 releases.

### Phase 6 — Improve: raise database capacity

Only if Phase 5 left throttle events non-zero. Raising capacity that isn't the constraint spends
money and proves nothing.

Capacity comes from the model, never a hand-typed number: raise `target_rps` in `slo.yaml` and
regenerate `terraform/capacity.auto.tfvars` with `/slo`. Confirm the plan is an **in-place** capacity
change — if it proposes to *replace* the table, stop, the seeded data would be lost. Then apply —
**approval gate.**

### Phase 7 — Re-measure again

Drain 6 minutes, re-run B and C, read Phase 3 again. Both constraints should now be released. Record
the new ceiling and the new $/hour.

### Phase 8 — Record the results

Append one row per run to `results.md` (the `/loadtest` skill does this, including for a run started
from the UI — it reads the result from the k6 API). Every number must come from a run in this
session, quoted with the k6 output or Grafana query that produced it. No remembered figures.

A row is only useful if it answers "what was different?" and "what was the limit?", so record:

- **what distinguished this run** from the previous one — the single infrastructure change
- **rate achieved**, and **SLO attainment twice**: client-side from k6, server-side from Grafana
  (they differ by network time, and [§3](#3-are-we-meeting-the-slo) explains why both are kept)
- **p95 / p99 per class**, and error rate
- **error budget burned**, and whether the burn-rate alerts fired
- **peak per-minute read and write throttle events** — a run with throttling measured the database,
  not the service, and the row must say so
- **provisioned RCU/WCU** and **$/hour** at the time of the run

A result is never written as "N RPS". It is **"N RPS at the 55/15/25/5 mix"**.

### Phase 9 — Tear down

```bash
terraform -chdir=terraform destroy -var-file=dev.tfvars     # approval gate

aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=Project,Values=ecs-dynamodb-rps-ceiling \
  --query 'ResourceTagMappingList[].ResourceARN' --output table
```

**A clean destroy is not evidence of a clean account** — hence the sweep. It finds anything tagged
for this project that survived.

One thing it cannot find: once autoscaling has run, Application Auto Scaling leaves two
`TargetTracking-…` CloudWatch alarms that carry no `Project` tag. They normally go with the policy;
check the CloudWatch alarms page if Phase 4 was ever applied.

**Do not delete anything the sweep finds without asking** — a survivor may belong to another project
in this account.

**The k6 project goes down with this destroy too.** As of 2026-09-02 `grafana_k6_project.this`
is managed in `grafana/k6.tf`, so a teardown deletes the project, its uploaded tests and its run
history — and the next `/env up` creates a **new project with a new numeric id**. Three things then
have to be redone by hand, and nothing warns when they are not: re-upload `k6/discovery.js`,
`k6/constant.js`, `k6/stress.js` and set `BASE_URL` / `RATE` on the settings page; reset
`K6_CLOUD_PROJECT_ID` in the root `.env` from `terraform -chdir=terraform output -raw
k6_project_id`; and update the `.../a/k6-app/projects/<id>` links in this file. Full procedure:
`docs/k6-project-as-code.md`.

---

## Cost

| item | rate |
|---|---|
| Fargate 0.25 vCPU + 0.5 GB | $0.0142/hr |
| ALB base | $0.0270/hr |
| ALB LCU | $0.0080/LCU-hr |
| DynamoDB RCU / WCU | $0.0001586 / $0.0007930 per unit-hr |

- **Idle at 25/25 capacity:** about **$0.055/hr** — roughly $40/month. 25/25 sits exactly at the
  DynamoDB free tier, so capacity is free unless other usage in the account already consumed it;
  Fargate and the ALB are billed regardless.
- **At full capacity (1025/200, after Phase 2 or 6):** **$0.3212/hr**, ~$234/month.

**The forgotten environment, not the load test, is the cost risk.** Prices are never typed from
memory — they live in `pricing.json` with the query that produced them.

## Known gaps

- **Terraform does not rebuild the container image.** Any change under `src/` needs an explicit
  build / push / `--force-new-deployment` cycle. This fails silently: the service looks healthy in
  every other respect while the collector receives nothing new.
- **A UI-started run needs `BASE_URL` and `RATE` set by hand first, and nothing can automate it** —
  the k6 Cloud API is read-only and Terraform has no resource for that settings page. Missing
  `BASE_URL` fails loudly; missing `RATE` fails **silently** at 50 rps, marked only by the
  `rate_source=default` tag. (This is about the *settings page* specifically — the k6 project itself
  is a Terraform resource.)
- **The k6 project's id is not stable, and three things must follow it.** Terraform creates the
  project rather than importing one, so every apply produces a new id: `K6_CLOUD_PROJECT_ID` in the
  root `.env`, the `.../a/k6-app/projects/<id>` links below, and the three uploaded scripts all have
  to be redone by hand afterwards. `terraform -chdir=terraform output -raw k6_project_id` is the
  source of truth; the checklist is in `docs/k6-project-as-code.md`.
- **The old hand-made project `8474786` still exists** and is not in Terraform state. Delete it in
  the k6 app once the first Terraform-created project is confirmed working, or two projects named
  `high-load-test` will sit side by side.
- **The SLO window is 7 days and cannot be anything else here.** Grafana's SLO API refuses windows
  outside 7–32 days and the free tier retains metrics for 14. Those two limits leave one usable value.
