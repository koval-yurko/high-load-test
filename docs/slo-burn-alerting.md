# Service objectives, error budgets, and when we get woken up

A plain-language explanation of how this repo decides whether a service is healthy, and when an
alert is worth someone's attention. No prior knowledge assumed.

## The idea in one paragraph

Perfection is not the goal. We pick a target — say, *99% of requests are fast* — and accept that the
remaining 1% will not be. That 1% is a **budget**: a quantity we are allowed to spend, like a
monthly allowance. Health is not "did anything go wrong today", it is "are we spending the
allowance faster than it refills". Alerts fire on the *spending rate*, never on individual bad
moments.

## The four terms

**Indicator** — the thing we measure: the share of requests that came back both correct and fast
enough. Always a share of a whole, never an average or a percentile, because a share is the only
form that can be turned into a budget.

**Objective** — the target that share must hold, over a stated period: *99% of requests, measured
over seven days*.

**Error budget** — everything the objective leaves over. A 99% objective permits 1% of requests to
miss. Over a week of steady traffic that is a real, countable number of requests we can afford to
disappoint.

**Burn rate** — how fast the budget is being spent, expressed as a multiple of the sustainable
pace:

- **1×** — spending exactly on plan; the budget runs out precisely at the end of the week.
- **14.4×** — spending fourteen times too fast; a week's budget is gone in about 12 hours.
- **6×** — a week's budget gone in about 28 hours.

Everything below is built on that multiple.

## Two objectives: typical and worst-case

The service has four endpoints that do genuinely different amounts of work, so one speed target for
all of them would be meaningless — it would punish the expensive endpoint and let the cheap ones
hide behind it. Instead each endpoint gets a deadline that suits the work it actually does, and we
measure whether each request met *its own* deadline.

| endpoint | what it does | class | deadline |
|---|---|---|---|
| `GET /items/:id` | fetch one record by key — one database read | **fast** | 50 ms |
| `POST /items` | store one record — one database write | **fast** | 50 ms |
| `GET /feeds/:id` | read a page of records, then sort and total them | **standard** | 200 ms |
| `POST /reports` | read a page, run a deliberately expensive calculation over it, then write a record | **heavy** | 800 ms |

(The health check is excluded. It is there for the load balancer, not for users, and counting it
would inflate every result with traffic nobody is waiting on.)

Under our normal traffic mix, roughly 70 of every 100 requests are judged against 50 ms, 25 against
200 ms, and 5 against 800 ms. All of them roll up into a **single** score: the share of requests
that met their own deadline. One number, comparable across releases, even if the traffic mix
shifts.

We then hold that one number to two separate targets:

| | target | deadline used | the question it answers |
|---|---|---|---|
| **primary** | 99% | the endpoint's own deadline — 50 / 200 / 800 ms | is the typical request fast? |
| **tail** | 99.9% | three times that — 150 / 600 / 2400 ms | is *anyone* waiting far too long? |

"Tail" is the industry word for the small unlucky fraction at the slow end of the distribution.

### What that means for a single request

| the request | primary (50/200/800) | tail (150/600/2400) |
|---|---|---|
| `GET /items/:id` in 30 ms | met | met — costs nothing |
| `GET /items/:id` in 70 ms | **missed** | met — slightly slow, spends primary budget only |
| `GET /items/:id` in 400 ms | **missed** | **missed** — spends both budgets |
| `POST /reports` in 700 ms | met | met — the slowest request in the system, and entirely fine |

That last row is the whole point of per-endpoint deadlines. A 700 ms report is healthy; a 400 ms
item fetch is a serious problem. A single global target could not tell those two apart.

### Why both targets, and not just one

They fail separately, which is why each carries its own budget.

*Only primary burns:* the database gets busy and item fetches drift from 30 ms to 70 ms across the
board. Almost every request now misses its 50 ms deadline, so primary collapses — but nothing is
anywhere near 150 ms, so tail stays perfectly green. This is real degradation that users feel as
sluggishness, and only the primary target sees it.

*Only tail burns:* the service is fast for almost everyone, but one report in every few hundred hits
a throttled database write and takes three seconds. Reports are only 5% of traffic and the affected
share is tiny, so primary barely moves — but those requests blow straight past the 2400 ms tail
deadline, and the tail budget drains fast. Somebody is having a genuinely terrible experience, and
only the tail target sees it.

