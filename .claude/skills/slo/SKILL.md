---
name: slo
description: Define a project's SLIs and SLOs in one file and generate both the k6 thresholds and the Grafana alert rules from it, so the two never drift. Use when defining, changing, or reviewing SLOs, error budgets, or alerting for a project in this repo.
---

# SLO definition and generation

Usage: `/slo <project>` (generate/refresh) · `/slo <project> --check` (report drift only)

Both run the project's own generator — there is no skill-level script:

```bash
cd <project>/service && npm run slo:generate     # rewrite the generated outputs
cd <project>/service && npm run slo:check        # exit 1 if any output has drifted
```

`--check` is what makes "one file, many outputs" a property rather than a promise. Run it before
any commit that touches `slo.yaml` or a generated file. The authoritative list of what is
generated is the `OUTPUTS` array in `<project>/service/scripts/generate-slo.js` — read it there rather
than trusting this page, because a file absent from that array is not checked for drift no matter
what the section headings below imply.

Until 2026-08-30 this skill was documentation only: the outputs were hand-written to the spec
below and "cannot drift" was enforced by discipline. It is a real generator now, proven by
regenerating the committed outputs and requiring them back byte for byte.

## Why this exists

Each SLO otherwise gets written twice — once as a k6 `threshold`, once as a Grafana alert — in two
syntaxes that nothing keeps in sync. The failure mode is silent and ugly: the dashboard asserts 99.9%
while k6 asserts 95%, both are green, and neither number means anything. **One source file, two
generated outputs.**

## The source file: `<project>/slo.yaml`

```yaml
service: ecs-document-db
window: 30d              # error-budget window
slos:
  - name: availability
    sli: success_rate    # share of requests that are not 5xx / not k6-failed
    objective: 99.5      # percent
  - name: latency
    sli: latency_percentile
    percentile: 95
    threshold_ms: 300
    objective: 99.0      # percent of requests under threshold_ms
```

Keep it small. An SLO you cannot explain to someone in one sentence will not survive contact with a
real incident.

### SLI type: `class_threshold_ratio`

For a service whose endpoints have different natural costs. A percentile cannot compose across them —
it measures the traffic mix, not the system — and it cannot produce an error budget. This type judges
each request against a threshold appropriate to its own class and reports one ratio.

```yaml
slos:
  - name: latency-classes
    sli: class_threshold_ratio
    objective: 99.0          # percent of requests meeting their class threshold
    tail_objective: 99.9     # percent meeting tail_multiplier x their threshold
    tail_multiplier: 3
    classes:
      fast:     { threshold_ms: 50,  endpoints: [getItem, putItem] }
      standard: { threshold_ms: 200, endpoints: [feed] }
      heavy:    { threshold_ms: 800, endpoints: [report] }
```

Every endpoint named in the service must appear in exactly one class. An endpoint in no class is
silently unmeasured, which is worse than an endpoint with a wrong threshold.

**Generated k6:** a custom `Rate` per objective plus tagged per-class sub-metric thresholds. The
per-class entries are diagnostic and are **not** the gate — the gate is the ratio.

**Generated Grafana:** `grafana_slo` takes a Success/Total ratio query, so this type maps onto it
directly; `latency_percentile` does not, and never did.

### The `capacity:` block

Where the SLO sizes the database. One file, so the objective and the provisioned capacity cannot
drift apart.

```yaml
capacity:
  target_rps: 1000
  mix: { read: 0.55, write: 0.15, feed: 0.25, report: 0.05 }
  cost_per_request:                 # capacity units, from the datastore's own rules
    read:   { rcu: 0.5, wcu: 0 }
    write:  { rcu: 0,   wcu: 1 }
    feed:   { rcu: 2.5, wcu: 0 }
    report: { rcu: 2.5, wcu: 1 }
```

Reports what it would provision, beside what `<project>/infra/main/dev.tfvars` actually sets:

```
capacity (advisory -- dev.tfvars is authoritative):
  RCU dev.tfvars  1025  |  model  1025  (0.55*0.5 + 0.25*2.5 + 0.05*2.5 = 1.025/rps x 1000 rps)
  WCU dev.tfvars   200  |  model   200  (0.15*1.0 + 0.05*1.0 = 0.200/rps x 1000 rps)
```

It does **not** write the capacity variables — see "Advisory output — capacity" below.

The `mix` shares must sum to 1.0. Refuse to generate otherwise — a mix that does not sum to one
produces capacity numbers that are quietly wrong rather than obviously wrong.

### `window:` and why the burn thresholds move with it

The familiar 14.4×/1h (page) and 6×/6h (ticket) burn rates are **derived**, not conventional. They
encode a fraction of the error budget consumed over the alert window:

```
14.4 x (1h / 720h) = 2% of budget      6 x (6h / 720h) = 5% of budget
```

