# ecs-dynamodb-rps-ceiling Observability Shakedown Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the free-tier environment is functional and observable — that every signal the
measurement work will depend on exists, is reachable, and moves in the right direction when the
system is deliberately hurt — **before any money is spent raising capacity**.

**Architecture:** Nothing is built. This plan exercises what the three completed plans already
deployed: four HTTP routes → three OTel exponential histograms → Alloy → Mimir → `grafana_slo` →
four burn-rate rules, plus CloudWatch metrics discovered by the `Project` tag. Its one active step
drives the service into DynamoDB throttling at the **25/25 free-tier capacity**, which is a *known*
answer — that makes it a test of the attribution table rather than a measurement of the service.

**Tech Stack:** Unchanged. Local `k6` 1.4 (not Grafana Cloud k6 — no VU-hours), `curl`, the Grafana
datasource proxy, AWS CLI reads.

**Spec:** none, deliberately. This plan makes no architectural decision; it verifies three that were
already made and approved, in
`docs/superpowers/specs/2026-08-29-ecs-dynamodb-rps-ceiling-design.md`,
`…/2026-08-30-…-sli-collection-design.md` and `…/2026-08-31-…-attribution-via-metrics-design.md`.
Any decision this shakedown *provokes* — a signal that turns out to be wrong, a threshold that turns
out to be unreachable — goes into a new spec, not into this plan.

**Amends:** `docs/superpowers/plans/2026-08-29-ecs-dynamodb-rps-ceiling.md`, whose Tasks 18–23 were
re-homed on 2026-09-01. This plan is new work inserted before them; it numbers its own tasks from 1
and keeps its own SDD ledger at `.superpowers/sdd/2026-09-01-ecs-dynamodb-rps-ceiling-observability-shakedown/`.

---

## Status — **complete**, 2026-09-01

All 7 tasks executed. The goal is met: the signal chain works end to end, and the alerting path is
proven rather than assumed — a burn alert was driven from `inactive` through `pending` to `firing`
and back to `inactive` against real load, with every transition timed.

**It also found what it was built to find.** Task 5 evaluated the attribution table against a case
whose answer was known by construction, and **the table gave the wrong answer** — it named the
service while DynamoDB was rejecting 5,588 reads per minute. Three independent causes, each
sufficient alone; see Task 5's verdict block and findings F5–F8 in the report.

**Consequence: `docs/superpowers/plans/2026-09-02-…-scale-and-measure.md` is blocked.** Its Task 2
Step 5 attributes the discovery run's ceiling with exactly this table. Running it now would produce
a confidently-worded, wrong answer in the project's deliverable. The fix is a new spec amending §5
of the 2026-08-31 design at the decision itself, per `CLAUDE.md` — not an edit to this plan.

**Two other open items surfaced, neither blocking:**

- **The 7-day SLO window is already in breach and was before this session** — `sli_window` 0.98474
  against a 0.99 objective at 08:18Z, with no load running. At ~4 req/min the heartbeat's DynamoDB
  connections go cold and `GetItem` peaks near 105 ms against a 50 ms fast-class threshold. Decide
  what the SLO means at idle before the scale plan starts recording attainment against it.
- **DynamoDB served 2.46× provisioned capacity for six minutes without throttling.** Provisioned
  capacity is not the hard wall the capacity model treats it as, which affects where the discovery
  run expects to find a database ceiling.

Eight findings, four corrections applied in place. Full report with the query output behind every
number: `.superpowers/sdd/2026-09-01-ecs-dynamodb-rps-ceiling-observability-shakedown/report.md`.

---

## Global Constraints

These four are what keep a shakedown from contaminating the measurement work that follows.

1. **No `terraform apply`, no `terraform destroy`, no capacity change.** Capacity stays 25/25. If a
   task appears to need an `apply`, it is out of scope — write it down and stop.
2. **Nothing measured here may enter `results.md`.** At 25/25 the binding constraint is the DynamoDB
   free tier, not the service — reporting a number from it as an RPS ceiling is exactly the
   platform-vs-service inversion this project exists to avoid. **Do not invoke `/loadtest`**, which
   appends a result row by design. Use raw `k6 run`.
3. **Local k6 only.** Grafana Cloud k6 spends VU-hours, which spec §10 names as the binding budget,
   and the load zone's Frankfurt RTT is irrelevant to a test of the metrics chain.
4. **Do not edit the k6 scripts.** They are unfrozen only until the discovery run; an edit now that
   is forgotten later invalidates every comparison in the plan that follows. Pass `-e` flags.

