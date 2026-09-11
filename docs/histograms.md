# Histograms, and the `histogram_*` functions

Everything in this repo that says "95% of requests met their deadline" is read out of a histogram.
This page explains what a histogram actually stores, what the two kinds look like on the wire, and
what each `histogram_*` function does to them — with pictures, because the arithmetic is easy and
the shapes are what people get wrong.

For how these are assembled into the SLI ratio the objective is judged against, see
`docs/sli-queries.md`.

---

## 1. What a histogram is

Start with ten requests. These are the raw durations, in milliseconds:

```
   12    18    23    31    47    52    68    95   140   410
```

Storing all ten forever does not scale — a service at 1000 rps produces 86 million of them a day. So
we throw away the individual values and keep only **how many landed in each range**:

```
       bucket            count
   ┌────────────────┬───────────┬──────────────────────────────────
     0  –  25 ms          3       ███                12  18  23
    25  –  50 ms          2       ██                 31  47
    50  – 100 ms          3       ███                52  68  95
   100  – 250 ms          1       █                  140
   250  – 1000 ms         1       █                  410
   1000 ms – ∞            0
   ┌────────────────┴───────────┴──────────────────────────────────
   plus:   count = 10        sum = 896 ms
```

That is the whole data structure: **a set of counters, one per range, plus a total count and a total
sum.** Every `histogram_*` function is a different way of reading those numbers.

Two properties follow immediately, and they explain almost everything later:

- **The count and the sum are exact.** They were incremented per observation; nothing was estimated.
- **Within a bucket, the individual values are gone.** We know one request landed between 100 and
  250 ms. We do not know whether it was 101 or 249. Anything that needs to look *inside* a bucket
  can only estimate.

---

## 2. Cumulative buckets, and what `le` means

Here is the first real trap. Prometheus's classic histograms do **not** store the left column below.
They store the right one:

```
                 requests IN this bucket        requests AT OR UNDER this boundary
                 (what you just saw)            (what Prometheus actually stores)

    ≤   25 ms          3    ███                        3    ███
    ≤   50 ms          2    ██                         5    █████
    ≤  100 ms          3    ███                        8    ████████
    ≤  250 ms          1    █                          9    █████████
    ≤ 1000 ms          1    █                         10    ██████████
    ≤     +Inf         0                              10    ██████████
                                                       ▲
                                            each bar INCLUDES every bar above it
```

The right column is **cumulative**. `le` is the label carrying the boundary — it stands for **less
than or equal**, and a bucket labelled `le="0.1"` means *"how many observations were ≤ 0.1 seconds"*,
not *"how many were between 0.05 and 0.1"*.

`+Inf` is always the last bucket and always equals the total count. If your histogram has an `+Inf`
bucket smaller than `_count`, something is wrong.

To get "requests in this bucket" back you subtract neighbours — which is exactly what
`histogram_quantile` does internally, and one reason you should not do it by hand.

---

## 3. The two kinds, on the wire

### Classic histogram — many series

One metric explodes into one series per bucket, plus two more:

```
http_request_duration_seconds_bucket{route="/items", le="0.025"}    3
http_request_duration_seconds_bucket{route="/items", le="0.05"}     5
http_request_duration_seconds_bucket{route="/items", le="0.1"}      8
http_request_duration_seconds_bucket{route="/items", le="0.25"}     9
http_request_duration_seconds_bucket{route="/items", le="1"}       10
http_request_duration_seconds_bucket{route="/items", le="+Inf"}    10
http_request_duration_seconds_sum{route="/items"}                   0.896
http_request_duration_seconds_count{route="/items"}                10
                                    ▲
                     these three SUFFIXES are the whole API
```

- `_bucket` — the cumulative counters, distinguished by `le`
- `_sum` — total of all observed values
- `_count` — number of observations (identical to the `+Inf` bucket)

**The cost is multiplicative.** That is 8 series for one route. Ten routes, four status codes and
three instances make it 960. Bucket boundaries are also **chosen at instrumentation time**: if you
picked `0.025, 0.05, 0.1, 0.25, 1` and later want to know the share under 200 ms, you cannot — there
is no boundary there, and getting one means changing code and redeploying.

### Native histogram — one series

The same data arrives as a *single* series whose every sample carries the whole structure:

```
http_request_duration_seconds{route="/items"}  @ 15:04:05

        ┌──────────────────────────────────────────────────┐
        │  count           10                              │
        │  sum             0.896                           │
        │  schema          3          ← bucket resolution  │
        │  zero_threshold  1e-4                            │
        │  zero_count      0                               │
        │  buckets         [3, 2, 3, 1, 1, …]              │
        └──────────────────────────────────────────────────┘
```

