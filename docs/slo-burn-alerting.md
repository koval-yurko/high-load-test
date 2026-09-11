# Service objectives, error budgets, and when we get woken up

A plain-language explanation of how this repo decides whether a service is healthy, and when an
alert is worth someone's attention. No prior knowledge assumed.

## The idea in one paragraph

Perfection is not the goal. We pick a target — say, *95% of requests are fast* — and accept that the
remaining 5% will not be. That 5% is a **budget**: a quantity we are allowed to spend, like a
weekly allowance. Health is not "did anything go wrong today", it is "are we spending the
allowance faster than it refills". Alerts fire on the *spending rate*, never on individual bad
moments.

## The four terms

**Indicator** — the thing we measure: the share of requests that came back both correct and fast
enough. Always a share of a whole, never an average or a percentile, because a share is the only
form that can be turned into a budget.

**Objective** — the target that share must hold, over a stated period: *95% of requests, measured
over seven days*.

**Error budget** — everything the objective leaves over. A 95% objective permits 5% of requests to
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
| **primary** | 95% | the endpoint's own deadline — 50 / 200 / 800 ms | is the typical request fast? |
| **tail** | 99% | three times that — 150 / 600 / 2400 ms | is *anyone* waiting far too long? |

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

Two cuts on the same axis — primary at the endpoint's own deadline, tail at three times it:

```
  GET /items/:id          primary cut                    tail cut
                             50 ms                        150 ms
  0 ───────────────────────────┬─────────────────────────────┬──────────────►
    ###########################│.............................│~~~~~~~~~~~~~~
    met both                   │ missed primary, met tail    │ missed both
    spends nothing             │ spends primary budget       │ spends both
```

Each budget catches a failure the other is blind to:

```
  # = requests             primary                tail
                            50 ms                150 ms
                              │                     │
  healthy       ##############│                     │         both green
  all slower          ########│###########          │         primary burns
  a few stuck   ##############│                     │ ##      tail burns
```

- **all slower** — the database gets busy and every item fetch drifts 30 ms → 70 ms. Nothing comes
  near 150 ms, so tail stays green; only primary sees the sluggishness users feel.
- **a few stuck** — one report in a few hundred hits a throttled write and takes 3 s. Far too few to
  move primary; they sail past 2400 ms, so only tail sees that somebody is having a terrible time.

Every endpoint belongs to exactly one class. An endpoint in no class is measured by nothing at all,
which is worse than an endpoint with the wrong deadline.

### What 95% and 99% actually mean

A target is a permitted miss rate. Multiply it by the traffic in the window and it stops being a
percentage and becomes a countable budget:

```
  error budget  =  (1 − target)  ×  requests in the window

  one 5-min run   300 s × 800 rps           =     240,000   requests
  primary    95%  (1 − 0.95) × 240,000      =      12,000   may miss their own deadline
  tail       99%  (1 − 0.99) × 240,000      =       2,400   may exceed 3× that deadline
```

- **primary 95%** — 12,000 of that run's requests may miss their own class deadline (50 / 200 / 800 ms)
- **tail 99%** — 2,400 may go past three times it (150 / 600 / 2400 ms)

A request that is merely slow spends primary budget; one that is badly slow spends both. The
informational 7-day window uses the same arithmetic with that window's request count instead.

## Why we alert on spending rate, not on symptoms

An alert that fires whenever the service is momentarily slow will fire most days. It gets silenced
within a week, and from then on it protects nothing. Tying the alert to budget spending ties it to
consequence: it fires only when the current rate would genuinely exhaust the allowance.

## The two alerts

Two alerts watch the same budget at different speeds. Both the speeds and the lookback windows come
from Google's *SRE Workbook*; the next section derives every number in the table.

| | spending rate | looks back over | means | who gets it |
|---|---|---|---|---|
| **fast burn** | 14.4× | 1 hour | something is actively broken | a page — wake someone |
| **slow burn** | 6× | 6 hours | a steady leak, quietly draining the budget | a ticket — deal with it in hours |

