# ecs-dynamodb-rps-ceiling — what the SLO is defined over

- **Date:** 2026-09-01
- **Status:** **complete** (2026-09-01). Decisions P1–P5 taken by the user after the observability
  shakedown produced the measurements in §2, and all five are realized: the scope is documented in
  `ecs-dynamodb-rps-ceiling/slo.yaml` and in sections 3 and 4 of that project's README, nothing was
  filtered at source (`npm run slo:check` confirms the generated artifacts are byte-identical), the
  cold-socket tail is recorded as a known defect with its reopening conditions, and the burn-rate
  alerts were left untouched.
  **One prerequisite it identifies is still outstanding**, and P2 cannot be computed until it lands:
  k6 traffic cannot be isolated by `traffic_source`, because k6 v1.4.0 sends no `k6/`-prefixed
  User-Agent and both shakedown runs landed under `other`. That work is Task 1 Step 0 of
  `docs/superpowers/plans/2026-09-02-ecs-dynamodb-rps-ceiling-scale-and-measure.md` — see §4 here.
  > Project renamed to `ecs-dynamodb-rps` on 2026-09-03; paths and names below are pre-rename. See `docs/superpowers/specs/2026-09-02-ecs-dynamodb-rps-restructure-design.md`.
- **Project directory:** `ecs-dynamodb-rps-ceiling/`
- **Amends:** `docs/superpowers/specs/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection-design.md` —
  settles **§17.1** and narrows the error-budget claim in **§1** and **§7**. It reverses nothing:
  every decision S1–S18 stands, and the SLI is still computed exactly as S3/S4 describe. What changes
  is which number is **authoritative**, not how any number is produced.
- **Evidence:** `.superpowers/sdd/2026-09-01-ecs-dynamodb-rps-ceiling-observability-shakedown/report.md`

---

## 1. The question

The 2026-08-30 spec built a continuously-computed SLI so that "an error budget accrues between load
tests". It does accrue. The shakedown found that at idle it accrues **against** the service, and had
been doing so since before that plan completed: on 2026-09-01 at 08:18Z, with no load running, the
7-day window read **0.98474 against a 0.99 objective** — 152% of the error budget already spent.

So: is the objective wrong, is the service broken, or is the measurement being asked a question it
cannot answer?

## 2. What was measured

The breach is entirely in the **fast** class (`getItem`, `putItem`, 50 ms threshold). `standard` and
`heavy` meet their thresholds 100% of the time at idle. Same class, same threshold, two regimes:

| | COLD — heartbeat, ~1 req/min | WARM — 60 rps, unthrottled |
|---|---|---|
| p50 | 4.99 ms | 2.99 ms |
| p95 | 31.93 ms | 4.76 ms |
| p99 | **129.41 ms** | **15.38 ms** |
| `db` p99 | 129.41 ms | 14.73 ms |
| **meets 50 ms** | **0.96667** | **0.99428** |

Three things follow directly:

1. **The threshold is achievable.** Under load the fast class beats the 99% objective with headroom,
   at a p99 of 15 ms against a 50 ms threshold.
2. **The tail is inside the DynamoDB call.** `db` p99 equals total p99 at idle, so it is neither Node,
   nor the ALB, nor the network to the client.
3. **It is not every request.** p50 is 4.99 ms, not 129 ms, so the socket usually survives. Roughly
   **3.3% of fast requests** — about 2 per hour — pay a fresh TLS handshake to
   `dynamodb.eu-central-1.amazonaws.com` after their connection is reaped. `src/dynamo.js` sets no
   explicit keep-alive agent.

A 99% objective over 60 fast requests/hour permits 0.6 misses/hour. Two misses breaches it. **The
population is too small for the objective to mean anything**: a single cold socket moves the hourly
SLI by 1.7 percentage points.

## 3. Decision