- **No `_bucket`, no `_sum`, no `_count` series exist.** This is the single most important sentence
  on this page. `rate(X_sum[5m])` against a native histogram parses, reports success, and matches
  nothing — **forever**. A panel empty because the query is wrong looks exactly like a panel empty
  because nothing happened.
- **Buckets are exponential and automatic.** No boundaries are chosen at instrumentation time, and
  they cover microseconds to minutes at a fixed *relative* precision.
- **`schema` is the resolution.** Bucket width factor is `2^(2^-schema)`, so:

```
   schema 0   factor 2       │1│  2  │    4    │        8        │   coarse
   schema 1   factor 1.41    │ │ │  │  │   │   │    │     │      │
   schema 3   factor 1.09    ││││││││││││││││││││││││││││││││││││   fine
```

  Each step **down** merges adjacent bucket pairs — which is how a store enforces a bucket ceiling:
  it *downscales*, silently halving your resolution rather than rejecting the sample.
- **`zero_count` / `zero_threshold`** hold observations too close to zero for exponential bucketing
  (an exponential ladder never reaches 0). Anything with `|value| ≤ zero_threshold` lands here.
- **`schema: -53` means custom bucket boundaries** instead of exponential — how a classic histogram
  is represented in the native format. Such histograms are generally *not* mergeable with each
  other, so it is a compatibility feature, not a default.

### The third kind: summaries

Worth knowing so you can recognise and avoid it. A **summary** exports quantiles computed *in the
client*:

```
http_request_duration_seconds{quantile="0.99"}   0.14
```

Those numbers cannot be aggregated. **There is no way to combine the p99 of three instances into the
p99 of the service** — averaging percentiles is meaningless. That is the reason this repo puts
histograms in the service and computes every percentile and share at query time.

---

## 4. Reading the same picture six ways

Every function below is looking at *this* histogram:

```
    3    2    3    1    1        counts
   ███  ██  ███   █    █
   ─────────────────────────────────────────────────────► ms
   0    25   50  100  250  1000
```

### `histogram_count` — how many observations

```
   ███  ██  ███   █    █
    3  + 2 + 3  + 1  + 1   =   10          ← exact, carried in the sample
```

### `histogram_sum` — total of all values observed

```
   12+18+23 + 31+47 + 52+68+95 + 140 + 410  =  896 ms    ← exact, carried in the sample
```

Note it is **not** derivable from the buckets. It is accumulated separately, which is why it stays
exact no matter how coarse the buckets are.

### `histogram_avg` — the mean

```
   sum / count  =  896 / 10  =  89.6 ms
```

Exact, and the reason "average latency" is cheap. Also the reason it is misleading: nothing observed
was anywhere near 89.6 ms, and the single 410 ms request pulled the mean up by 36 ms all by itself —
the other nine average 54 ms.

### `histogram_fraction(lower, upper, …)` — what share fell in a range

*You give it a latency range. It gives you a share.*

```
   histogram_fraction(0, 0.1, X)      "what share came back within 100 ms?"

   ▓▓▓  ▓▓  ▓▓▓ │  █    █
    3    2    3 │  1    1
   ─────────────┼──────────────►
   0   25  50  100  250  1000
                │
        8 of 10 are left of the line   →   0.8
```

**This is the SLI shape.** An objective is "95% of requests under 200 ms", so the query that tests
it fixes the latency and asks for the share.

The mirror image gives you the miss rate directly:

```
   histogram_fraction(0.1, +Inf, X)   =   0.2      "what share was too slow?"
```

### `histogram_quantile(φ, …)` — how slow was the slowest φ

*You give it a share. It gives you a latency.*

```
   histogram_quantile(0.9, X)         "90% of requests were faster than what?"

   ███  ██  ███   █  │ █
    3    2    3    1 │ 1
   ─────────────────┼──────────────►
   0   25  50  100  │250  1000
                    │
        90% of the observations are left of here  →  ~250 ms
```

### `histogram_stddev` / `histogram_stdvar` — how spread out

```
   tight                          wide
   ░░███████░░                    ██░░░░██░░██
   low stddev                     high stddev
```

Rarely what you want for latency — the distribution is not symmetric, so a standard deviation
describes it badly. Listed for completeness.

---

## 5. Fraction and quantile are inverse functions

This is the pair that gets mixed up, and choosing the wrong one produces a number that looks
plausible and cannot be budgeted.