Neither works alone. Fast burn only notices dramatic failures and would sleep through a slow leak.
Slow burn eventually notices anything, but far too late for an outage.

## Where 14.4 and 6 come from

They are not folklore and they are not tuned by feel — they are one row of a published table, run
through one formula, then rescaled to our measurement period.

### What the workbook actually gives

Google's *SRE Workbook*, "Alerting on SLOs", Table 5-8 — the two rows we use, as published:

| severity | long window | short window | burn rate | budget consumed |
|---|---|---|---|---|
| page | 1 hour | 5 minutes | **14.4** | **2%** |
| page | 6 hours | 30 minutes | **6** | **5%** |

**Only the budget-consumed column is a free choice, and it is a judgement, not a derivation.** The
workbook calls 2% in an hour and 5% in six hours *"reasonable starting numbers for paging"*, and
says plainly that *"appropriate numbers depend on the service and the baseline page load"*. There is
nothing underneath them to appeal to.

One deliberate departure: the workbook classes **6× / 6 h as a page**, and here it raises a ticket
instead, because a steady leak in a test lab does not justify waking anyone.

### Step 1 — the multiplier is forced by the other two

The workbook's own formula. Given a budget share and a window, nothing else is possible:

```
  burn rate  =  (budget consumed ÷ window)  ×  SLO period

    fast burn        0.02 ÷ 1 h   ×  720 h  =  14.4×
    slow burn        0.05 ÷ 6 h   ×  720 h  =     6×
```

So 14.4 and 6 carry no information of their own. They are "2% in an hour" and "5% in six hours"
expressed as a rate, against a **30-day** period — the 720 hours above.

### Step 2 — realigning 30 days to our 7

Three things are locked together: the multiplier, the budget share, and the window. Our period is
seven days, so one of the three has to move. We keep the multipliers and the budget shares — those
are the meaning of the alert — and **scale every window by 7/30**. *Waits for* is the confirmation
delay: the rule must hold above its threshold that long before it fires, so one unlucky minute
cannot trigger it.

```
  scale  =  7 d ÷ 30 d  =  0.2333

    fast burn  looks back     60 min × 7/30  =  14 min
    fast burn  waits for       5 min × 7/30  =    70 s
    slow burn  looks back    360 min × 7/30  =  84 min
    slow burn  waits for      30 min × 7/30  =   7 min

  check — 7 d is 10,080 min, and the budget shares must come back unchanged:

    14.4 × (14 min ÷ 10,080)    =      2%    as specified
    6    × (84 min ÷ 10,080)    =      5%    as specified

  had the windows been left at 1 h and 6 h, the same two rules would mean:

    14.4 × (60 min ÷ 10,080)    =    8.6%    four times more budget than it claims
    6    × (360 min ÷ 10,080)   =   21.4%    four times more budget than it claims
```

The failure mode this avoids is silent. Nothing errors, no rule breaks; the alerts simply stop
meaning what their names say, and someone reading "2% fast burn" on a dashboard is reading a rule
that fires at 8.6%.

Every generated alert carries its own arithmetic written into it as a note, so anyone reading an
alert can check these numbers without hunting for this page.

## What each rule fires at, and where those numbers come from

Spending the budget at 14.4× the sustainable pace means missing at 14.4× the permitted miss rate.
So each rule's firing threshold is just its own target run through the multiplier — nothing else:

```
  fires when the miss rate exceeds   burn multiplier × (1 − target)

                target     fast burn 14.4×              slow burn 6×
  primary          95%     14.4 × 0.05   =   72.0%      6 × 0.05    =   30.0%
  tail             99%     14.4 × 0.01   =   14.4%      6 × 0.01    =    6.0%
  availability   99.9%     14.4 × 0.001  =   1.44%      6 × 0.001   =   0.60%
```

Put the three fast-burn marks on one axis and the division of labour is the whole picture:

