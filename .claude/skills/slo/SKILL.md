---
name: slo
description: Define a project's SLIs and SLOs in one file and generate both the k6 thresholds and the Grafana alert rules from it, so the two never drift. Use when defining, changing, or reviewing SLOs, error budgets, or alerting for a project in this repo.
---

# SLO definition and generation

Usage: `/slo <project>` (generate/refresh) · `/slo <project> --check` (report drift only)

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

## Generated output 1 — k6 thresholds

Into `<project>/k6/thresholds.js`, imported by every profile so no profile can quietly assert
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

Into `<project>/grafana/alerts.tf` as `grafana_rule_group` resources, applied by Terraform (SLOs are
code — never click these into the UI).

Alert on **error-budget burn rate**, not on the raw SLI. A latency alert that fires on every momentary
p95 spike gets muted within a week and then protects nothing. Two windows is the standard shape:

- **Fast burn** — budget being consumed ~14.4× faster than sustainable over 1h → page.
- **Slow burn** — ~6× over 6h → ticket.

For a 99.5% objective the sustainable error rate is 0.5%, so fast burn triggers at roughly 7.2% errors
sustained for an hour. Write the computed number into the rule's annotation so the reader can check it.

## `--check`

Compare `slo.yaml` against both generated files and report drift without writing anything. Run this
before quoting an SLO figure in a result — if k6 and Grafana disagree, every attainment number from
that project is suspect until it is resolved.

## Interaction with load testing

`/loadtest` reads the same thresholds. A k6 run that breaches is the same event that would burn budget
in production — that correspondence is the entire point of this repo, so keep the k6 threshold and the
Grafana rule expressing one objective, not two similar ones.
