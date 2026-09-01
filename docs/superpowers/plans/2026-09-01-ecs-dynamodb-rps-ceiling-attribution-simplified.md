# ecs-dynamodb-rps-ceiling Simplified Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the four-row attribution model that misattributed a DynamoDB throttling event to the service, and leave in its place two metrics a person reads side by side — request latency, and DynamoDB throttle events.

**Architecture:** Nothing new is built and no AWS resource changes. The generated query set swaps `ThrottledRequests` (which reads zero mid-throttle and is only published per-operation) for `ReadThrottleEvents` and `WriteThrottleEvents` (table-level, continuous, read/write-separated). The dashboard's headline throttling panel switches to the same pair. Every document that told a reader to derive a bound resource from a table stops doing so, and the results schema drops the three columns that existed to carry that derivation.

**Tech Stack:** Node.js 22 (`node:test`), `scripts/generate-slo.js` (the single generator behind six checked-in artifacts), Terraform ~1.14 with HCP Terraform remote execution, Grafana Cloud.

**Spec:** `docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-attribution-simplified-design.md`

**Amends:** unblocks `docs/superpowers/plans/2026-09-02-ecs-dynamodb-rps-ceiling-scale-and-measure.md`, whose Task 2 Step 5 currently instructs the reader to attribute the discovery run with the deleted table. Task 5 below rewrites that step. This plan numbers its own tasks from 1 and keeps its ledger at `.superpowers/sdd/2026-09-01-ecs-dynamodb-rps-ceiling-attribution-simplified/`.

---

## Status — **complete**, 2026-09-01

All seven tasks executed. Commits: Task 1 `dc9a4cb`, Task 2 `9c8a115`, Task 3 `8619039`, Task 4
`2e4fa08`, Task 5 `1594c26`/`90af238`/`fa07dbb`, Task 6 (approval gate, no commits — one Grafana
dashboard resource applied and verified by reading the live dashboard back), Task 7 (this
close-out, commit `873bed2`). See
`.superpowers/sdd/2026-09-01-ecs-dynamodb-rps-ceiling-attribution-simplified/report.md` for the
close-out evidence.

**Reopened after `873bed2`: a final whole-branch review found the deleted model still live in
places the plan's per-task greps never searched, because every one of those greps matched a metric
name or label (`ThrottledRequests`, `bound resource`, `four-row`) rather than the inference itself.
Two survivors were Critical and live on the applied dashboard — panel 22 restated the deleted
table's row three verbatim ("service-bound … not DB-bound", the exact rule the incident disproved),
and panel 23 restated its CPU fallback while citing a spec section that now carries a `⛔ DELETED`
banner. The fix wave and its residual rounds produced seven further commits:**

```
3198768 fix(ecs-dynamodb-rps-ceiling): stop the dashboard inferring a verdict
0dc2e2e docs(repo): retire the last bound-resource instructions
b16239f fix(ecs-dynamodb-rps-ceiling): readme no longer promises attribution
726403d docs(ecs-dynamodb-rps-ceiling): correct the otel.js discriminator claim
53b3c7b fix(ecs-dynamodb-rps-ceiling): clear the last live inference rules
63ff1f7 docs(ecs-dynamodb-rps-ceiling): correct the queueing-signal comment
c5d57dd docs(ecs-dynamodb-rps-ceiling): amend the db_ms banner at the decision
```