**What this does cost.** Firing a burn alert spends real error budget against the live 7-day SLO
window, and the depressed attainment stays visible until it rolls off. Per-run burn in `results.md`
is computed over each run's own window, so the baselines that follow stay valid — but the headline
`grafana_slo` number will read low for up to 7 days. That is accepted: an alert that has never been
seen to fire is not known to work.

---

## Phase 1 — Does it work? (read-only, no state change)

### Task 1: The stack is alive and every route answers

**Files:** none changed.

- [x] **Step 1: Both ECS services running, ALB target healthy**

```bash
set -a; . ./.env; set +a
aws ecs describe-services --cluster ecs-dynamodb-rps-ceiling \
  --services ecs-dynamodb-rps-ceiling ecs-dynamodb-rps-ceiling-collector \
  --region eu-central-1 \
  --query 'services[].{Name:serviceName,Desired:desiredCount,Running:runningCount}' --output table
```

Expected: both `1/1`. A collector at `0/1` means metrics stopped flowing and every later step reads
stale data — fix that before continuing rather than debugging an empty panel.

- [x] **Step 2: Walk all four measured routes plus the health check**

```bash
ALB=$(aws elbv2 describe-load-balancers --region eu-central-1 \
  --names ecs-dynamodb-rps-ceiling --query 'LoadBalancers[0].DNSName' --output text)

curl -s -o /dev/null -w 'healthz  %{http_code} %{time_total}s\n' "http://$ALB/healthz"
curl -s -o /dev/null -w 'getItem  %{http_code} %{time_total}s\n' "http://$ALB/items/feed-00/item-00"
curl -s -o /dev/null -w 'feed     %{http_code} %{time_total}s\n' "http://$ALB/feeds/feed-01"
curl -s -o /dev/null -w 'putItem  %{http_code} %{time_total}s\n' -X POST \
  -H 'content-type: application/json' -d '{"pk":"feed-03"}' "http://$ALB/items"
curl -s -o /dev/null -w 'report   %{http_code} %{time_total}s\n' -X POST \
  -H 'content-type: application/json' -d '{"pk":"feed-02"}' "http://$ALB/reports"
```

Expected: `200, 200, 200, 201, 200`. **The route templates are the ones in `slo.yaml`, not the ones
in the 2026-08-29 plan's prose** — the feed route is `/feeds/:pk`, and `/feed/:pk` returns
`{"error":"no route"}` with a 404. A 404 here is a typo in the command, not a broken service.

- [x] **Step 3: Record the latencies as the idle reference**

These become the "cold, unloaded" column that Task 5 compares against. Note them in the report; they
are **not** a result and do not go in `results.md`.

---

### Task 2: Every signal exists and is queryable

**Files:** none changed.

The point is not that Grafana is up — it is that each of the ten queries the dashboards, the README
and `/loadtest` are all generated from actually returns data. A query that silently returns nothing
reads identically to "the system is healthy".

- [x] **Step 1: Run every generated query through the datasource proxy**

`K6_PROMETHEUS_RW_*` is write-scoped and answers `invalid scope requested`, which a naive parser
reads as "no data". Use `GRAFANA_AUTH` and the proxy:

```bash
set -a; . ./.env; set +a
PROXY="$GRAFANA_URL/api/datasources/proxy/uid/grafanacloud-prom/api/v1"
python3 - <<'EOF'
import json, os, subprocess, urllib.parse
qs = json.load(open('ecs-dynamodb-rps-ceiling/grafana/queries.json'))
proxy = os.environ['GRAFANA_URL'] + '/api/datasources/proxy/uid/grafanacloud-prom/api/v1/query'
for name, expr in qs.items():
    expr = expr.replace('$__rate_interval', '15m')   # CORRECTION: see below
    out = subprocess.run(['curl','-s','-H',f"Authorization: Bearer {os.environ['GRAFANA_AUTH']}",
                          '--data-urlencode', f'query={expr}', proxy], capture_output=True, text=True)
    d = json.loads(out.stdout)
    res = d.get('data', {}).get('result', [])
    print(f"{name:28} {d.get('status')} series={len(res)} " +
          (res[0]['value'][1] if res else '—'))
EOF
```

> **CORRECTION, found by running this step.** Without the substitution line, `sli_ratio` — and only
> `sli_ratio` — fails with `parse error: unexpected character in duration expression: '$'`. It
> carries `$__rate_interval` because the Grafana SLO API *rejects* a literal range there; the other
> nine queries use a hard-coded `[60s]`. `.claude/skills/loadtest/SKILL.md` already documented this
> and this plan did not read it first.

- [x] **Step 2: Classify each empty result before dismissing it**

