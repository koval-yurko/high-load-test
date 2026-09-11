# The SLI Ratio — the query the objective is judged against

One series decides whether the service met its objective. The Grafana SLO object reads it, all six
burn-rate alert rules read it, and the dashboard panel every alert deep-links into draws it:

```
   sli_ratio ──┬──▶ the Grafana SLO object        objective, error budget, remaining budget
               ├──▶ six burn-rate alert rules     alerts.tf, each with its own explicit window
               └──▶ the SLO panel                 what you land on from an alert notification
```

This page is about that one query: what it measures, and why it is shaped the way it is.

It reads a latency histogram through two PromQL functions. **`docs/histograms.md` explains those,
with diagrams** — what a histogram stores, what `histogram_fraction` and `histogram_count` return,
and why the aggregation order matters.

---

## 1. An SLI is a ratio, not a percentile

**good events ÷ valid events.** Not an average, not a percentile — a share, because a share is the
only form you can subtract from an objective to get an error budget:

```
   "p95 was 180 ms"                    "97.2% of requests met their deadline"

   ✗ cannot be budgeted                ✓ objective 95%  →  budget 5%
     a percentile is a latency,           spent 2.8%  →  44% of the budget left
     not a count of anything              and that number can drive an alert
```

`histogram_fraction` and `histogram_quantile` are inverses: a quantile fixes a share and returns a
latency, a fraction fixes a latency and returns a share. **An objective fixes a deadline and asks
for a share, so an SLI is `histogram_fraction`.**

---

## 2. One deadline per class, one ratio across all of them

One threshold for the whole service is almost always wrong, because endpoints do different amounts
of work: the deadline that is generous for a report is absurd for a key lookup. So endpoints are
grouped into **latency classes**, each class gets its own deadline, and one ratio is computed across
all of them:

```
   one window, three classes, each judged against its OWN deadline

   class      deadline   requests   share that met it            good requests
   ──────────────────────────────────────────────────────────────────────────────
   fast         50 ms     10 000    ████████████████░░░░  0.80        8 000
   standard    200 ms      2 000    ██████████████████░░  0.90        1 800
   heavy       800 ms        200    █████████████████░░░  0.85          170
   ──────────────────────────────────────────────────────────────────────────────
                    N =    12 200                         Σ good =     9 970

                   Σ good       9 970
         SLI  =  ──────────  =  ───────  =  0.817     ← 81.7% met their deadline
                      N         12 200
```

---

## 3. Two functions per class, and why they are multiplied

Take one class on its own — `fast`, 10 000 requests in the window, deadline 50 ms. Two different
questions can be asked of that histogram, and each function answers exactly one of them:

```
   the fast class over one window

   requests
      4000┤ ███
          │ ███ ███                          ┊
      2000┤ ███ ███ ███                      ┊
          │ ███ ███ ███ ███ ███              ┊ ███  ███  ██
         0└──────────────────────────────────┊───────────────────▶ ms
            0    10   20   30   40      50 ms┊  60   70   80
                                     deadline┊
          ◀──────── met the deadline ────────┊──── missed it ────▶
                     8 000 requests          ┊     2 000 requests


   histogram_fraction(0, 0.05, H)  ──▶  0.80        WHAT PORTION landed inside the deadline.
                                                    A share, 0..1. It knows where the line is,
                                                    and nothing about how big the class is.

   histogram_count(H)              ──▶  10 000      HOW MANY requests there were at all.
                                                    A count. It knows the size of the class,
                                                    and nothing about the deadline.

                     0.80        ×      10 000   =   8 000
                   ─────────          ─────────     ───────
                   the share          the size      good requests, a COUNT
```

Neither answer is the SLI on its own: a share can't be totalled across classes, and a count can't
tell you whether the requests were fast. Multiplied, they give a **count of good requests** — and
counts are the only thing that survives being added up across classes measured against different
deadlines.

Here is what happens if you skip the multiplication and average the three shares instead:

```
   class       requests    share      averaging the shares treats these three
   ─────────────────────────────────  classes as if they were the same size
   fast          10 000     0.80
   standard       2 000     0.90        (0.80 + 0.90 + 0.85) ÷ 3   =  0.850   ✗
   heavy            200     0.85
   ─────────────────────────────────    8 000 + 1 800 + 170
   total         12 200                 ───────────────────       =  0.817   ✓
                                               12 200

   3.3 points of pure invention — the 200-request heavy class was given the same
   weight as the 10 000-request fast class, and 3.3 points of a 5% error budget
   is most of the budget.
```

