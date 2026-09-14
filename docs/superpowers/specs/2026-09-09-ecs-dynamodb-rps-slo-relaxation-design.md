# ecs-dynamodb-rps — relaxing the latency objective so a burn is legible

- **Date:** 2026-09-09
- **Status:** **in progress** — `slo.yaml` and every generated and hand-maintained output are
  changed and the test suite passes (98/98). **Not applied.** `terraform -chdir=infra/main apply`
  and `./scripts/upload-k6.sh` have not been run, so Grafana Cloud and the k6 project still carry
  the 99% / 99.9% configuration. *(2026-09-14: that holds only until the next `/env down`, which now
  destroys the k6 project and its uploaded tests —
  `docs/superpowers/specs/2026-09-14-ecs-dynamodb-rps-k6-project-ownership-design.md`. After the next
  `/env up`, whatever `upload-k6.sh` uploads is what the project carries.)*
- **Project directory:** `ecs-dynamodb-rps/`
- **Amends:** `docs/superpowers/specs/2026-08-29-ecs-dynamodb-rps-ceiling-design.md` — replaces the
  99% / 99.9% objectives in *The objective*. And
  `docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-slo-scope-design.md` — narrows **P5**
  ("the burn-rate alerts stay armed and stay meaningful"), which stays true but not for the same
  rule. It leaves **§6** standing: raising the class thresholds was rejected there and is rejected
  here too, for the same reason.
- **Evidence:** the arithmetic below was produced in-session by calling `burnWindows()`,
  `renderAlerts()` and `renderLocals()` out of `service/scripts/generate-slo.js`. **No load run was
  executed**, so no attainment or RPS figure in this document is a measurement; the two latency
  measurements cited are quoted from the 2026-09-01 spec.

---

## 1. The question

The error budget was being spent faster than it could be watched. At a 99% objective over a 7-day
window there was no regime — idle, constant, or stress — in which the budget drained *gradually*:
it was either already exhausted before a run started, or exhausted within the first minute of one.

The proposal was to drop the primary objective to **85%** and to loosen the latency class
thresholds for the same reason.

## 2. What the arithmetic said

**The window is not the lever, and cannot be one.** Grafana's SLO API refuses any window outside
7–32 days and Grafana Cloud Free retains 14, so 7d–14d is the whole legal range. More importantly
the intuition runs backwards: the budget is `(1 − objective) × requests in the window`, so a
*shorter* window shrinks the budget along with itself and burns faster, not slower. Going to 14d
is legal and merely doubles the budget, at the cost of stretching the alert windows from 14m/84m
to 28m/168m.

**Where the budget actually goes.** Percentage of the 7-day budget spent. Idle is derived from a
measurement (fast class meets 50 ms 96.67% of the time at idle, 2026-09-01 §2); the run rows are
*illustrative miss rates*, not measurements — nothing has been recorded for this project yet.

| scenario | 99% | 97% | 95% | 90% | 85% |
|---|---|---|---|---|---|
| Idle only — heartbeat, no run | 166% | 55% | **33%** | 17% | 11% |
| Constant at capacity — 5 min, 800 rps, 0.5% miss | 67% | 22% | **13%** | 7% | 4% |
| Discovery — 20 × 60 s, ~1000 rps, 8% miss | 779% | 260% | **156%** | 78% | 52% |
| Stress / spike — 5 min, 800 rps, 20% miss | 1736% | 579% | **347%** | 174% | 116% |

Three readings follow, and they matter more than the choice of number:

1. **The constant profile was never the problem.** At 99% a clean run at capacity spent 67% of the
   week — tight but fitting. Nothing about the run that is *supposed to pass* needed relaxing.
2. **Idle was the problem at 99%,** and it is a cause problem. The 166% is the cold-socket tail:
   the deferred **P4** defect (2026-09-01 §5), not a wrong threshold.
3. **The stress profile is supposed to exhaust the budget.** That is step 3 of the loop in
   `CLAUDE.md` — "drive load with k6 until the SLO burns". No single objective can make a 0.5%-miss
   run and a 20%-miss run both burn gradually; they are 40× apart. Choosing an objective is
   choosing which of the two is legible.

## 3. Why 85% was rejected

**A burn threshold is `multiplier × (1 − objective)`, compared against a miss rate, which cannot
exceed 1.** At 85% the latency-primary fast-burn rule fires above a **216%** miss rate — it can
never fire. Its slow-burn sibling needs 90%, a service that is effectively down. Both would sit in
the alert list rendering green forever, which is worse than not having them: a rule that cannot
fire looks exactly like a rule that has nothing to report.