| # | Decision | Rationale |
|---|---|---|
| **P1** | **The SLO is defined over load-bearing traffic. The continuous 7-day window is informational.** | It is computed over a population of ~4 req/min whose noise floor exceeds the thing being measured. Reporting it as the service level would be reporting noise with three decimal places. |
| **P2** | **Authoritative attainment is run-scoped** — computed over a load run's own window, as `results.md` already records it. | This is the number the project exists to produce: attainment at a stated request rate, before and after a stated infrastructure change. It has a population in the tens of thousands and a defined load shape. |
| **P3** | **Nothing is filtered at source, and no query changes.** The heartbeat stays in the population; `slo.yaml`, the generated queries, the SLO resource and the four burn rules are untouched. | S15 already made the population a *selector*, not a pipeline property. This decision is about interpretation, so it costs a comment and a README section — not a deploy. It also stays reversible: if P4 is ever taken, the history is intact. |
| **P4** | **The cold-socket tail is recorded as a known service defect, not fixed now.** | An explicit keep-alive agent on the DynamoDB client is the honest fix, and first-request-after-quiet is a real user experience. But it changes `src/`, needs an image rebuild and redeploy, and moves a number that no measurement in this project depends on — every run that matters is warm. Deferred, not dismissed: see §5. |
| **P5** | **The burn-rate alerts stay armed and stay meaningful.** | They fire on *rate of budget spend over 14m/84m windows*, not on the 7-day total. The shakedown drove them `inactive → pending → firing → inactive` against real load with the same configuration. A permanently-depressed 7-day figure does not degrade them. |

> **⚠ P5 still holds, but not for the same rule** (R1/R2 of
> `docs/superpowers/specs/2026-09-09-ecs-dynamodb-rps-slo-relaxation-design.md`, 2026-09-09). The
> primary objective was relaxed 99% → 95%, and a burn threshold is `multiplier × (1 − objective)`,
> so the **latency-primary** fast-burn rule now pages above a 72% miss rate rather than 14.4% — a
> much later page. The tail objective went 99.9% → 99% in the same change specifically to carry
> that sensitivity: the **latency-tail** fast-burn rule now sits at 14.4%, exactly where the
> primary rule sat when this decision was written. All six burn rules remain firable, and a test
> now enforces the 93.06% floor below which they would not be. The windows are unchanged.
>
> §6 of this document is **not** amended: raising the class thresholds was rejected here and is
> rejected again there (R3), on the same grounds plus the k6 VU-sizing cost.

## 4. What this makes true, that was not before

- **"The SLO is in breach" is no longer a statement about the service.** Anyone reading the 7-day
  number needs §2's table to interpret it, which is why it now appears in the README rather than only
  in a report nobody opens.
- **§17.1 of the 2026-08-30 spec is settled**, in the direction it predicted: one metric, two
  selectors. Its own words — "a continuous SLO over `traffic_source != "k6"`, and run-scoped
  attainment for `results.md`" — are what P1/P2 adopt, with the correction that the continuous half
  is informational rather than authoritative.
- **`traffic_source` still cannot isolate a k6 run.** Measured 2026-09-01: `trafficSource()` is
  correct — a forged `k6/v1.4.0` User-Agent produces `traffic_source="k6"` — but **k6 v1.4.0 does not
  send one**. Both shakedown runs landed in `other` (60.01/s and 115.46/s). Selecting
  `traffic_source="k6"` returns an empty population, which reads exactly like a healthy silence.
  P2 depends on isolating a run's window, so **this must be fixed before the first recorded run**:
  set `userAgent` in the k6 `options`, or add an explicit header in `k6/lib/request.js`. That is a
  change to a k6 script and must therefore land **before** the freeze, not after.

## 5. Deferred, with the condition that would reopen it

**P4 — fixing connection reuse.** Reopen if any of these becomes true:

- A recorded run's *warm* fast-class attainment approaches 99%. It sat at **0.99428 at only 60 rps**,
  which is 0.43 points of margin at trivial load. If the discovery run shows that margin shrinking,
  the cold-socket path is no longer the only thing consuming the fast class's budget and the client
  configuration is worth revisiting on its own merits.
- The project ever claims a *continuous* service level rather than a run-scoped one.
- `lambda-concurrency-limit` reuses this SLI contract (S5's portability claim), where cold connections
  are the normal case rather than an idle artifact.

## 6. Out of scope

Raising the fast-class threshold, and raising the heartbeat rate to keep sockets warm. Both were
considered and rejected on the same grounds: they make the number green without changing what the
service does. At a warm p99 of 15 ms a 150 ms threshold is met essentially always, and an SLO that
cannot fail is not an SLO.