```
  share of requests missing — a rule pages once its own mark is crossed
  0% ──┬────────┬─────────────────────────────────────┬──────────────────► 100%
       │        │                                     │
       │        │                                     └─ 72.0%   primary 95% — the backstop
       │        └─ 14.4%   tail 99% — the early warning
       └─ 1.44%   availability 99.9% — any 5xx
```

Tail does the waking up: 14.4% of requests running past 3× their deadline is a page, while the
typical request still looks fine. Primary at 95% only pages above a 72% miss rate — that is not
sluggishness, it is collapse. So moving one number moves who pages first: loosen tail and the early
warning is gone, with nothing left to replace it.

## Why the targets are 95% and 99%, and not lower

A lower target sounds free — fewer things count as failures, so there is more room. It is not free,
and past a certain point it silently disables the alerts it is supposed to make readable.

That firing threshold is itself a miss rate, and a miss rate cannot exceed 100%: at most, every
single request fails. So the lower the target, the higher the threshold climbs — until it climbs
past 100% and the rule can never fire again. It does not error. It renders green forever, which
looks exactly like a rule with nothing to report.

```
   target      fast 14.4×  slow 6×   0%             100%  ← a miss rate cannot pass this
                                     ├─────────────────┤
      99%           14.4%     6.0%   ███
      95%           72.0%    30.0%   █████████████
   93.06%           99.9%    41.6%   ██████████████████
      90%            144%    60.0%   ██████████████████░░░░░░░░
      85%            216%    90.0%   ██████████████████░░░░░░░░░░░░░░░░░░░░░
```

The bar is the fast-burn rule's firing threshold. **Shaded is the part that cannot exist** — a rule
asking for a 144% miss rate **is asking for more requests to fail than were served**. At 93.06% the bar
touches the ceiling exactly; below that the rule is dead, and a dead rule renders green forever.
(The slow-burn column has the same ceiling further down, at 83.33%.)

**93.06% is the floor** for anything watched by a 14.4× rule, and 83.33% for a 6× rule — which is
what rules out 85%. A test enforces it: `generate-slo.test.js` asserts
`multiplier × (1 − objective) < 1` for every objective in `slo.yaml`, so a target below the floor
fails the build instead of quietly producing a dead alert.

The class deadlines — 50 / 200 / 800 ms — are not a lever for buying headroom either. They are
achievable (the fast class measures a 15.38 ms p99 warm against its 50 ms deadline), and the load
profiles size their virtual users from them, so loosening them would cut deliverable throughput
instead.

Three ways around the floor are each worse than living with it: retuning the multipliers destroys the
"2% and 5% of budget" derivation they encode; a separate alerting-only objective puts two objectives
in one file, which is the drift the one-source rule exists to prevent; and deleting the two rules
gives up the latency page entirely.

## Choosing the measurement period

- **Check how long the data actually lives.** Our metrics provider's free tier keeps 14 days of
  history, so a 30-day objective there could never be evaluated over the period it claims. That is
  why we measure over seven days.
- **Pick a period that divides tidily.** Every lookback window is rescaled from it, and windows that
  land on awkward fractions of a second are rejected outright.

## One source of truth

Every objective, deadline, and measurement period for a project is written once, and everything
else is generated from it:

```
                          ┌─►  infra/k6/tests/lib/slo.js    load-test thresholds
                          │
  slo.yaml   ─────────────┼─►  infra/grafana/*.tf           alert rules + dashboards
  one per project         │
                          └─►  DynamoDB capacity            provisioned to the same numbers
```

`/slo --check` fails the build if any generated file was hand-edited or has fallen out of step.

The failure mode this prevents: the same objective typed in two places, the dashboard claiming one
number while the load test enforces another, both green, neither meaning anything. Two shapes of it
have already been found and closed here —

- an objective hardcoded in a load profile instead of imported, so the run measured against a number
  no other artifact agreed with;
- results tooling looking a threshold up by a key that *is* the threshold's own text (`rate>0.99`),
  so changing the objective turned every step's verdict into "no result".

Both are now generated, or read by position, so neither can come back.