Two empties are **expected at idle** and are not defects:

- `queueing_ms_by_route` returns `NaN` for any route with no traffic in the window — a 0/0 average.

  > **CORRECTION, measured 2026-09-01.** README §5 said to widen the window. **You cannot.** The
  > rate range in `queueing_ms_by_route`, `db_wall_avg_by_route` and `cpu_saturation_ratio` is a
  > literal `[60s]` emitted by `scripts/generate-slo.js:466`; only `sli_ratio` takes
  > `$__rate_interval`. Changing the dashboard's time picker moves the 60-second window, it does not
  > widen it. Observed flipping between all-`NaN` and real values across a 20-second gap. README §5
  > is corrected in this plan's Task 3; the only remedy is traffic.
- CloudWatch-sourced series (`throttled_requests`, `cloudwatch_srl_by_operation`) *could* be absent
  rather than zero, since an absent metric and a zero one mean the same thing to a careless reader
  but opposite things to the attribution table's first row.

  > **CORRECTION, measured 2026-09-01: on this stack they are present and zero, not absent.**
  > `throttled_requests` returned one series at `0`, and `cloudwatch_srl_by_operation` returned four
  > including `BatchWriteItem=0` — a dimension left over from seeding with no current traffic. The
  > Alloy CloudWatch exporter emits the zero. That is the *easier* case: `> 0` is a safe test here.
  > Do not generalise it to a metric this stack has never throttled on.

Any *other* empty result is a finding. Record it with the query that produced it.

- [x] **Step 3: Confirm the `traffic_source` split works**

```bash
curl -s -H "Authorization: Bearer $GRAFANA_AUTH" \
  --data-urlencode 'match[]={__name__="http_server_request_duration_seconds"}' \
  "$PROXY/series?start=$(($(date +%s)-3600))&end=$(date +%s)" | python3 -c "
import json,sys,collections
c=collections.Counter((s['traffic_source'], s['class']) for s in json.load(sys.stdin)['data'])
[print(k, v) for k, v in sorted(c.items())]"
```

Expected: `heartbeat` for the Lambda's traffic and `other` for the hand-driven curls in Task 1, each
across the three classes. This is the evidence spec §17.1 asks for — whether generator traffic
belongs in the SLO population — and it is decidable only because the split exists before the first
run. k6 traffic will appear as `k6`.

- [x] **Step 4: All four burn rules are healthy and idle**

```bash
curl -s -H "Authorization: Bearer $GRAFANA_AUTH" \
  "$GRAFANA_URL/api/prometheus/grafana/api/v1/rules" | python3 -c "
import json,sys
for g in json.load(sys.stdin)['data']['groups']:
    if 'ecs-dynamodb-rps-ceiling' not in g['name']: continue
    for r in g['rules']: print(f\"{r['state']:9} {r['health']:5} {r['name']}\")"
```

Expected: four rules, all `inactive` / `ok`. A rule in `error` health cannot fire, which means Task 4
would pass by looking exactly like a success.

---

### Task 3: The README's monitoring claims are true

**Files:** possibly `ecs-dynamodb-rps-ceiling/README.md`.

README sections 2–6 are the monitoring runbook, with 17 Grafana deep-links. They were written from
the design, not from use. Walking them is the cheapest way to find a panel that points at nothing.

- [x] **Step 1: Open each link in §2–§6 and check it against its stated claim**

For each: does the panel exist, does it have data, and does the "good reading" the README describes
match what is on screen right now at idle?

- [x] **Step 2: Confirm §7 still tells the truth**

It currently says no load test has been run and `results.md` does not exist. **That must remain true
at the end of this plan** — if it does not, Constraint 2 was violated.

- [x] **Step 3: Fix what is wrong, in the README, in the same commit as the finding**

A broken link or a wrong "good reading" is a documentation bug found by exactly the exercise meant
to find it. Fix it; do not open a follow-up for a one-line correction.

---

## Phase 2 — Does it alert? (drives real load; burns real error budget)

### Task 4: CHECKPOINT — deliberately throttle DynamoDB and watch the alert fire

**Files:** none changed.

**Stop and confirm before running this step.** It changes no infrastructure and spends no capacity
money, but it drives sustained load at the live environment and permanently spends error budget
against the 7-day window. That is the point — but it should be a decision, not a side effect.

**Why the free tier is the right place to do this.** At 25 RCU and the frozen 55/15/25/5 mix, the
model in `slo.yaml` costs **1.025 RCU per request** (`0.55×0.5 + 0.25×2.5 + 0.05×2.5`), so reads
throttle at roughly **24 rps** sustained — writes not until ~125 rps. A run at 60 rps therefore
throttles hard, within seconds, for free. The answer is known in advance, which is what makes it a
test of the *instruments* rather than a measurement of the service.