Both fractions assume a **30-day** window. Shorten the window and leave the alert windows alone and
the same rules quietly mean something else — on a 3-day window, 20% and 50%. The generator therefore
scales the alert windows by `window / 30d` and holds the multipliers fixed.

Check your plan's retention before choosing a window. **Grafana Cloud Free retains metrics for 14
days**, so a 30-day objective on the free tier can never be evaluated over the window it claims.

Pick a window that divides cleanly. The scaled windows are rendered as whole units, so a window
that scales an alert window to a fraction of a second would emit a value the Grafana provider's
`^\d+(ms|s|m|h|d|w|y)$` duration regex rejects.

## Generated output 1 — k6 thresholds

Into `<project>/infra/k6/tests/lib/slo.js`, imported by every profile so no profile can quietly assert
something different:

```javascript
// GENERATED from slo.yaml by /slo. Do not edit by hand.
export const thresholds = {
  http_req_failed:   ['rate<0.005'],      // availability 99.5%
  http_req_duration: ['p(95)<300'],       // latency SLO
};
```

Note the translation: an availability objective of 99.5% becomes `rate<0.005` — the k6 metric counts
*failures*, so the objective is inverted. Getting this backwards produces a threshold that can never
fail. State the arithmetic in a comment on every generated line, as above.

## Generated output 2 — Grafana alert rules

Into `<project>/infra/grafana/alerts.tf` as `grafana_rule_group` resources, applied by Terraform (SLOs are
code — never click these into the UI).

Alert on **error-budget burn rate**, not on the raw SLI. A latency alert that fires on every momentary
p95 spike gets muted within a week and then protects nothing. Two windows is the standard shape:

- **Fast burn** — budget being consumed ~14.4× faster than sustainable over 1h → page.
- **Slow burn** — ~6× over 6h → ticket.

For a 99.5% objective the sustainable error rate is 0.5%, so fast burn triggers at roughly 7.2% errors
sustained for an hour. Write the computed number into the rule's annotation so the reader can check it.

**A low objective silently disarms the alert.** The threshold is `multiplier × (1 − objective)`
compared against a miss rate, which cannot exceed 1 — so once `14.4 × (1 − objective)` passes 100%
the fast-burn rule is asking for something impossible and renders green forever, while the alert list
still shows a healthy-looking rule. **The floor is 93.06% for a 14.4× multiplier and 83.33% for 6×.**
This is why `ecs-dynamodb-rps` relaxed to 95% in 2026-09-09 rather than the 85% originally proposed
(`docs/superpowers/specs/2026-09-09-ecs-dynamodb-rps-slo-relaxation-design.md`). A test in that
project's `service/test/generate-slo.test.js` asserts it for every objective in the file; copy it
into any project that lowers an objective.

**Lower the tail objective alongside the primary.** A relaxed primary makes its own burn rule a very
late page (72% miss rate at a 95% objective). The tail objective, judged at `tail_multiplier ×` the
threshold, is where the early warning should then live — at 99% its fast burn sits at 14.4%, which is
where a 99% primary's did. Moving one without the other loses the warning entirely.

## Advisory output — capacity

`read_capacity` / `write_capacity` are **hand-set in `<project>/infra/main/dev.tfvars`** and the
`capacity:` block only reports what it would have chosen. Changed on 2026-09-18 (see
`docs/superpowers/specs/2026-09-18-ecs-dynamodb-rps-capacity-authority-design.md`); until then the
generator wrote `capacity.auto.tfvars` and byte-checked it, which made provisioned capacity — the
biggest line on the bill — the one knob that could not be turned where every other sizing knob
lives.

Two consequences worth keeping straight:

- **Nothing outranks `dev.tfvars` now**, and that is the point. It never could be outranked by a
  generated `*.auto.tfvars` (a CLI `-var-file` wins over an auto-loaded file), so the old split only
  made an override *silent*. TFC **workspace** variables and variable-set entries still outrank both,
  so a project pinning capacity that way must delete them — this is what made a 2026-09-02 run return
  `No changes` while the files said 1025/200.
- **A difference is not drift.** `--check` prints it with `<- differs` and still exits 0. The one
  hard failure is a capacity variable going *missing*: `variables.tf` gives it no default and nothing
  generates it any more, so an unset value stops the plan. A service test asserts `dev.tfvars` sets
  both.

Deviating deliberately (headroom to move the ceiling off the table, or a cheap run) is legitimate —
write the reason in a comment beside the number, or the next reader reads it as stale.

## `--check`

Compare `slo.yaml` against the generated files and report drift without writing anything, then print
the capacity advisory. Run this before quoting an SLO figure in a result — if k6 and Grafana
disagree, every attainment number from that project is suspect until it is resolved.

## Interaction with load testing

`/loadtest` reads the same thresholds. A k6 run that breaches is the same event that would burn budget
in production — that correspondence is the entire point of this repo, so keep the k6 threshold and the
Grafana rule expressing one objective, not two similar ones.