So the numerator is a sum of counts, one term per class, and the denominator is a plain count over
all classes together — no deadline, no status filter, every valid request whether it made it or not:

```
                 ┌ fast      histogram_fraction(0, 0.05, H) × histogram_count(H)   or vector(0)
   numerator     ├ standard  histogram_fraction(0, 0.2,  H) × histogram_count(H)   or vector(0)
                 └ heavy     histogram_fraction(0, 0.8,  H) × histogram_count(H)   or vector(0)
                                                   │                                    │
                          5xx excluded here, and only here:            an idle class scores 0 good
                          the request stays in the denominator,        requests instead of emptying
                          so a fast failure still counts against us    the whole sum (empty + x = empty)
   ─────────────────────────────────────────────────────────────────────────────────────────────────
   denominator     histogram_count( all three classes together )    no deadline, no status filter
```

---

## 4. Written out for `ecs-dynamodb-rps`

| class | deadline | endpoints | in the query |
|---|---|---|---|
| fast | 50 ms | `GET /items/:pk/:sk`, `POST /items` | `histogram_fraction(0, 0.05, …)` |
| standard | 200 ms | `GET /feeds/:pk` | `histogram_fraction(0, 0.2, …)` |
| heavy | 800 ms | `POST /reports` | `histogram_fraction(0, 0.8, …)` |

Deadlines appear in **seconds** in the query because the histogram's unit is seconds; `slo.yaml`
states them in milliseconds and the generator divides.

One class term of the numerator, in full — every line of it does something:

```promql
# ─── the `fast` term of the numerator ──────────────────────────────────────────────────
#     reads as: "how many fast-class requests finished inside 50 ms, 5xx not counted"

histogram_fraction(0, 0.05,                      # ◀ the deadline. 0.05 s = 50 ms
  sum(                                           # ◀ sum FIRST, fraction after: one histogram per
                                                 #   class, not one per task — a per-task fraction
                                                 #   returns NaN the moment a task sees no traffic
    rate(http_server_request_duration_seconds{   # ◀ the request-duration histogram
      job="ecs-dynamodb-rps",                    # ◀ this service
      http_route!~"/healthz",                    # ◀ health checks are not user traffic
      class=~"fast|standard|heavy",              # ◀ the population — anything the collector could
                                                 #   not classify is dropped here, so this regex
                                                 #   doubles as "was every route actually mapped?"
      class="fast",                              # ◀ ...and within that population, this one class
                                                 #   (`class` is added by the Alloy collector from
                                                 #   classmap.json; the service records http.route)
      http_response_status_code!~"5.."           # ◀ a server error is a miss however fast it was.
                                                 #   Numerator only: the request stays in the
                                                 #   denominator, so it counts against the ratio
    }[$__rate_interval])                         # ◀ not a fixed range — Grafana's SLO API rejects
  )                                              #   a hardcoded one. The burn-rate rules in
)                                                #   alerts.tf read this ratio with their own
                                                 #   explicit windows instead
*
histogram_count(                                 # ◀ × how many fast-class requests there were,
  sum(rate(http_server_request_duration_seconds{ #   over the identical selector
    …the same six lines…
  }[$__rate_interval]))
)
# ═══ result: a COUNT of good fast-class requests ═══════════════════════════════════════
#     `standard` and `heavy` are the same term twice more, with 0.2 / 0.8 and class="…".
#     The denominator drops both the deadline and the status filter, and keeps the rest.
```

---

## 5. The objective this ratio is judged against

```
   95% over 7 days          the objective the ratio above is compared against
      │
      └─ error budget 5%    of every request in the 7-day window

   tail objective 99% at three times each class deadline:

      fast      50 ms  →  150 ms
      standard 200 ms  →  600 ms      99% of requests must land inside these
      heavy    800 ms  →  2400 ms
```

What these objectives mean, how they turn into an error budget, and why they cannot be lowered
further without disabling their own alerts is in `docs/slo-burn-alerting.md`.