Every endpoint belongs to exactly one class. An endpoint in no class is measured by nothing at all,
which is worse than an endpoint with the wrong deadline.

## Why we alert on spending rate, not on symptoms

An alert that fires whenever the service is momentarily slow will fire most days. It gets silenced
within a week, and from then on it protects nothing. Tying the alert to budget spending ties it to
consequence: it fires only when the current rate would genuinely exhaust the allowance.

## The two alerts

Two alerts watch the same budget at different speeds. The pairing comes from Google's Site
Reliability Engineering handbook, which is where the specific numbers below originate.

| | spending rate | looks back over | means | who gets it |
|---|---|---|---|---|
| **fast burn** | 14.4× | 1 hour | something is actively broken | a page — wake someone |
| **slow burn** | 6× | 6 hours | a steady leak, quietly draining the budget | a ticket — deal with it in hours |

Neither works alone. Fast burn only notices dramatic failures and would sleep through a slow leak.
Slow burn eventually notices anything, but far too late for an outage.

## Where 14.4 and 6 come from

They are not folklore, and they are not tuned by feel. They are whatever makes an alert fire at the
moment a chosen **share of the budget** has already been spent:

```
share of budget spent  =  spending rate  ×  (hours we look back ÷ hours in the period)

14.4 × (1 hour  ÷ 720 hours)  =  2%
 6   × (6 hours ÷ 720 hours)  =  5%
```

So the page means *"2% of the week's allowance disappeared in the last hour"*, and the ticket means
*"5% disappeared in the last six hours"*. That is the sentence to keep; the multipliers are just its
arithmetic.

**But those two lines assume a 30-day period** — the 720 hours above. Our objectives are measured
over **seven days**, and if we kept the 1-hour and 6-hour lookbacks unchanged, the same alerts would
quietly come to mean 8.6% and 21% of the budget instead of 2% and 5%. Nothing would look broken;
the alerts would simply have stopped meaning what their names claim.

So we keep the spending rates and the budget shares fixed and **shrink the lookback windows in
proportion**. Seven days is a bit under a quarter of thirty, so every window shrinks to a bit under
a quarter:

| | on 30 days | on our 7 days | the 2% / 5% still holds |
|---|---|---|---|
| fast burn looks back | 1 hour | **14 minutes** | 14.4 × 14 min of a 7-day week = 2% |
| slow burn looks back | 6 hours | **84 minutes** | 6 × 84 min of a 7-day week = 5% |

Each alert also waits a short confirmation period before firing, so a single unlucky moment cannot
trigger it; those delays shrink by the same proportion.

Every generated alert carries its own arithmetic written into it as a note, so anyone reading an
alert can check the numbers without hunting for this page.

## Choosing the measurement period

- **Check how long the data actually lives.** Our metrics provider's free tier keeps 14 days of
  history, so a 30-day objective there could never be evaluated over the period it claims. That is
  why we measure over seven days.
- **Pick a period that divides tidily.** Every lookback window is rescaled from it, and windows that
  land on awkward fractions of a second are rejected outright.

## One source of truth

Every objective, deadline, and measurement period for a project is written in exactly one file.
From that file we generate the load-test thresholds, the alert rules, the dashboard definitions, and
the database capacity settings. A separate check command fails the build if any generated file has
been edited by hand or has fallen out of step.

This exists because of one specific, embarrassing failure: when the same objective is typed in two
places, the dashboard ends up claiming 99.9% while the load test enforces 95%, both show green, and
neither number means anything. If the two ever disagree, every performance result from that project
is unreliable until it is resolved.

## What the numbers are measured over

The continuously running measurement is **informational**. The numbers we actually report come from
a load run, measured over that run's own duration and recorded in the project's results file.

The reason is simple: between load runs the service receives about one request a minute. A 99%
target over a population that small is meaningless — a couple of slow requests an hour, caused by
nothing more than an idle connection being re-established, would read as a serious breach. The
target is right; the idle traffic is far too sparse to judge it.

---

*Where this lives in the repo: the per-project source file is `slo.yaml` at the project root; the
generator is `service/scripts/generate-slo.js`, and its outputs are the alert rules in
`infra/grafana/` and the k6 thresholds in `infra/k6/tests/lib/slo.js`. The reasoning behind
measuring over load runs rather
than continuously is in `docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-slo-scope-design.md`.*