| primary objective | fast burn (14.4×) fires above | slow burn (6×) fires above | |
|---|---|---|---|
| 99.0% — before | 14.40% | 6.00% | both usable |
| 97.0% | 43.20% | 18.00% | both usable |
| **95.0% — chosen** | **72.00%** | **30.00%** | both usable |
| 93.06% | 99.94% | 41.64% | fast burn at its limit |
| 90.0% | 144.00% | 60.00% | fast burn dead |
| 85.0% — proposed | 216.00% | 90.00% | fast burn dead, slow burn unreachable |

**93.06% is the floor** for a 14.4× multiplier (83.33% for 6×). The three alternatives to accepting
a dead rule were each rejected: retuning the multipliers destroys the "2% and 5% of budget"
derivation they encode; a separate `alerting_objective` key puts two objectives in one file, which
is the drift this repo's one-source rule exists to prevent; and deleting the two rules gives up the
latency page entirely.

## 4. Decision

| # | Decision | Rationale |
|---|---|---|
| **R1** | **The primary latency objective becomes 95.0%,** from 99.0%. | Five times the budget. Idle falls 166% → 33% and a clean constant run 67% → 13%, so a run's burn is legible rather than instantaneous, while both burn rules stay firable and the stress profile still burns the budget out — which is what step 3 of the loop is for. |
| **R2** | **The tail objective becomes 99.0%,** from 99.9%, in the same change. | Not cosmetic, and not optional. At 95% the primary rule pages only above a 72% miss rate — a very late page. At 99% the tail rule's fast burn lands at **14.4%** and its slow burn at **6%**: precisely where the primary rule sat before. The early warning **moves to the tail rule** rather than being lost. |
| **R3** | **The class thresholds do not move.** fast 50 ms, standard 200 ms, heavy 800 ms stand. | They are achievable — fast p99 15.38 ms warm against a 50 ms threshold — and §6 of the 2026-09-01 spec rejected raising them on grounds that still hold at idle. They are also what both k6 profiles derive `preAllocatedVUs` from (`0.55×50 + 0.15×50 + 0.25×200 + 0.05×800 = 125 ms`, hence the `× 0.125` factor); loosening them against a hard 100-VU cap would cut deliverable rps from 800 to as low as 266. |
| **R4** | **The window, the burn multipliers and the availability objective are unchanged.** 7d, 14.4×/6×, 99.9%. | §2 above: the window is pinned by the API and points the wrong way anyway. The multipliers encode the budget fractions, and R2 removes the reason to touch them. |
| **R5** | **The floor is enforced by a test, not by this document.** | `service/test/generate-slo.test.js` asserts `multiplier × (1 − objective) < 1` for every objective in `slo.yaml`. Verified red at 85% before being left green at 95%: *"latency primary at 85% makes the fast-burn rule unfirable: it needs a 216.0% miss rate."* |

Resulting alert set — six burn rules, none dead, windows unchanged at 14m/84m:

| rule | objective | fast burn | slow burn |
|---|---|---|---|
| latency-classes primary | 95.0% | 72.00% | 30.00% |
| latency-classes tail | 99.0% | 14.40% | 6.00% |
| availability | 99.9% | 1.44% | 0.60% |

## 5. Two drift defects found and fixed on the way

Neither was caused by this change; both were found because this change moved a number that should
have moved with it and did not.

- **`infra/k6/tests/discovery.js` was pinned to `rate>0.99` as a literal, twice** — the
  `abortOnFail` stop and the per-step threshold. The discovery profile would have kept measuring
  the knee against 99% while every other artifact said 95%, silently. `renderK6` now emits
  `SLO_MET_RATE` and the profile imports it, so the number cannot be retyped.
- **The `/loadtest` skill read the per-step threshold by literal key,** `.value.thresholds["rate>0.99"]`.
  The key *is* the threshold's own source text, so any objective change turns every step into
  `breached=null`, printed rather than raised. It now reads the single threshold by position.

Also updated because they hold hardcoded copies the generator does not reach:
`infra/grafana/dashboard.json.tftpl` (panel 19's colour stops, `0.99`/`0.999` → `0.95`/`0.99`, and
its `min` from 0.95 to 0.9 so the objective line stays on the plot), and section 2 and 4 of the
project README.

## 6. What remains

**This is not applied.** In order:

1. `terraform -chdir=infra/main plan`, review, then apply — **stops for approval** per `CLAUDE.md`.
   This is what moves the SLO object, the six burn rules and the dashboard.
2. `./scripts/upload-k6.sh` — the README lists this as a known gap: it is manual and *silent when
   skipped*. Until it runs, Grafana Cloud k6 executes the old thresholds and any cloud run reports
   against the old objective.
3. The first recorded run, into a `results.md` that does not yet exist. Every number in this
   document that describes a run is arithmetic, and stays arithmetic until then.

**P4 remains deferred and is now the largest item on the idle meter.** 33% of the week's budget with
no load running is better than 166%, but it is still the cold socket, and 2026-09-01 §5 lists the
conditions that would reopen it. Relaxing the objective did not fix it; it made it affordable.