```
                        you supply              you get back
                     ┌──────────────┐        ┌──────────────┐
   fraction          │  a LATENCY   │───────►│  a SHARE     │      "97.2% were under 200 ms"
                     │   200 ms     │        │    0.972     │
                     └──────────────┘        └──────────────┘

                     ┌──────────────┐        ┌──────────────┐
   quantile          │  a SHARE     │───────►│  a LATENCY   │      "p95 was 180 ms"
                     │    0.95      │        │   180 ms     │
                     └──────────────┘        └──────────────┘
```

On one axis:

```
                  fraction: fix x, read y
                          ────────────►
   share  1.0 ┤                    ╭──────────────
              │                ╭───╯
        0.95  ┤ ─ ─ ─ ─ ─ ─╭──╯ ●
              │         ╭──╯    ╷
              │    ╭────╯       ╷
          0   ┼────╯────────────┴─────────────────► latency
                                180 ms
                          ◄────────────
                  quantile: fix y, read x
```

**Which to use:**

| | use it for |
|---|---|
| `histogram_fraction` | an **SLI**. Objectives are stated as a share against a fixed deadline, and a share is the only form that turns into an error budget. |
| `histogram_quantile` | **exploring**. Deciding what a deadline should be, or seeing how far past it the tail runs. |

A percentile cannot be budgeted: "p95 was 180 ms" tells you nothing about *how many* requests you can
still afford to disappoint this week.

---

## 6. Working with them over time: `rate()` first

A histogram is a set of **counters**. They only go up, and they reset when the process restarts. So
the raw value is nearly useless — what you want is what happened *during a window*.

```
  15:00   count=1000   ███████ ████ ██
  15:01   count=1300   ████████ █████ ███         each bucket has grown
          ──────────────────────────────
  rate over 60s   →    a HISTOGRAM whose every bucket is a per-second rate
```

`rate()` over a native histogram returns **another histogram**, with the counter-reset handling
already applied:

```
   raw counter:   1000 ── 1300 ──┐
                                 └── 0 ── 200        a restart drops it to zero
                     ▲
   rate() recognises the drop as a reset and bridges it.
   Reading the counter yourself sees a huge negative step instead.
```

### `rate()` is per-second, by definition

This is fixed. The range in `rate(X[5m])` controls **how much data is averaged**, never the unit of
the answer — `rate(X[5m])` and `rate(X[1h])` are both "per second", the hour version merely smoother.

There is no per-minute or per-5-second variant. If you want another unit, multiply:

```
   rate(X[5m])        →  3.4      per second
   rate(X[5m]) * 5    →  17       per 5 seconds
   rate(X[5m]) * 60   →  204      per minute
   increase(X[5m])    →  1020     over the whole window   (= rate × 300)
```

Asking for a genuinely short window instead — `increase(X[5s])` — is a different thing, and usually
fails: a range vector needs **at least two samples inside it**, so the range cannot be shorter than
about twice the scrape or export interval. Ask for `[5s]` on a series that arrives every 15s and you
get no data at all, with no error.

**The order is forced, and it is `rate()` first:**

```promql
histogram_count(rate(X[5m]))     ✅   rate a histogram → a histogram → read its count
rate(histogram_count(X)[5m])     ❌   count first → a float → rate() has nothing to rate
```

The second line is a **type error**, not a silently wrong answer — `histogram_*` functions return
plain floats and `rate()` needs a range vector. It is the one mistake in this area that fails loudly.

### The unit trap

`histogram_count(rate(X[5m]))` is **not a count**. `rate()` already converted it to a per-second
rate:

```
   histogram_count(rate(X[5m]))       →   3.4          requests per SECOND
   histogram_count(increase(X[5m]))   →   1020         requests, over the window
                    ▲
             use increase() when you want an actual count
```

Nothing in the syntax hints at this, and a panel labelled "requests" will cheerfully show a number
300× too small on a 5-minute window.

**Inside a ratio it does not matter** — numerator and denominator are both per-second rates and the
units cancel. That is why an SLI built this way needs no conversion anywhere.

---

## 7. Aggregating: histograms add, floats do not

Your service runs on more than one instance, so the data arrives split across several series. Putting
them back together is where most wrong SLI numbers come from — and the reason is a single property:

> **Two histograms can be added back into one real histogram. Two summary numbers cannot.**

### Histograms add, bucket by bucket

Two instances, one five-minute window. Every bucket boundary is the same on both sides, so "how many
landed between 50 and 100 ms" from each simply adds:

```
   bucket:         0–50   50–100   100–200 │ 200–500   500+      count     sum
   ──────────────────────────────────────────────────────────────────────────────
   instance A       300     180        90  │     20      10        600    54.0 s
   instance B        60      90        90  │     40      20        300    45.0 s
   ──────────────────────────────────────────────────────────────────────────────
   sum()            360     270       180  │     60      30        900    99.0 s
                    └──────────────────────┘
                     810 requests under 200 ms
```

Nothing was estimated and nothing was lost. The result is **still a histogram** — you can take a
fraction, a quantile or a mean of it, exactly as if one instance had served all 900 requests.

### Summary numbers do not add — they have already thrown the size away

Now do it the other way round: ask each instance for its own share first, then try to combine.

```
                     requests    under 200 ms     its own share
   ───────────────────────────────────────────────────────────────
   instance A            600            570          0.95          ← carries 2/3 of the traffic
   instance B            300            240          0.80
   ───────────────────────────────────────────────────────────────
   the truth             900            810          0.90   ✓
   average of shares       —              —          0.875  ✗   2.5 points off
```

`0.95` does not remember that it came from 600 requests. The moment the fraction was taken, the
population size was discarded — so averaging afterwards silently weights a quiet instance exactly
like a busy one. With a 10,000-request instance and a 3-request one, the error is not 2.5 points, it
is 30.

### The pipeline, with the actual values at every step

Same data, followed through both orderings. Read the left column top to bottom.

**✅ Right — aggregate the histograms, then read one number off the result**

```
   ① http_request_duration_seconds{route="/items"}[5m]          RANGE VECTOR of histograms
      ────────────────────────────────────────────────────────────────────────────────────
      {instance="A"}  15:00  count=41,400  sum=3,726.0 s        raw counters, since start
                      15:05  count=42,000  sum=3,780.0 s        (+600 requests, +54.0 s)
      {instance="B"}  15:00  count=20,100  sum=3,015.0 s
                      15:05  count=20,400  sum=3,060.0 s        (+300 requests, +45.0 s)

               │  rate( … [5m] )          divide everything by the 300-second window
               ▼

   ② instant vector of HISTOGRAMS — still one per instance, labels intact
      ────────────────────────────────────────────────────────────────────────────────────
      {instance="A"}  count 2.0/s   sum 0.180/s   buckets [1.0, 0.6, 0.3, 0.067, 0.033]
      {instance="B"}  count 1.0/s   sum 0.150/s   buckets [0.2, 0.3, 0.3, 0.133, 0.067]

               │  sum( … )                 add the histograms bucket by bucket
               ▼

   ③ ONE HISTOGRAM
      ────────────────────────────────────────────────────────────────────────────────────
      count 3.0/s   sum 0.330/s   buckets [1.2, 0.9, 0.6, 0.200, 0.100]

               │  histogram_fraction(0, 0.2, … )
               ▼

   ④ ONE FLOAT
      ────────────────────────────────────────────────────────────────────────────────────
      (1.2 + 0.9 + 0.6) / 3.0  =  2.7 / 3.0  =  0.90          ✓ the true share
```

**❌ Wrong — read a number off each instance, then try to combine the numbers**

```
   ① … ② identical to above.

               │  histogram_fraction(0, 0.2, … )   applied to EACH series
               ▼

   ③' TWO FLOATS — labels still attached, which is what makes this look reasonable
      ────────────────────────────────────────────────────────────────────────────────────
      {instance="A"}   (1.0 + 0.6 + 0.3) / 2.0  =  1.9 / 2.0  =  0.95
      {instance="B"}   (0.2 + 0.3 + 0.3) / 1.0  =  0.8 / 1.0  =  0.80

               │  avg( … )
               ▼

   ④' ONE FLOAT
      ────────────────────────────────────────────────────────────────────────────────────
      (0.95 + 0.80) / 2  =  0.875                             ✗ 600 requests weighted
                                                                like 300
```

The two pipelines differ only in **where the aggregation happens**, and they disagree by 2.5 points
on data where nothing was broken.

### What a `histogram_*` call actually destroys

Not the labels — the **distribution**.

```
   function               type afterwards        labels afterwards
   ────────────────────────────────────────────────────────────────
   rate(X[5m])            histogram              kept
   sum by (route) ( … )   histogram              only `route`
   histogram_count( … )   float                  kept
   histogram_fraction( )  float                  kept
```

This is worth being precise about, because the labels surviving is exactly what makes step ③' above
*look* fine — you get a tidy per-instance series with a legend and everything. Grouping still works
after a `histogram_*` call. It is the arithmetic that has stopped being valid, not the query.

