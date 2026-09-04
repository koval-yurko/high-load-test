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

Generates `<project>/infra/main/capacity.auto.tfvars`:

```hcl
# GENERATED from slo.yaml by /slo. Do not edit by hand.
read_capacity  = 1025   # 1.025 x 1000 rps
write_capacity = 200    # 0.200 x 1000 rps
```

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

## Generated output 3 — Terraform capacity variables

Into `<project>/infra/main/capacity.auto.tfvars`, from the `capacity:` block. Terraform loads
`*.auto.tfvars` automatically, so no `-var-file` flag changes. Note `.gitignore` covers
`*.auto.tfvars` at the repo root — for a generated, non-secret file that is wrong; add a negation
(`!<project>/infra/main/capacity.auto.tfvars`) so the derived capacity is committed alongside the
`slo.yaml` it came from.

## `--check`

Compare `slo.yaml` against both generated files and report drift without writing anything. Run this
before quoting an SLO figure in a result — if k6 and Grafana disagree, every attainment number from
that project is suspect until it is resolved.

## Interaction with load testing

`/loadtest` reads the same thresholds. A k6 run that breaches is the same event that would burn budget
in production — that correspondence is the entire point of this repo, so keep the k6 threshold and the
Grafana rule expressing one objective, not two similar ones.