> **CORRECTION, measured 2026-09-01: 60 rps does not throttle this table.** The capacity model is
> right — CloudWatch measured 61.6 RCU/s against the predicted 61.5 — but DynamoDB served **2.46×
> provisioned for the full six minutes with zero throttle events**, past the documented 300-second
> burst bucket. **250 rps is the rate that throttles**, and it does so about two minutes in. The
> run below was repeated at `RATE=250`; keep the 60 rps run as the evidence that provisioned
> capacity is not a hard wall.

- [x] **Step 1: Snapshot the pre-load state**

Budget remaining, `grafana_slo_sli_1h`, and all four rule states. Without this, "the alert fired"
cannot be distinguished from "the alert was already firing".

- [x] **Step 2: Drive load with raw `k6 run` — not `/loadtest`**

```bash
ALB=$(aws elbv2 describe-load-balancers --region eu-central-1 \
  --names ecs-dynamodb-rps-ceiling --query 'LoadBalancers[0].DNSName' --output text)
cd ecs-dynamodb-rps-ceiling
k6 run -e BASE_URL="http://$ALB" -e RATE=60 -e DURATION=6m -e PRE_VUS=100 k6/constant.js
echo "k6 exit: $?"
```

`k6 run` honours `-e` flags under both `run` and `inspect`; the shell environment is *not* read
(`--include-system-env-vars` defaults differ), so `-e` is the only reliable form. **Capture the exit
code off `k6` itself, never behind a pipe** — 99 means a threshold was breached, 0 means all passed.

**Expect exit 99.** A breach here is the instrument working: the thresholds encode the SLO, and the
free tier cannot serve 60 rps. An exit of 0 means the load never reached the table and the run
proved nothing.

Six minutes is chosen to clear the fast-burn rule's `for = "70s"` with margin, on a 14-minute burn
window evaluated every 60 s. The heartbeat contributes ~56 requests over that window against k6's
~21,600, so the window is dominated by the bad traffic almost immediately.

- [x] **Step 3: Watch the rule walk `inactive → pending → firing`**

Poll every 30 s during the run. Record the wall-clock time of each transition — the gap between
"the SLI broke" and "the alert fired" is the alert's real detection latency, and it is not knowable
from the rule definition alone.

- [x] **Step 4: Confirm the DynamoDB side agrees**

> **CORRECTION — the command originally here can never return data, and it is inherited from the
> 2026-08-29 plan's Task 18 Step 7.** `ThrottledRequests` is emitted **only** with a
> `TableName` + `Operation` dimension pair (`aws cloudwatch list-metrics` shows three dimension
> sets, all carrying `Operation`, none with `TableName` alone), and `get-metric-statistics` matches
> dimension sets **exactly**. Asking for `--dimensions Name=TableName,…` returns an empty datapoint
> list forever — during peak throttling it printed nothing, indistinguishable from a healthy table.
> Use the table-level throttle-event metrics instead; they also separate reads from writes, which
> `ThrottledRequests` cannot:

```bash
for M in ReadThrottleEvents WriteThrottleEvents; do
  echo "-- $M"
  aws cloudwatch get-metric-statistics --namespace AWS/DynamoDB --metric-name $M \
    --dimensions Name=TableName,Value=ecs-dynamodb-rps-ceiling \
    --start-time "$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ)" --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --period 60 --statistics Sum --region eu-central-1 \
    --query 'sort_by(Datapoints,&Timestamp)[].[Timestamp,Sum]' --output text
done
```

For `ThrottledRequests` specifically, add `Name=Operation,Value=GetItem` (or `Query`, `PutItem`).
`date -u -v-30M` is BSD/macOS; on GNU it is `date -u -d '30 minutes ago'`.

---

### Task 5: Test the attribution table against a known answer

**Files:** none changed.

This is the task that justifies the whole plan. The four-row table in §5 of the 2026-08-31 spec is
what the discovery run will use to name the bound resource, and it has **never been evaluated against
a case whose answer is known**. Here the answer is known: the database, by construction.

- [x] **Step 1: Read all four discriminators over the load window**

`throttled_requests`, `cloudwatch_srl_by_operation`, `queueing_ms_by_route` (the gap between the
service's own clock and DynamoDB's), and `cpu_saturation_ratio` against the 0.25 vCPU allocation.

- [x] **Step 2: Apply the table and write down the verdict**