### So when does the order actually matter?

It depends on whether the readout is **linear**:

| readout | linear? | does the order matter? |
|---|---|---|
| `histogram_count` | **yes** | no — same answer either way |
| `histogram_sum` | **yes** | no — same answer either way |
| `histogram_avg` | no | **yes** — aggregate the histograms first |
| `histogram_fraction` | no | **yes** |
| `histogram_quantile` | no | **yes** |
| `histogram_stddev` / `stdvar` | no | **yes** |

Counts and sums genuinely do not care — adding per-series counts and counting the summed histogram
are the same arithmetic:

```
   sum by (route) (histogram_count(rate(X[5m])))     →   2.0 + 1.0  =  3.0
   histogram_count(sum by (route) (rate(X[5m])))     →              =  3.0     identical
```

That is why a mean written as `sum by (route) (histogram_sum(…)) / sum by (route) (histogram_count(…))`
is correct: it is a ratio of two *linear* readouts, so each may be aggregated after the fact. Write
the same mean as `avg(histogram_avg(…))` and it is wrong, for the reason in the table above.

Everything else — every share, every percentile — has to be computed **once, on the combined
histogram**.

### One more reason: `NaN` on an idle series

Beyond the weighting error, per-series fractions are fragile. A series with **zero** observations in
the window produces `0/0 = NaN` for its own fraction, and a single `NaN` poisons the average it is
fed into:

```
   {instance="A"}   0.95
   {instance="B"}   0.80
   {instance="C"}   NaN        ← draining, or just started: no requests in this window
   ─────────────────────────
   avg( … )         NaN        the whole panel goes blank
```

Summed histograms have no such problem: an empty histogram contributes zero to every bucket and
disappears. This is not a corner case — it happens on **every deploy**, while the retiring instance
still lingers inside the range window.

### Classic histograms: keep `le` alive

The same rule, with one extra hazard. Aggregating a classic histogram must preserve `le`, or
`histogram_quantile` has no bucket boundaries left to interpolate between:

```promql
histogram_quantile(0.9, sum by (job, le) (rate(X_bucket[5m])))    ✅
histogram_quantile(0.9, sum by (job)     (rate(X_bucket[5m])))    ❌  le dropped → NaN
```

Native histograms carry their boundaries inside the sample, so there is no `le` to lose — a whole
category of mistake that simply stops existing.

---

## 8. Putting it together: an SLI

Everything above, assembled into the shape this repo actually uses — the share of requests that met
a deadline, over a rolling window:

```promql
histogram_fraction(0, 0.2, sum(rate(http_request_duration_seconds[5m])))
│                  │   │    │   │
│                  │   │    │   └─ 1. rate() first, over the window
│                  │   │    └───── 2. sum() the histograms, so all instances count once
│                  │   └────────── 3. the deadline, in the histogram's own unit (seconds)
│                  └────────────── 4. from zero, i.e. "fast enough"
└───────────────────────────────── 5. a share, 0..1 — the only form an objective can be stated in
```

And the count of good requests, when several deadlines have to roll into one number:

```promql
histogram_fraction(0, 0.2, sum(rate(X[5m])))  *  histogram_count(sum(rate(X[5m])))
        └── a share, 0..1 ──┘                       └── how many requests ──┘
                                    =  a COUNT of requests that met 200 ms
```

Shares measured against *different* deadlines cannot be added — they are shares of different-sized
populations. Counts of good requests can. That multiplication is the hinge the multi-class SLI turns
on, and it is worked through in `docs/sli-queries.md`.

---

## Vocabulary

| term | meaning |
|---|---|
| **bucket** | a value range, and a counter of how many observations landed in it |
| **`le`** | *less than or equal* — the label carrying a classic bucket's upper boundary |
| **`+Inf`** | the last classic bucket; always equals `_count` |
| **`_bucket` / `_sum` / `_count`** | the three series a classic histogram exposes; **none exist for a native histogram** |
| **cumulative** | classic buckets each include every bucket below them |
| **native histogram** | one series whose samples carry buckets, count and sum together |
| **schema** | native bucket resolution; width factor is `2^(2^-schema)`, so higher = finer |
| **downscaling** | merging adjacent bucket pairs to fit a ceiling — silently halves resolution |
| **zero bucket** | holds observations within `zero_threshold` of zero, which exponential buckets cannot reach |
| **summary** | client-computed quantiles; **cannot be aggregated across instances** |
| **exemplar** | a sampled trace id attached to a bucket, linking a slow bucket to one real request |