Between them: deleted the redundant dashboard panel 3 and widened panel 2 to full width (two
CloudWatch targets on one panel render two lines rather than summing, so panel 2 alone was never a
headline and panel 3 duplicated it — a defect in this plan's own Task 2 text); rewrote the
dashboard description and three row titles; corrected `capacity-model.html`, `CLAUDE.md`'s
citation-style example, and the scale-and-measure plan's Task 6 gate; and added dated `Withdrawn` /
`Amended 2026-09-01` notes at the decision itself in the 2026-08-29 and 2026-08-30 specs, per this
repo's superseding rule.

Two edits touched files this plan's own constraints named as off-limits, each under a controller
ruling recorded because otherwise they read as violations: `src/otel.js` (constraint: "no change to
`src/`") had one comment corrected — "CloudWatch SuccessfulRequestLatency remains the DB-bound
discriminator" is false, since that metric *falls* when the table throttles — and a comment-only
edit serves the constraint's own stated purpose (no image rebuild, no ECS redeployment), so it was
ruled in scope. `scripts/generate-slo.js` (the fix wave's own prohibition) had a comment corrected
under the same reasoning, precedented by Task 1's Ruling C4; `npm test` stayed 92/92, `npm run
slo:check` still agreed, and `queries.json` did not move.

A **second Grafana-only `terraform apply`** was approved by the human and verified: preflight
re-asserted account `042945885621`, org `failwin`, region `eu-central-1`; a stale plan captured
before `53b3c7b` was discarded and re-run rather than trusted; the fresh plan showed
`0 to add, 1 to change, 0 to destroy` on `module.grafana.grafana_dashboard.attribution`; HCP run
`run-reUZznWKVyZd7cnZ` reported `Apply complete! Resources: 0 added, 1 changed, 0 destroyed.`
(unlike the first apply, the log stream held); and the live dashboard was read back anyway —
version 5, 23 panels, panel 3 absent, panel 2 now full-width with both throttle targets. No target
on the live dashboard reads `ThrottledRequests`.

Controller verification at `c5d57dd`: `npm test` 92/92, `npm run slo:check` agrees, `terraform fmt
-check` clean, the dashboard template parses after substituting its `${...}` interpolations. Full
detail, including the repo-wide behavioural sweep that replaced the old per-file greps, is in
`.superpowers/sdd/2026-09-01-ecs-dynamodb-rps-ceiling-attribution-simplified/report.md`.

---

## Global Constraints

Copied from the spec; every task's requirements implicitly include these.

1. **Nothing computes a bound resource.** If a step leaves any artifact deriving "which resource
   caused this" from metrics, that step is wrong. The deliverable is two metrics and a human.
2. **No change to `src/`.** No container image rebuild, no ECS redeployment. The service is not
   touched by this plan.
3. **No AWS resource is created, changed or destroyed.** The Alloy collector already requests all
   three throttle metrics from CloudWatch (`ThrottledRequests`, `ReadThrottleEvents`,
   `WriteThrottleEvents` are all listed in `ecs-dynamodb-rps-ceiling/grafana/alloy.alloy.tftpl`), so
   its configuration is untouched.
4. **Exactly one `terraform apply`, against the Grafana provider only** (Task 6). It is not billable
   in AWS, but it is still an apply: it gets its own task and that task stops for approval.
5. **`grafana/queries.json` is generated, never hand-edited.** `npm run slo:check` byte-compares
   every generated artifact against `slo.yaml`; a hand edit fails it.
6. **CloudWatch throttle metrics are per-60-second sums exposed as gauges.** Read them directly.
   Never wrap one in `rate()` — it goes 0 → 5265 → 3964 → 0 as throttling starts and stops, and
   `rate()` treats every decrease as a counter reset.

---

## File Structure

| file | responsibility | task |
|---|---|---|
| `ecs-dynamodb-rps-ceiling/test/generate-slo.test.js` | asserts the generated query set carries the right keys | 1 |
| `ecs-dynamodb-rps-ceiling/scripts/generate-slo.js` | `renderQueries()` — the only place query text is authored | 1 |
| `ecs-dynamodb-rps-ceiling/grafana/queries.json` | generated output, byte-checked | 1 (regenerated) |
| `ecs-dynamodb-rps-ceiling/grafana/dashboard.json.tftpl` | panels 2 and 3 — the throttling panels | 2 |
| `ecs-dynamodb-rps-ceiling/README.md` | section 5, the reader-facing copy of the deleted table | 3 |
| `.claude/skills/loadtest/SKILL.md` | the results schema, the completeness check, the recording instructions | 4 |
| `docs/superpowers/plans/2026-09-02-…-scale-and-measure.md` | Task 2 Step 5, Task 7, its status block | 5 |
| `ecs-dynamodb-rps-ceiling/terraform` (Grafana module) | applying the dashboard change | 6 |

---

## Task 1: The generated query set swaps in the throttle-event metrics

**Files:**
- Test: `ecs-dynamodb-rps-ceiling/test/generate-slo.test.js:117-128`
- Modify: `ecs-dynamodb-rps-ceiling/scripts/generate-slo.js:499-502`
- Regenerate: `ecs-dynamodb-rps-ceiling/grafana/queries.json`

**Interfaces:**
- Produces: two new keys in `grafana/queries.json` — `read_throttle_events` and
  `write_throttle_events`, each a PromQL string. The key `throttled_requests` no longer exists.
  Tasks 3, 4 and 5 reference these names.

Run everything below from `ecs-dynamodb-rps-ceiling/`.

- [ ] **Step 1: Write the failing test**

Replace the key list in the existing test at line 117 and add a second test directly after it.

```js
test('queries.json carries one query per attribution key, all non-empty', () => {
  const doc = loadSlo(`${HERE}slo.yaml`);
  const q = JSON.parse(renderQueries(doc));
  for (const key of [
    'sli_ratio', 'db_wall_avg_by_route', 'cloudwatch_srl_by_operation',
    'queueing_ms_by_route', 'cpu_seconds_per_second', 'cpu_saturation_ratio',
    'eventloop_delay_p99', 'eventloop_utilization',
    'read_throttle_events', 'write_throttle_events',
  ]) {
    assert.ok(q[key] && q[key].trim().length > 0, `${key} missing from queries.json`);
  }
});

// ThrottledRequests is published ONLY with a TableName+Operation dimension pair, and its
// per-60s gauge reads 0 at instants during sustained throttling -- measured 2026-09-01 as
// "... 4156, 0, 4153, 4360 ..." while DynamoDB was rejecting 5588 reads/minute. Read and
// write throttle events are published at table level, continuously, and separate the two
// sides. See docs/superpowers/specs/2026-09-01-...-attribution-simplified-design.md.
test('queries.json does not offer ThrottledRequests as a signal', () => {
  const q = JSON.parse(renderQueries(loadSlo(`${HERE}slo.yaml`)));
  assert.equal(q.throttled_requests, undefined,
    'throttled_requests must not be reintroduced');
  for (const [key, expr] of Object.entries(q)) {
    assert.ok(!expr.includes('throttled_requests_sum'),
      `${key} still reads aws_dynamodb_throttled_requests_sum`);
  }
});

test('throttle-event queries read the gauge directly and are never rated', () => {
  const q = JSON.parse(renderQueries(loadSlo(`${HERE}slo.yaml`)));
  for (const key of ['read_throttle_events', 'write_throttle_events']) {
    assert.ok(!q[key].includes('rate('),
      `${key} wraps a per-60s CloudWatch gauge in rate(); every decrease reads as a counter reset`);
    assert.ok(q[key].includes('dimension_TableName="ecs-dynamodb-rps-ceiling"'),
      `${key} is not scoped to this project's table`);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- --test-name-pattern 'queries.json|throttle-event'
```

Expected: the first fails with `read_throttle_events missing from queries.json`; the second fails
because `q.throttled_requests` is still defined.

- [ ] **Step 3: Change the generator**

In `scripts/generate-slo.js`, replace the final entry of the object in `renderQueries()`:

```js
    // A per-60s-period gauge, not a counter -- never rate() this one.
    throttled_requests:
      `sum(aws_dynamodb_throttled_requests_sum{dimension_TableName="${doc.service}"})`,
```

with:

```js
    // Per-60s-period gauges, not counters -- never rate() these. They go
    // 0 -> 5265 -> 3964 -> 0 as throttling starts and stops, and rate() reads
    // every decrease as a counter reset.
    //
    // These replace ThrottledRequests, which is unusable as a discriminator on
    // two counts: it is published ONLY with a TableName+Operation dimension pair
    // (so a table-level CloudWatch CLI query matches nothing, forever), and its
    // Prometheus copy reads 0 at instants during sustained throttling. Read and
    // write events are published at table level and separate the two sides.
    read_throttle_events:
      `sum(aws_dynamodb_read_throttle_events_sum{dimension_TableName="${doc.service}"})`,

    write_throttle_events:
      `sum(aws_dynamodb_write_throttle_events_sum{dimension_TableName="${doc.service}"})`,
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- --test-name-pattern 'queries.json|throttle-event'
```

Expected: PASS.

- [ ] **Step 5: Regenerate the checked-in artifact and confirm only `queries.json` moved**

```bash
npm run slo:generate             # regenerates all six outputs
git diff --stat                  # expect ONLY grafana/queries.json
npm run slo:check                # expect: "slo.yaml and its generated outputs agree"
```

If any other generated file appears in the diff, stop — `renderQueries` is the only function this
task touches, so a change elsewhere means something unrelated was edited.

- [ ] **Step 6: Run the whole suite**

```bash
npm test
```

Expected: all tests pass. If exactly one test fails and the failure does not name a query key,
re-run once before investigating — an intermittent failure in the OpenTelemetry export test was
observed on 2026-09-01 under machine load and four subsequent runs were clean.

- [ ] **Step 7: Verify the two new queries return data from the live stack**

```bash
set -a && . ../.env && set +a
P="$GRAFANA_URL/api/datasources/proxy/uid/grafanacloud-prom/api/v1"
for k in read_throttle_events write_throttle_events; do
  EXPR=$(jq -r --arg k "$k" '.[$k]' grafana/queries.json)
  printf '%-24s ' "$k"
  curl -s -H "Authorization: Bearer $GRAFANA_AUTH" --get \
    --data-urlencode "query=$EXPR" "$P/query" | jq -c '.data.result[]?.value[1]'
done
```

Expected at idle: **`"0"` from each — a value, not an empty result.** Both series exist on this
stack and the collector emits the zero rather than omitting the series; that is what makes a `> 0`
test sound. An empty result means the query is wrong, not that nothing is throttling.

- [ ] **Step 8: Commit**

```bash
git add test/generate-slo.test.js scripts/generate-slo.js grafana/queries.json
git commit -m "fix(ecs-dynamodb-rps-ceiling): read throttle events, not ThrottledRequests"
```

---

## Task 2: The dashboard's headline throttling panel

**Files:**
- Modify: `ecs-dynamodb-rps-ceiling/grafana/dashboard.json.tftpl` — panel `"id": 2` and panel `"id": 3`

**Interfaces:**
- Consumes: nothing from Task 1. These panels read the CloudWatch datasource directly
  (uid `a4139e7c-dc84-47c8-b90b-d710ec0fe3fb`), not the Prometheus copies, so they are independent
  of `queries.json`.
- Produces: the panel numbers referenced by Task 3's README rewrite stay **2** and **3**. Do not
  renumber them — the README deep-links address panels by id.

- [ ] **Step 1: Retarget panel 2 from `ThrottledRequests` to `ReadThrottleEvents`**

Panel 2's single target currently reads:

```json
          "namespace": "AWS/DynamoDB",
          "metricName": "ThrottledRequests",
          "statistic": "Sum",
```

Change `"metricName"` to `"ReadThrottleEvents"`, and add a second target to the same panel so the
headline shows both sides summed on one chart. The second target is the existing first target with
`"refId": "B"` and `"metricName": "WriteThrottleEvents"`; copy every other field verbatim
(`datasource`, `namespace`, `statistic`, `dimensions`, `region`, `period`, `metricQueryType`,
`metricEditorMode`, `matchExact`).

- [ ] **Step 2: Replace panel 2's description, which currently states something false**

It reads:

> "The whole decision in one line: zero = DynamoDB is not the ceiling, non-zero = it is. This is the
> total across read+write throttling; if it climbs while the service is still hitting its SLI, the
> ceiling is the database, not the app or the ALB."

Replace with:

> "Was DynamoDB rejecting us? Non-zero means yes. Read this beside the latency panels: latency up
> with this non-zero means the database was the constraint; latency up with this at zero means it
> was not. Nothing here decides for you — the four-row attribution table that used to do that was
> deleted on 2026-09-01 after it named the service while DynamoDB was rejecting 5588 reads/minute.
> These are ReadThrottleEvents + WriteThrottleEvents, per-minute counts at table level.
> ThrottledRequests is deliberately not shown: it reads zero at instants during sustained
> throttling."

- [ ] **Step 3: Correct panel 3's description, which is now factually wrong**

It reads:

> "Splits the headline ThrottledRequests by side. ReadThrottleEvents currently reads zero because
> reads have not throttled yet in any run so far — keep the panel, it will populate once reads
> saturate. WriteThrottleEvents rising alone points at write capacity/WCU specifically, not the
> table as a whole."

Reads *have* since throttled — 5265, 3964, 5358, 5588 and 2380 per minute on 2026-09-01. Replace
with:

> "Splits the headline into read and write. Reads throttle first on this table: at the 55/15/25/5
> mix the capacity model costs 1.025 RCU per request against 0.2 WCU, so reads bind near 24 rps and
> writes not until ~125 rps. Measured 2026-09-01 at 250 rps: ReadThrottleEvents peaked at 5588/min
> while WriteThrottleEvents stayed at zero. WriteThrottleEvents rising alone points at write
> capacity specifically, not the table as a whole."

- [ ] **Step 4: Verify the template still renders**

```bash
terraform -chdir=terraform fmt -check
terraform -chdir=terraform validate
terraform -chdir=terraform plan -var-file=dev.tfvars
```

Expected: **exactly one resource changed** — the Grafana dashboard. If the plan proposes any AWS
resource change, stop: this task edits a dashboard template and nothing else. Do **not** apply here;
Task 6 owns the apply.

If `plan` fails with `"organization" must be set`, the root `.env` has not been sourced — direnv
does not load it in a non-interactive shell. Run `set -a && . ../.env && set +a` first.

- [ ] **Step 5: Commit**

```bash
git add grafana/dashboard.json.tftpl
git commit -m "fix(ecs-dynamodb-rps-ceiling/grafana): headline panel shows throttle events"
```

---

## Task 3: The README stops telling the reader to attribute

**Files:**
- Modify: `ecs-dynamodb-rps-ceiling/README.md` — section 5, "What is the bottleneck right now?"

**Interfaces:**
- Consumes: panel ids 2 and 3 from Task 2, unchanged.

Section 5 is a second, reader-facing copy of the deleted four-row table. It is the copy someone
actually consults during a run, so leaving it is worse than leaving the spec's copy.

- [ ] **Step 1: Replace the section's opening claim and its table**

Delete everything from the line `This is the project's core idea: don't just measure a ceiling, name
which resource caused it. Four` down to and including the fourth table row (the one beginning
`| everything above is flat, but ALB response time is up`). Replace with:

```markdown
Two questions, two metrics, read side by side. Nothing here computes a verdict.

| question | where to look | what it means |
|---|---|---|
| **How long is the endpoint taking?** | [SLI ratio](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=19&from=now-6h&to=now) and the latency panels | the service-side request duration the SLO is computed from |
| **Was DynamoDB rejecting us?** | [Throttle events (headline)](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=2&from=now-6h&to=now), split [read vs write](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=3&from=now-6h&to=now) | non-zero means DynamoDB refused requests; the SDK retried them with backoff, inside the service |

Latency up **and** throttle events non-zero → the database was the constraint; the knob is capacity.
Latency up **and** throttle events at zero → it was not; look at the service.

**Why there is no table here any more.** There used to be a four-row one that named the bound
resource for you. It was deleted on 2026-09-01, after being evaluated for the first time against a
case whose answer was known — 250 rps against a table provisioned at 25 read capacity units, with
DynamoDB rejecting 5,588 reads per minute. **It named the service.** When DynamoDB throttles, the
AWS SDK retries with backoff *inside the Node process*, so the service's own database timing climbed
to 642–938 ms while DynamoDB's own clock read 0.9–2.2 ms, and event-loop utilization pinned at 1.000
while CPU sat at 3–16%. Every signal that was supposed to indicate a service-bound ceiling is also a
symptom of the database failing. The reasoning is in
`docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-attribution-simplified-design.md`.

**A trap the deleted table fell into, worth not repeating by hand:** DynamoDB's
`SuccessfulRequestLatency` *falls* when the table throttles — 0.887 ms mid-throttle against 1.473 ms
at idle — because rejected requests are never served and so never enter the statistic. A flat or
falling DynamoDB latency is not evidence that DynamoDB is healthy.
```

- [ ] **Step 2: Keep the paragraphs that follow, with one correction**

The paragraph beginning "Two more panels feed row three specifically" refers to a row that no longer
exists. Change its opening to:

```markdown
Three more panels are worth reading when throttle events are at zero and the service still looks
slow: [Event-loop delay p99 by task](https://k0valchuk.grafana.net/d/agbp7d/ecs-dynamodb-rps-ceiling-e28094-attribution?viewPanel=24&from=now-6h&to=now)
```

Leave the rest of that paragraph, and both `NaN` caveat paragraphs, exactly as they are — they
describe panel behaviour, not attribution.

- [ ] **Step 3: Confirm no other section still promises attribution**

```bash
grep -n -i 'bound resource\|which resource caused\|four-row' README.md
```

Expected: no matches outside the explanatory paragraph added in Step 1.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(ecs-dynamodb-rps-ceiling): two metrics replace the bottleneck table"
```

---

## Task 4: The load-test skill drops the derived columns

**Files:**
- Modify: `.claude/skills/loadtest/SKILL.md`

This is the file `/loadtest` actually follows, so it is the one that decides what lands in
`results.md`.

- [ ] **Step 1: Fix the live query loop**

It currently iterates `sli_ratio queueing_ms_by_route cpu_saturation_ratio throttled_requests`.
Change the loop list to:

```bash
for k in sli_ratio read_throttle_events write_throttle_events cpu_saturation_ratio; do
```

and change the verification sentence that follows it to read:

> Verified live against this repo's stack (2026-09-01, idle service — expect `0`/`1`, not a live-run
> number): `sli_ratio` → `"1"`, `cpu_saturation_ratio` → `"0"`, `read_throttle_events` → `"0"`,
> `write_throttle_events` → `"0"`. Each returns a **value**, not an empty result — the collector
> emits the zero rather than omitting the series, which is what makes a `> 0` test sound.

- [ ] **Step 2: Delete the two paragraphs that derive a bound resource**

Delete the paragraph beginning `Read `bound resource` off the four-row attribution table (spec §5`
and the later paragraph beginning ``bound resource` and `evidence` are not optional.` — both in
full, including the four-way priority list at the end of the second. Also delete the two-row table
whose left column reads `bound resource` and `queueing ms`.

Replace the first of them with:

```markdown
**Nothing derives a bound resource.** The four-row attribution table this skill used to reference
was deleted on 2026-09-01 — it named the service while DynamoDB was rejecting 5,588 reads per
minute, because SDK retry backoff inflates every service-side signal. Record `throttles` as the peak
per-minute value of `read_throttle_events` and `write_throttle_events` over the run window, and let
whoever reads the row draw the conclusion from that plus the latency columns.
```

- [ ] **Step 3: Replace the results header with the fourteen-column schema**

```markdown
| date | profile | infra change | RPS | k6 attainment | service attainment | budget burn x | p95 fast/std/heavy | db ms | cpu ms | EL lag p99 | throttles | RCU/WCU | $/hr |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
```

Three columns are gone: `bound resource` and `evidence` (outputs of the deleted inference), and
`queueing ms` — the service's DB timing minus DynamoDB's own clock, which read 642–938 ms during the
incident while DynamoDB reported 0.9–2.2 ms, and is the number that made the service look guilty.

- [ ] **Step 4: Rewrite the completeness check with verified indices**

The existing check is wrong, and documents itself as verified. Against the old seventeen-column
header `$8` was `queueing ms` and `$9` was `k6 attainment` — not `k6 attainment` and
`service attainment` as claimed — so `service attainment`, at `$10`, was never validated at all.

```bash
awk -F'|' 'NR>2 && NF>3 && ($4 ~ /^ *$/ || $6 ~ /^ *$/ || $7 ~ /^ *$/ || $13 ~ /^ *$/) \
  { print "INCOMPLETE ROW:", $0 }' <project>/results.md
```

`$4` = infra change, `$6` = k6 attainment, `$7` = service attainment, `$13` = throttles.

- [ ] **Step 5: Prove the new indices, rather than counting pipes**

```bash
NEW='| date | profile | infra change | RPS | k6 attainment | service attainment | budget burn x | p95 fast/std/heavy | db ms | cpu ms | EL lag p99 | throttles | RCU/WCU | $/hr |'
echo "$NEW" | awk -F'|' '{for(i=2;i<NF;i++) printf "$%d=[%s]\n", i, $i}'
```

Expected: `$4=[ infra change ]`, `$6=[ k6 attainment ]`, `$7=[ service attainment ]`,
`$13=[ throttles ]`. Then confirm the check actually rejects a bad row:

```bash
printf '%s\n' "$NEW" '|---|' \
  '| 2026-09-02 | constant | baseline 1 task | 400 | 0.981 |  | 1.2x | 12/40/210 | 5.1 | 1.4 | 0.02 | 0 | 1025/200 | 0.3212 |' \
| awk -F'|' 'NR>2 && NF>3 && ($4 ~ /^ *$/ || $6 ~ /^ *$/ || $7 ~ /^ *$/ || $13 ~ /^ *$/) { print "INCOMPLETE ROW:", $0 }'
```

Expected: the row is printed — its `service attainment` is blank. Under the old check it passed.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/loadtest/SKILL.md
git commit -m "fix(repo): loadtest records throttle events, not a derived bound resource"
```

---

## Task 5: Unblock the scale-and-measure plan

**Files:**
- Modify: `docs/superpowers/plans/2026-09-02-ecs-dynamodb-rps-ceiling-scale-and-measure.md`

**Interfaces:**
- Consumes: the query names `read_throttle_events` / `write_throttle_events` from Task 1, and the
  fourteen-column schema and `awk` indices from Task 4.

- [ ] **Step 1: Replace that plan's Task 2 Step 5 attribution instructions**

Its table of four discriminator queries and the paragraph instructing the reader to "read it
top-down, `throttled_requests` first" both go. In their place:

```markdown
- [ ] **Step 5: Record what happened — two metrics, no verdict**

Read these two over the run window and write them into the row. Nothing computes a bound resource;
the four-row table that used to is deleted (see
`docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-attribution-simplified-design.md`).

| query in `grafana/queries.json` | what it answers |
|---|---|
| `sli_ratio`, plus the per-class latency panels | how long the endpoints took |
| `read_throttle_events`, `write_throttle_events` | whether DynamoDB was rejecting requests |

Latency up with throttle events non-zero: the database was the constraint, and the knob is capacity.
Latency up with them at zero: it was not.

**Two traps, both measured on 2026-09-01.** DynamoDB's `SuccessfulRequestLatency` *falls* when the
table throttles (0.887 ms mid-throttle against 1.473 ms idle), because rejected requests are never
served — a flat DynamoDB clock is not evidence of a healthy database. And the service's own database
timing, its event-loop delay and its event-loop utilization all climb hard under throttling from SDK
retry backoff alone: 642–938 ms, 610 ms and 1.000 respectively, with CPU at 3–16%. None of those is
evidence about the service while throttle events are non-zero.
```

- [ ] **Step 2: Update that plan's Task 7 results instructions**

Replace its `awk` block with the one from Task 4 Step 4 above, and correct the field list it prints
beneath to `$4` = infra change, `$6` = k6 attainment, `$7` = service attainment, `$13` = throttles.
Delete its sentence describing `$8`/`$9` as the two attainment columns — that mapping was never
correct.

- [ ] **Step 3: Lift the block from that plan's status header**

Replace its `**BLOCKED — do not start.**` heading and the paragraphs explaining the attribution
failure with:

```markdown
## Status — **draft**, 2026-09-02. Ready to start.

The attribution model that blocked this plan is gone. Nothing computes a bound resource: a run
records how long the endpoints took and whether DynamoDB was rejecting requests, and a person reads
the two together. See
`docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-attribution-simplified-design.md`.

**Task 1 Step 0 is still the first thing to do, and it is easy to skip.** k6 traffic cannot be
isolated by `traffic_source` — k6 v1.4.0 sends no `k6/`-prefixed User-Agent, so both 2026-09-01
shakedown runs landed under `other`, and selecting `traffic_source="k6"` returns an empty population
that reads exactly like a healthy silence. Run-scoped attainment is the authoritative number, so
this must land **before** the script freeze in Task 2.
```

Keep the two paragraphs beneath it recording that DynamoDB served 2.46× provisioned capacity without
throttling, and that the 7-day SLO window was already in breach at idle. Both still apply.

- [ ] **Step 4: Confirm no instruction to attribute survives in that plan**

```bash
grep -n -i 'bound resource\|four-row\|throttled_requests' \
  docs/superpowers/plans/2026-09-02-ecs-dynamodb-rps-ceiling-scale-and-measure.md
```

Expected: matches only inside historical explanation, never inside a `- [ ]` step.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-09-02-ecs-dynamodb-rps-ceiling-scale-and-measure.md
git commit -m "docs(ecs-dynamodb-rps-ceiling): unblock the scale-and-measure plan"
```

---

## Task 6: APPROVAL GATE — apply the dashboard change

**Files:** none changed.

**This runs `terraform apply` and therefore STOPS for approval.** It creates, changes and destroys
**no AWS resource** and adds nothing billable — the only resource in the plan is the Grafana
dashboard. It is still an apply, and this repo's rule is that an apply is its own task with its own
gate.

- [ ] **Step 1: Plan and review**

```bash
set -a && . ../.env && set +a
terraform -chdir=terraform plan -var-file=dev.tfvars
```

Expected: **one resource changed, `grafana_dashboard`.** If a DynamoDB, ECS, ALB or Lambda resource
appears, stop — an unrelated change has been picked up, most likely the DynamoDB capacity pin, which
belongs to the scale-and-measure plan and costs $0.3212/hour.

- [ ] **Step 2: STOP — get explicit approval, then apply**

```bash
/env up ecs-dynamodb-rps-ceiling
```

- [ ] **Step 3: Verify the dashboard renders the new panels with data**

```bash
set -a && . ../.env && set +a
curl -s -H "Authorization: Bearer $GRAFANA_AUTH" \
  "$GRAFANA_URL/api/dashboards/uid/agbp7d" \
| python3 -c "
import json,sys
d=json.load(sys.stdin)['dashboard']
for p in d['panels']:
    if p.get('id') in (2,3):
        print(p['id'], p['title'], [t.get('metricName') for t in p.get('targets',[])])"
```

Expected: panel 2 lists `['ReadThrottleEvents', 'WriteThrottleEvents']`, panel 3 unchanged in its
targets. Panels read CloudWatch directly, so at idle both render zero rather than empty.

- [ ] **Step 4: Confirm the deleted signal is gone from the query set in the live repo**

```bash
grep -c throttled_requests grafana/queries.json
```

Expected: `0`.

---

## Task 7: Close out the documents

**Files:**
- Modify: `docs/superpowers/specs/2026-09-01-ecs-dynamodb-rps-ceiling-attribution-simplified-design.md`
- Modify: this plan's Status line
- Create: `.superpowers/sdd/2026-09-01-ecs-dynamodb-rps-ceiling-attribution-simplified/report.md`

- [ ] **Step 1: Write the report** — what changed, the `terraform plan` output showing one Grafana
  resource, the live query results from Task 1 Step 7, and the `awk` proof from Task 4 Step 5. Every
  claim quoted with the command that produced it.

- [ ] **Step 2: Set the spec's status to `complete`**, naming the date and this plan.

- [ ] **Step 3: Set this plan's Status to `complete`**.

- [ ] **Step 4: Confirm `results.md` still does not exist**

```bash
ls ecs-dynamodb-rps-ceiling/results.md
```

Expected: `No such file or directory`. This plan measures nothing; if that file exists, something
outside its scope ran.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs(ecs-dynamodb-rps-ceiling): close out the simplified attribution plan"
```

---

## Self-review — spec coverage

| spec decision | task |
|---|---|
| **M1** delete the four-row table, nothing computes a bound resource | 3 (README), 4 (skill), 5 (plan) — the spec itself already carries the pointer at the deleted table |
| **M2** two metrics read by a human: latency, throttle events | 2 (dashboard), 3 (README), 5 (the run step) |
| **M3** `ReadThrottleEvents`/`WriteThrottleEvents` replace `ThrottledRequests` in the query set, dashboard and runbook | 1 (query set), 2 (dashboard), 4 (runbook) |
| **M4** results file drops `bound resource`, `evidence`, `queueing ms` | 4 |
| **M5** completeness check rewritten, indices verified not counted | 4 steps 4–5, 5 step 2 |
| **M6** raw observations stay recorded | 4 step 3 — the fourteen-column header keeps `db ms`, `cpu ms`, `EL lag p99`, `throttles`, `RCU/WCU`, `$/hr` |
| §6 one Grafana-only `terraform apply`, gated | 6 |
| §6 collector and `src/` untouched | Global Constraints 2 and 3; Task 2 Step 4 and Task 6 Step 1 both fail the task if an AWS resource appears in the plan |