It must read **database**: `ThrottledRequests` rising, `SuccessfulRequestLatency` climbing, CPU
saturation well below 1.0.

> ### ✗ VERDICT, 2026-09-01: the table said **service**. The truth was **database**.
>
> Read at 08:34:00Z with `ReadThrottleEvents` at 5,588/min, row 1 matched exactly — throttling zero,
> `SuccessfulRequestLatency` flat, event-loop delay climbing → *"service: the DB is keeping up; the
> queue is in Node."* Three independent causes, each sufficient on its own:
>
> 1. `throttled_requests` returns `0` at instants **during** sustained throttling — the range query
>    reads `… 4156, 0, 4153, 4360 …`. It is a per-60s CloudWatch SUM exposed as a gauge, and the
>    table's test is a single instant read.
> 2. `SuccessfulRequestLatency` **falls** when DynamoDB throttles (0.887 ms mid-throttle vs 1.473 ms
>    idle). Throttled requests are rejected, not served slowly, so they never enter the statistic.
>    The "database" row requires SRL to climb, so it cannot match a capacity-throttling event at all.
> 3. The queueing gap reached 642–938 ms against DynamoDB's 0.9–2.2 ms — almost entirely SDK retry
>    backoff. The spec calls a widening gap with throttling at zero "the strongest positive evidence
>    of a service-bound ceiling". Event-loop delay hit 610 ms for the same reason, with CPU
>    saturation at 6.4%.
>
> `ReadThrottleEvents` / `WriteThrottleEvents` were clean, continuous and correct throughout — and
> are in neither `queries.json` nor the attribution table. **This is the finding of the session;
> see Step 3.**

- [x] **Step 3: If it does not say "database", that is the finding of the session**

A table that misattributes a case whose answer is known will misattribute the discovery run too,
where nothing checks it. Do not adjust the table to fit and move on — the correction is a **new
spec** amending the 2026-08-31 design at the decision itself, per `CLAUDE.md`. Note that
`ThrottledRequests` is the one discriminator that cannot be contaminated by the Node event loop,
because it is measured inside DynamoDB.

**One expected complication, worth predicting before it is seen:** SDK retries of
`ProvisionedThroughputExceededException` sit *inside* the measured `db` phase. Throttling therefore
presents as latency before it presents as errors, and it will inflate `queueing_ms_by_route` — the
row that otherwise indicates a *service*-bound ceiling. Rows one and three can appear to match at
once. That is why the table is read top-down with `ThrottledRequests` first, and confirming that
ordering actually resolves the ambiguity is the substance of this task.

---

### Task 6: Watch it recover

**Files:** none changed.

An alert that fires and never clears is as useless as one that never fires.

- [x] **Step 1: Stop the load and let the environment idle**
- [x] **Step 2: Record the time from last request to each rule returning `inactive`**

The fast rule's 14-minute window has to roll off the bad data, so expect roughly 14 minutes plus the
evaluation interval — not immediate. Confirm it, do not assume it.

- [x] **Step 3: Record the error budget actually consumed**

From the SLO app: budget remaining before, after, and the delta. This is the price of the exercise,
and knowing it makes the same decision cheaper to take next time.

- [x] **Step 4: Wait 6 minutes of true idle before considering the environment settled**

DynamoDB banks unused capacity for ~300 s. Any later run — including the discovery run in the next
plan — must start from a full burst bucket or it is not comparable.

---

## Phase 3 — Close out

### Task 7: Record findings and close the plan

**Files:**
- Modify: `ecs-dynamodb-rps-ceiling/README.md`
- Modify: this plan's Status line
- Create: `.superpowers/sdd/2026-09-01-ecs-dynamodb-rps-ceiling-observability-shakedown/report.md`

- [ ] **Step 1: Write the report** — what was verified, what was found, the alert's measured
  detection and recovery latency, the budget spent, and the attribution verdict with the query
  output that produced it. Every number quoted with its source, per `CLAUDE.md`'s verification rule.

- [ ] **Step 2: Fold the durable facts into the README** — detection latency and recovery latency
  belong in §6, which currently explains what the rules *mean* but not how long they take.

- [ ] **Step 3: Confirm `results.md` still does not exist** (Constraint 2), then commit

```bash
git commit -m "docs(ecs-dynamodb-rps-ceiling): verify the observability chain end to end"
```

- [ ] **Step 4: Set this plan's Status to `complete`, and hand off**

The next document is
`docs/superpowers/plans/2026-09-02-ecs-dynamodb-rps-ceiling-scale-and-measure.md`. Its Task 1 is the
first thing in this project that costs real money.
