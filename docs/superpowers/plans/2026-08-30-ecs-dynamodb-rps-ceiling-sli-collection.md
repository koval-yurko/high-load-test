# ecs-dynamodb-rps-ceiling SLI Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the SLO computable from real service metrics, continuously, so an error budget accrues between load tests and burn-rate alerts can fire against a live service rather than only during a run.

**Architecture:** The Node service records one OpenTelemetry exponential histogram of request duration and exports it over OTLP to a single cluster-wide Grafana Alloy collector, which forwards it to Grafana Cloud as a Prometheus native histogram and separately pulls CloudWatch metrics discovered by the `Project` tag. The service holds no thresholds and computes no ratio: Grafana applies the class thresholds at query time with `histogram_fraction`, so the objective changes without a deploy.

**Tech Stack:** Node.js 22 (`node:http`, `node:test`), `@opentelemetry/*` metrics SDK, Grafana Alloy on ECS Fargate, Terraform ~1.14 with HCP Terraform (remote execution), Grafana Cloud (Mimir native histograms, Synthetic Monitoring, SLO app), k6 1.4 as a run gate only.

**Spec:** `docs/superpowers/specs/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection-design.md`

**Amends:** `docs/superpowers/plans/2026-08-29-ecs-dynamodb-rps-ceiling.md`. That plan's Tasks 18–23 stay on hold and **are not renumbered**; this plan numbers its own tasks from 1 and uses its own SDD ledger directory. Task 18 of the old plan resumes after Task 18 of this one.

---

## Status — **complete**, 2026-08-31

> Project renamed to `ecs-dynamodb-rps` on 2026-09-03; paths and names below are pre-rename. See `docs/superpowers/specs/2026-09-02-ecs-dynamodb-rps-restructure-design.md`.

**All 18 tasks executed.** Task 14 was folded into Task 16 by decision (its change was smaller than
its own measurement noise); Synthetic Monitoring was abandoned for an EventBridge heartbeat after
its tenant proved to be disabled at the account level.

**The goal is met.** The SLO is computed from metrics the service emits, continuously, with class
thresholds applied at query time. Verified with no load test running:

```json
{"status":"success","data":{"resultType":"vector","result":[
  {"metric":{},"value":[1788182528.282,"0.9987429206816848"]}]}}
```

**SLI = 0.99874** against a 99% objective, from a population that exists because a Lambda heartbeat
generates traffic every minute — the thing that was impossible before this plan. A burn alert was
driven through `inactive -> pending -> firing` and reverted, so the alerting path is proven rather
than assumed.

| | |
|---|---|
| Service | emits `http_server_request_duration_seconds`, a native exponential histogram |
| Labels | `job`, `instance` (ECS task id), `http_route` (template), `class`, `traffic_source` |
| Collector | Alloy v1.10.0 on Fargate, zero errors; CloudWatch discovery by `Project` tag |
| Grafana | `grafana_slo` + 4 burn-rate rule groups, all `health=ok`, all generated from `slo.yaml` |
| Window | `7d` — forced, not chosen: >=7 by the SLO API, <=14 by free-tier retention |
| Idle load | EventBridge -> Lambda, 1/min, all four measured routes |
| Tests | 78 unit, 10 integration |
| Cost | ~$0.055/hour idle (collector +$0.0142/hr measured, heartbeat within free tier) |

### What this plan got wrong, corrected in place

Each is marked **CORRECTION** at the step it affects. Listed here because a reader who lands on the
original text will reintroduce a fixed defect.

| # | where | what was wrong |
|---|---|---|
| 1 | Task 5 | `buildViews()` uses `new View(...)`; the class does not exist in `sdk-metrics` v2 |
| 2 | Task 8 | the Alloy config does not parse; `delay` is not a real attribute (**spec §16 is wrong**) |
| 3 | Task 11 | the task-def replacement is not caused "solely" by `OTLP_ENDPOINT` |
| 4 | Task 11 | the log grep cannot match the line it looks for |
| 5 | Task 12 | `K6_PROMETHEUS_RW_*` is write-scoped and cannot run any of this task's queries |
| 6 | Task 13 | the calibration cannot observe instrumentation cost, so neither outcome means what it claims |
| 7 | Task 15 | the `moved` blocks were load-bearing, not the no-ops the plan assumed |
| 8 | Task 16 | the rules' `A -> C` shape cannot evaluate; a `reduce` step is required |

**Plus one omission and one hazard the plan never considered:**

- **No task rebuilt the container image.** Added as Task 11 Step 7. Without it the collector receives
  nothing from a service that looks healthy in every other respect.
- **Scanner traffic counted as SLO violations.** On an internet-facing ALB, 404s on `unmatched`
  carry no `class` and so landed in the denominator contributing nothing to the numerator — 68% of
  the population, three burn rules firing on noise. The population is now selected on `class`.

### Where the numbers are

Full evidence, including every raw query response, is in
`.superpowers/sdd/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection/progress.md` (findings F1-F20).

### Hand back

The **2026-08-29 plan's Tasks 18-23 are unblocked.** See its status header for the two operational
changes that affect them and for what Task 18 must now delete.

---

## Global Constraints

Copied verbatim from the spec and `CLAUDE.md`. Every task's requirements implicitly include this section.

- **Project name is fixed:** `ecs-dynamodb-rps-ceiling` — directory name, AWS `Project` tag value, commit scope.
- **Every AWS resource carries `Project = "ecs-dynamodb-rps-ceiling"`** via provider `default_tags`. Never per-resource.
- **`terraform apply` / `destroy` are approval gates.** Each gets its own task that STOPS. Never `-auto-approve` — the `PreToolUse` hook blocks it outright.
- **Do not raise DynamoDB capacity.** It is 25/25 (free tier). Raising it is Task 18 of the *old* plan and is not in scope here.
- **`task_cpu` stays 256.** The whole point of a gateway collector rather than a sidecar (spec S1) is that the app task's CPU budget is untouched.
- **No SLO logic in the service** (S3). It records a distribution. It holds no threshold, computes no ratio, and renders no verdict.
- **Cumulative temporality, set explicitly** (S6). Never left to a default.
- **`window: 3d`**, burn multipliers 14.4× over **6m** (page) and 6× over **36m** (ticket) (S13, S14).
- **Frozen, do not edit:** all three k6 scripts, `k6/lib/mix.js`, the 55/15/25/5 mix, item size ≤1 KB, `Query` page size 20. `k6/lib/slo.js` is regenerated but its *thresholds* must not change.
- **Node 22, `"type": "module"`.** ESM throughout.
- **Prices and plan limits are never typed from memory.** Grafana Cloud Free = 14-day metrics retention, 10,000 active series (spec §14).
- **Commit format:** Conventional Commits, scope `ecs-dynamodb-rps-ceiling` or `ecs-dynamodb-rps-ceiling/<layer>`, subject ≤72 chars.

---

## Deviations from the spec (approved as part of this plan)

**1. The duration histogram is recorded directly through the OpenTelemetry Metrics API, not by `@opentelemetry/instrumentation-http`.**

Spec §5 lists `instrumentation-http` as the source of `http.server.request.duration`, and spec §14 item 3 leaves open whether a route template set by `matchRoute` would reach that metric as `http.route`. This plan removes the question instead of verifying it. Three reasons:

- **It guarantees `http.route`.** `instrumentation-http` derives route templates from *framework* instrumentation, and this service deliberately has no framework (old plan, Deviation 2). Without the attribute the class mapping has nothing to key on and raw paths are unbounded cardinality.
- **It measures the clock the spec says it measures.** Spec §11 defines the service-side figure as callback start to response finish. Recording it ourselves makes that literally true; `instrumentation-http`'s own timing boundaries are its business, not ours.
- **It is cheaper** on a 250 µs/request budget — no per-request `http` module wrapping.

This is still OpenTelemetry (S5): the meter, the instrument, the view, the exporter and the semantic-convention names are all OTel. Only the call site is ours. `@opentelemetry/instrumentation-aws-sdk` and `@opentelemetry/instrumentation-runtime-node` are unaffected and stay.

**2. `grafana/` becomes a Terraform module.**

`CLAUDE.md` requires alert rules and SLO definitions to live under the project's `grafana/`, but Terraform cannot include a `.tf` file from outside the root module. `terraform/grafana.tf` therefore declares `module "grafana" { source = "../grafana" }`, and `moved` blocks relocate the already-declared `grafana_folder.project` and `grafana_dashboard.attribution` into it without a manual `terraform state mv`. ~~If those resources were never applied, the `moved` blocks are a no-op.~~ **They were applied by Task 11 and are in state at the root module, so the `moved` blocks are load-bearing, not defensive.**

---

## File Structure

```
ecs-dynamodb-rps-ceiling/
  package.json                  + @opentelemetry/* runtime deps, + yaml devDep, + slo scripts
  slo.yaml                      MODIFY  window: 30d -> 3d
  Dockerfile                    MODIFY  (no change needed if src/ is already copied wholesale — verify)
  src/
    otel.js                     NEW     meter provider, view, exporter, recordRequest(). One file, one job.
    handlers.js                 MODIFY  ROUTES gain a `template` field; matchRoute returns it
    server.js                   MODIFY  time callback-start -> res 'finish', call recordRequest
  scripts/
    generate-slo.js             NEW     the generator: slo.yaml -> four outputs
  test/
    otel.test.js                NEW     view/temporality/attributes, no network
    generate-slo.test.js        NEW     fidelity, validation, burn-window arithmetic
    handlers.test.js            MODIFY  assert route templates
    integration.test.js         MODIFY  assert a datapoint is produced with http.route
  k6/lib/slo.js                 REGENERATED (thresholds must not change)
  terraform/
    capacity.auto.tfvars        REGENERATED (must not change)
    collector.tf                NEW     Cloud Map, SG, IAM, Alloy task definition + service
    grafana.tf                  MODIFY  module "grafana" + moved blocks
    variables.tf                MODIFY  collector sizing + Grafana Cloud credential variables
    dev.tfvars                  MODIFY  re-derived pbkdf2_iterations
  grafana/
    alloy.alloy.tftpl           NEW     Alloy config template; class map interpolated by Terraform
    alerts.tf                   REWRITTEN against native-histogram queries
    slo.tf                      NEW     grafana_slo + synthetic monitoring checks
    variables.tf                NEW     module inputs
    dashboard.json              unchanged
.claude/skills/slo/SKILL.md     MODIFY  document the generator and --check
```

`otel.js` holds all OpenTelemetry wiring so `server.js` keeps its single responsibility and so the exporter can be swapped for a future Lambda project without touching request handling (spec S5).

---

## Further deviations, decided during execution (2026-08-31)

**3. DynamoDB capacity is pinned to 25/25 in `dev.tfvars`.** (User decision.) `capacity.auto.tfvars`
is auto-loaded and asks for 1025/200 (~$0.32/hour), so *every* plan run already proposed that raise
— contradicting Task 11 Step 1's own expectation. A CLI `-var-file` outranks an auto-loaded
`*.auto.tfvars` (verified on Terraform 1.14.0), so two lines in `dev.tfvars` hold the free tier
without touching the generated file. `read_capacity`/`write_capacity` are also set as HCP workspace
variables as a belt for remote runs. **The old plan's Task 18 now begins by deleting those two
lines**, rather than being a no-op.

**4. The workspace needs `working-directory = "terraform"`.** A CLI-driven remote run uploads only
the configuration directory, so `file("${path.module}/../grafana/...")` resolves to nothing — which
breaks `collector.tf`, breaks the pre-existing `grafana.tf`, and would have broken **Task 15's
`module "grafana" { source = "../grafana" }`**. Setting the working directory moves the upload root
to the project directory. `.terraformignore` keeps `node_modules` out. Both settings are documented
in `terraform/versions.tf`, since they live on the workspace and are invisible from the repo.

**5. `stopTimeout = 120` on both containers.** ECS defaults to 30 s, but the app flushes
OpenTelemetry inside `server.close()` and `keepAliveTimeout` is 65 s — the flush was unreachable
under drain. The collector's batch processor and remote-write WAL have the same exposure.

**6. `service.namespace` is not set.** Grafana Cloud's OTLP translation joins namespace and name
into `job` as `<namespace>/<name>`. Setting both produced
`job="ecs-dynamodb-rps-ceiling/ecs-dynamodb-rps-ceiling"`, against which every query in this plan
matched nothing. Fixed at the source (`c924b4d`) so Task 15's queries are correct as written.

**7. `service.instance.id` is read from `ECS_CONTAINER_METADATA_URI_V4`.** The AWS resource
detector supplies nothing on Fargate either, so the fallback `local-${process.pid}` applied — and
the app is PID 1 in every container. All tasks reported `instance="local-1"` and shared one series.

---

## Phase 1 — The generator (local only, no AWS spend)

### Task 1: `/slo` generator, proven faithful against the committed outputs

**Files:**
- Create: `ecs-dynamodb-rps-ceiling/scripts/generate-slo.js`
- Create: `ecs-dynamodb-rps-ceiling/test/generate-slo.test.js`
- Modify: `ecs-dynamodb-rps-ceiling/package.json`

**Interfaces:**
- Consumes: `ecs-dynamodb-rps-ceiling/slo.yaml`.
- Produces: `loadSlo(path) -> {service, window, slos, capacity}`; `renderK6(model) -> string`; `renderCapacityTfvars(model) -> string`; `renderAlerts(model) -> string`; `burnWindows(windowSeconds) -> {fast:{multiplier, window, forDuration}, slow:{...}}`. Task 2 and Task 15 both call these.

**Why this task exists and why it comes first.** `/slo` is documentation only; the four committed outputs were hand-written to its spec, so "one file, four outputs, cannot drift" is currently enforced by discipline. This is the **only** moment the generator's fidelity can be proven: generate against the committed `window: 30d` and require byte-identical output. Once the window moves in Task 2, there is nothing left to compare against.

- [x] **Step 1: Add the YAML parser and the scripts**

Node has no YAML parser. Add `yaml` as a devDependency — the generator is build-time tooling and must not enter the runtime image.

```bash
cd ecs-dynamodb-rps-ceiling
npm install --save-dev yaml@^2.6.0
```

Then in `package.json`, add to `"scripts"`:

```json
"slo:generate": "node scripts/generate-slo.js",
"slo:check": "node scripts/generate-slo.js --check"
```

- [x] **Step 2: Write the failing test**

Create `test/generate-slo.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { burnWindows, loadSlo, renderCapacityTfvars, renderK6 } from '../scripts/generate-slo.js';

const HERE = new URL('..', import.meta.url).pathname;

test('burn windows scale with the SLO window, multipliers do not', () => {
  // The Google reference: a 30-day window pages at 14.4x over 1h and tickets at
  // 6x over 6h. Those encode "2% of budget" and "5% of budget" respectively.
  const thirtyDays = burnWindows(30 * 86400);
  assert.equal(thirtyDays.fast.multiplier, 14.4);
  assert.equal(thirtyDays.fast.window, '1h');
  assert.equal(thirtyDays.slow.multiplier, 6);
  assert.equal(thirtyDays.slow.window, '6h');

  // A 3-day window is 1/10th, so the alert windows are 1/10th and the budget
  // fractions are preserved. Multipliers are invariant.
  const threeDays = burnWindows(3 * 86400);
  assert.equal(threeDays.fast.multiplier, 14.4);
  assert.equal(threeDays.fast.window, '6m');
  assert.equal(threeDays.slow.multiplier, 6);
  assert.equal(threeDays.slow.window, '36m');
});

test('a mix that does not sum to 1.0 is refused', () => {
  assert.throws(
    () => loadSlo(null, { service: 's', window: '30d', slos: [], capacity: {
      target_rps: 1000, mix: { read: 0.5, write: 0.1 }, cost_per_request: {},
    } }),
    /mix must sum to 1\.0/,
  );
});

test('an endpoint in two classes is refused', () => {
  assert.throws(
    () => loadSlo(null, { service: 's', window: '30d', capacity: null, slos: [{
      name: 'l', sli: 'class_threshold_ratio', objective: 99, tail_objective: 99.9,
      tail_multiplier: 3,
      classes: { fast: { threshold_ms: 50, endpoints: ['feed'] },
                 standard: { threshold_ms: 200, endpoints: ['feed'] } },
    }] }),
    /endpoint "feed" appears in more than one class/,
  );
});

test('regenerating the committed slo.yaml reproduces the committed outputs byte for byte', () => {
  const model = loadSlo(`${HERE}slo.yaml`);
  assert.equal(renderK6(model), readFileSync(`${HERE}k6/lib/slo.js`, 'utf8'));
  assert.equal(renderCapacityTfvars(model), readFileSync(`${HERE}terraform/capacity.auto.tfvars`, 'utf8'));
});
```

- [x] **Step 3: Run it and watch it fail**

Run: `cd ecs-dynamodb-rps-ceiling && npm test -- test/generate-slo.test.js`
Expected: FAIL — `Cannot find module '../scripts/generate-slo.js'`.

- [x] **Step 4: Write `scripts/generate-slo.js`**

```js
// scripts/generate-slo.js
// The single source: slo.yaml -> k6 thresholds, capacity tfvars, Grafana alert
// rules, Alloy class map. Nothing downstream of this file is edited by hand.
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';

const UNIT_SECONDS = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 };

/** Prometheus duration -> seconds. The provider validates ^\d+(ms|s|m|h|d|w|y)$. */
export function durationSeconds(text) {
  const m = /^(\d+)(ms|s|m|h|d|w|y)$/.exec(text);
  if (!m) throw new Error(`window must match ^\\d+(ms|s|m|h|d|w|y)$, got ${JSON.stringify(text)}`);
  return Number(m[1]) * UNIT_SECONDS[m[2]];
}

/** Seconds -> the largest whole unit that divides it, for legible alert windows. */
export function formatDuration(seconds) {
  for (const [unit, size] of [['h', 3600], ['m', 60], ['s', 1]]) {
    if (seconds % size === 0) return `${seconds / size}${unit}`;
  }
  return `${seconds}s`;
}

/**
 * Burn-rate alerting, derived rather than copied. The familiar 14.4x/1h and
 * 6x/6h are not conventions: they are what "2% of budget" and "5% of budget"
 * work out to on a 30-day window. Hold the multipliers and the budget
 * fractions fixed, and the ALERT WINDOWS must scale with the SLO window --
 * otherwise the same rules silently mean 20% and 50% on a 3-day window.
 */
export function burnWindows(windowSeconds) {
  const scale = windowSeconds / (30 * 86400);
  return {
    fast: { multiplier: 14.4, window: formatDuration(3600 * scale), forDuration: formatDuration(300 * scale), budgetFraction: 0.02, severity: 'page' },
    slow: { multiplier: 6, window: formatDuration(21600 * scale), forDuration: formatDuration(1800 * scale), budgetFraction: 0.05, severity: 'ticket' },
  };
}

export function loadSlo(path, preParsed) {
  const doc = preParsed ?? parse(readFileSync(path, 'utf8'));

  if (doc.capacity) {
    const shares = Object.values(doc.capacity.mix);
    const total = shares.reduce((a, b) => a + b, 0);
    // A mix that does not sum to one produces capacity numbers that are quietly
    // wrong rather than obviously wrong. Refuse, do not round.
    if (Math.abs(total - 1) > 1e-9) throw new Error(`capacity.mix must sum to 1.0, got ${total}`);
  }

  for (const slo of doc.slos ?? []) {
    if (slo.sli !== 'class_threshold_ratio') continue;
    const seen = new Set();
    for (const [name, cls] of Object.entries(slo.classes)) {
      for (const endpoint of cls.endpoints) {
        // An endpoint in no class is silently unmeasured; in two classes it is
        // measured against contradictory thresholds. Both are worse than a
        // wrong threshold, because neither is visible.
        if (seen.has(endpoint)) throw new Error(`endpoint "${endpoint}" appears in more than one class (${name})`);
        seen.add(endpoint);
      }
    }
  }

  return { ...doc, windowSeconds: durationSeconds(doc.window), burn: burnWindows(durationSeconds(doc.window)) };
}

export const classRatio = (doc) => doc.slos.find((s) => s.sli === 'class_threshold_ratio');

export function renderK6(doc) {
  const slo = classRatio(doc);
  const thresholds = Object.entries(slo.classes)
    .map(([name, c]) => `  'http_req_duration{class:${name}}': ['p(99)<${c.threshold_ms}]'`);
  const map = Object.entries(slo.classes).map(([n, c]) => `${n}: ${c.threshold_ms}`).join(', ');
  const availability = doc.slos.find((s) => s.sli === 'success_rate');
  return `// GENERATED from slo.yaml by /slo. Do not edit by hand.
export const CLASS_THRESHOLD_MS = { ${map} };
export const TAIL_MULTIPLIER = ${slo.tail_multiplier};

export const thresholds = {
  // PRIMARY gate: >=${slo.objective.toFixed(1)}% of requests meet their own class threshold.
  slo_met: ['rate>${slo.objective / 100}'],
  // TAIL: >=${slo.tail_objective.toFixed(1)}% meet ${slo.tail_multiplier}x their class threshold.
  slo_met_tail: ['rate>${slo.tail_objective / 100}'],
  // Availability ${availability.objective}%. k6's rate metric counts FAILURES, so the objective inverts:
  // ${availability.objective}% success  ->  failure rate < ${(100 - availability.objective) / 100}.
  http_req_failed: ['rate<${(100 - availability.objective) / 100}'],
  // Secondary, per class. Diagnostic only — these are NOT the gate.
${Object.entries(slo.classes).map(([n, c]) => `  'http_req_duration{class:${n}}': ['p(99)<${c.threshold_ms}'],`).join('\n')}
};
`;
}

export function renderCapacityTfvars(doc) {
  const { mix, cost_per_request: cost, target_rps: rps } = doc.capacity;
  const per = (unit) => Object.entries(mix).reduce((sum, [k, share]) => sum + share * (cost[k][unit] ?? 0), 0);
  const rcu = per('rcu'), wcu = per('wcu');
  const terms = (unit) => Object.entries(mix)
    .filter(([k]) => (cost[k][unit] ?? 0) > 0)
    .map(([k, share]) => `${share}*${cost[k][unit].toFixed(1)}`).join(' + ');
  return `# GENERATED from slo.yaml by /slo. Do not edit by hand.
# ${terms('rcu')} = ${rcu.toFixed(3)} RCU per rps
# ${terms('wcu')}             = ${wcu.toFixed(3)} WCU per rps
read_capacity  = ${Math.round(rcu * rps)}
write_capacity = ${Math.round(wcu * rps)}
`;
}
```

> **Note for the implementer:** `renderK6` and `renderCapacityTfvars` above are written to reproduce the *shape* of the committed files. They will not match byte-for-byte on the first run — comment wording and spacing differ. **That is the point of Step 5.** Adjust the template strings until the test passes; do **not** adjust the committed files. If you find yourself wanting to change `k6/lib/slo.js` or `capacity.auto.tfvars` to satisfy the test, stop: those files are the fixed point this task exists to reproduce.

- [x] **Step 5: Iterate until byte-identical**

Run: `npm test -- test/generate-slo.test.js`
Expected: PASS, all four tests. The two `assert.equal` comparisons print a full diff on failure; work it down to nothing.

- [x] **Step 6: Add `--check` and the writer**

Append to `scripts/generate-slo.js`:

```js
const OUTPUTS = [
  ['k6/lib/slo.js', renderK6],
  ['terraform/capacity.auto.tfvars', renderCapacityTfvars],
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL('..', import.meta.url).pathname;
  const doc = loadSlo(`${root}slo.yaml`);
  const check = process.argv.includes('--check');
  let drifted = 0;
  for (const [rel, render] of OUTPUTS) {
    const wanted = render(doc);
    const current = readFileSync(`${root}${rel}`, 'utf8');
    if (wanted === current) continue;
    drifted += 1;
    if (check) console.error(`DRIFT: ${rel} does not match slo.yaml`);
    else { writeFileSync(`${root}${rel}`, wanted); console.log(`wrote ${rel}`); }
  }
  if (check && drifted) process.exit(1);
  if (check) console.log('slo.yaml and its generated outputs agree');
}
```

`grafana/alerts.tf` is deliberately **not** in `OUTPUTS` yet — it is added in Task 15, once its queries are rewritten. Adding it here would make `--check` fail against a file this task cannot yet reproduce.

- [x] **Step 7: Prove `--check` is green on a clean tree**

Run: `npm run slo:check`
Expected: exit 0, `slo.yaml and its generated outputs agree`.

Then prove it actually detects drift:

```bash
printf '\n// drift\n' >> k6/lib/slo.js
npm run slo:check; echo "exit=$?"
git checkout k6/lib/slo.js
```
Expected: `DRIFT: k6/lib/slo.js does not match slo.yaml`, `exit=1`. **A check that has never gone red is not a check.**

- [x] **Step 8: Run the whole suite**

Run: `npm test`
Expected: PASS — 52 pre-existing unit tests plus the 4 new ones. No pre-existing test may change.

- [x] **Step 9: Commit**

```bash
git add package.json package-lock.json scripts/generate-slo.js test/generate-slo.test.js
git commit -m "feat(ecs-dynamodb-rps-ceiling): generate slo outputs from slo.yaml"
```

---

### Task 2: Move the window to 3 days

**Files:**
- Modify: `ecs-dynamodb-rps-ceiling/slo.yaml:2`
- Modify: `ecs-dynamodb-rps-ceiling/test/generate-slo.test.js`

**Interfaces:**
- Consumes: `loadSlo`, `burnWindows` from Task 1.
- Produces: `slo.yaml` at `window: 3d`. Task 15 renders alert rules from it.

**Why.** Grafana Cloud Free retains metrics for **14 days** (spec §14). A 30-day objective could never be evaluated over the window it claims — and it would look right while being wrong. Task 1 proved the generator faithful at 30d; this task changes exactly one line, so any diff is attributable to the window and to nothing else.

- [x] **Step 1: Confirm the generated outputs do NOT depend on the window**

Before changing anything, predict the diff. `k6/lib/slo.js` carries thresholds and objectives; `capacity.auto.tfvars` carries the mix. Neither references the window. So the expected diff after regenerating is **empty**, and the window's only consumer today is the alert rules of Task 15.

Run: `npm run slo:check`
Expected: exit 0.

- [x] **Step 2: Change the window**

In `slo.yaml`, line 2:

```yaml
window: 3d
```

- [x] **Step 3: Regenerate and confirm nothing moved**

```bash
npm run slo:generate
git diff --stat k6/lib/slo.js terraform/capacity.auto.tfvars
```
Expected: **no diff.** If either file changed, the generator has an undeclared dependency on the window — stop and investigate before continuing. The k6 thresholds are frozen by `CLAUDE.md`; a change here would silently alter the run gate.

- [x] **Step 4: Add the regression test that pins the new burn windows**

Append to `test/generate-slo.test.js`:

```js
test('the committed slo.yaml is a 3-day window with 6m/36m burn alerting', () => {
  const model = loadSlo(`${HERE}slo.yaml`);
  assert.equal(model.window, '3d');
  assert.equal(model.windowSeconds, 259200);
  assert.equal(model.burn.fast.window, '6m');
  assert.equal(model.burn.fast.forDuration, '30s');
  assert.equal(model.burn.slow.window, '36m');
  assert.equal(model.burn.slow.forDuration, '3m');
});
```

If `forDuration` renders as something other than `30s`/`3m`, fix `formatDuration` rather than the assertion — the value is `300 × 0.1 = 30s` and `1800 × 0.1 = 180s` by construction.

- [x] **Step 5: Run the suite**

Run: `npm test`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add slo.yaml test/generate-slo.test.js
git commit -m "fix(ecs-dynamodb-rps-ceiling): set the slo window to 3d"
```

The body must record *why*: Grafana Cloud Free retains 14 days, so 30d was never evaluable.

---

### Task 3: Teach `/slo` that the generator exists

**Files:**
- Modify: `.claude/skills/slo/SKILL.md`

**Interfaces:**
- Consumes: the scripts added in Task 1.
- Produces: nothing code depends on. This closes the honesty gap the old plan's ledger recorded.

- [x] **Step 1: Replace the usage line**

The skill currently says `/slo <project>` generates. It never could. Replace the usage line near the top with:

```markdown
Usage: `/slo <project>` (generate/refresh) · `/slo <project> --check` (report drift only)

Both run the project's own generator — there is no skill-level script:

```bash
cd <project> && npm run slo:generate     # rewrite the generated outputs
cd <project> && npm run slo:check        # exit 1 if any output has drifted
```

`--check` is what makes "one file, four outputs" a property rather than a promise. Run it before
any commit that touches `slo.yaml` or a generated file.
```

- [x] **Step 2: Add the window/burn-rate section**

Append a new section after `### The `capacity:` block`:

````markdown
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
````

- [x] **Step 3: Verify the skill still parses**

Run: `head -5 .claude/skills/slo/SKILL.md`
Expected: YAML frontmatter (`name: slo`, `description: ...`) intact and first in the file.

- [x] **Step 4: Commit**

```bash
git add .claude/skills/slo/SKILL.md
git commit -m "docs(repo): document the /slo generator and window scaling"
```

---

## Phase 2 — Service instrumentation (local only, no AWS spend)

### Task 4: Route templates

**Files:**
- Modify: `ecs-dynamodb-rps-ceiling/src/handlers.js:6-23`
- Modify: `ecs-dynamodb-rps-ceiling/test/handlers.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `matchRoute(method, path) -> { name, params, template } | null`. `template` is the route **pattern** (`/items/:pk/:sk`), never the concrete path. Task 6 uses it as the `http.route` metric attribute.

**Why this is its own task.** The template is the difference between four label values and unbounded cardinality: `/items/feed-07/item-13` is a distinct label value per item, and 1000 seeded items would produce 1000 series. It is also what the collector's class map keys on (spec S8). Small change, load-bearing enough to review on its own.

- [x] **Step 1: Write the failing test**

Append to `test/handlers.test.js`:

```js
test('matchRoute returns the route template, not the concrete path', () => {
  assert.equal(matchRoute('GET', '/items/feed-07/item-13').template, '/items/:pk/:sk');
  assert.equal(matchRoute('GET', '/feeds/feed-07').template, '/feeds/:pk');
  assert.equal(matchRoute('POST', '/items').template, '/items');
  assert.equal(matchRoute('POST', '/reports').template, '/reports');
  assert.equal(matchRoute('GET', '/healthz').template, '/healthz');
  assert.equal(matchRoute('GET', '/stats').template, '/stats');
});

test('every route has a template and no two share one', () => {
  const templates = ['/healthz', '/stats', '/feeds/:pk', '/items/:pk/:sk', '/items', '/reports'];
  // An endpoint whose template collides with another is silently merged into
  // the wrong latency class. Cheap to assert, invisible if it happens.
  assert.equal(new Set(templates).size, templates.length);
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `cd ecs-dynamodb-rps-ceiling && npm test -- test/handlers.test.js`
Expected: FAIL — `expected undefined to equal '/items/:pk/:sk'`.

- [x] **Step 3: Add the templates**

In `src/handlers.js`, give each route a `template` and return it:

```js
const ROUTES = [
  { name: 'health',  method: 'GET',  re: /^\/healthz$/,                 keys: [],             template: '/healthz' },
  { name: 'stats',   method: 'GET',  re: /^\/stats$/,                   keys: [],             template: '/stats' },
  { name: 'feed',    method: 'GET',  re: /^\/feeds\/([^/]+)$/,          keys: ['pk'],         template: '/feeds/:pk' },
  { name: 'getItem', method: 'GET',  re: /^\/items\/([^/]+)\/([^/]+)$/, keys: ['pk', 'sk'],   template: '/items/:pk/:sk' },
  { name: 'putItem', method: 'POST', re: /^\/items$/,                   keys: [],             template: '/items' },
  { name: 'report',  method: 'POST', re: /^\/reports$/,                 keys: [],             template: '/reports' },
];

export function matchRoute(method, path) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = r.re.exec(path);
    if (!m) continue;
    return { name: r.name, params: Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]])), template: r.template };
  }
  return null;
}
```

- [x] **Step 4: Run tests**

Run: `npm test`
Expected: PASS, all 58.

- [x] **Step 5: Commit**

```bash
git add src/handlers.js test/handlers.test.js
git commit -m "feat(ecs-dynamodb-rps-ceiling): expose route templates from matchRoute"
```

---

### Task 5: OpenTelemetry metrics bootstrap

**Files:**
- Create: `ecs-dynamodb-rps-ceiling/src/otel.js`
- Create: `ecs-dynamodb-rps-ceiling/test/otel.test.js`
- Modify: `ecs-dynamodb-rps-ceiling/package.json`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `buildViews() -> View[]` — the exponential-histogram view.
  - `buildMeterProvider({ resource, readers }) -> MeterProvider` — pure, no network, no globals.
  - `bindHistogram(meterProvider) -> void` — creates the instrument and stores it module-locally.
  - `recordRequest({ route, method, status, durationSeconds }) -> void` — a no-op until `bindHistogram` runs, so unit tests of `server.js` need no OTel at all.
  - `startOtel(config) -> Promise<{ meterProvider, shutdown }>` — production wiring: resource detection, OTLP exporter, periodic reader.
  Task 6 imports `recordRequest` and `startOtel`.

**Why all OTel wiring lives in one file.** `server.js` keeps one responsibility, and the exporter becomes swappable for `lambda-concurrency-limit` without touching request handling — spec S5's portability argument. `recordRequest` degrading to a no-op is deliberate: it keeps every existing unit test working with zero OTel setup.

- [x] **Step 1: Install, pinning exact resolved versions**

```bash
cd ecs-dynamodb-rps-ceiling
npm install --save-exact \
  @opentelemetry/api@1.9.1 \
  @opentelemetry/sdk-metrics@2.10.0 \
  @opentelemetry/exporter-metrics-otlp-http@0.221.0 \
  @opentelemetry/resources@2.10.0 \
  @opentelemetry/semantic-conventions@1.43.0 \
  @opentelemetry/resource-detector-aws@2.21.0 \
  @opentelemetry/instrumentation@0.221.0 \
  @opentelemetry/instrumentation-aws-sdk@0.76.0 \
  @opentelemetry/instrumentation-runtime-node@0.34.0
```

These are **runtime** dependencies, not dev — the container needs them. `--save-exact` because an OTel minor bump can move the metrics API, and this service's per-request CPU is the object of measurement: a silent dependency change would show up as a moved ceiling.

> **API-churn warning.** `@opentelemetry/sdk-metrics` v2 changed the `View` aggregation shape from a class instance to an `AggregationOption` object. The code below is written for v2. **The test in Step 2 is what proves it** — if the view does not apply, the collected datapoint will be an explicit-bucket histogram instead of an exponential one and the assertion fails loudly. Do not paper over that by deleting the assertion; read the installed `node_modules/@opentelemetry/sdk-metrics/build/src/view/*.d.ts` and fix the call.

- [x] **Step 2: Write the failing test**

Create `test/otel.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AggregationTemporality, DataPointType, MetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { REQUEST_DURATION, bindHistogram, buildMeterProvider, buildViews, recordRequest } from '../src/otel.js';

/** Minimal reader: collect on demand, no timer, no exporter, no network. */
class TestReader extends MetricReader {
  selectAggregationTemporality() { return AggregationTemporality.CUMULATIVE; }
  async onForceFlush() {}
  async onShutdown() {}
}

async function collectOne() {
  const reader = new TestReader();
  const provider = buildMeterProvider({
    resource: resourceFromAttributes({ 'service.name': 'test', 'service.instance.id': 'task-1' }),
    readers: [reader],
  });
  bindHistogram(provider);
  return { reader, provider };
}

test('the duration histogram is an EXPONENTIAL histogram, not explicit buckets', async () => {
  const { reader, provider } = await collectOne();
  recordRequest({ route: '/items/:pk/:sk', method: 'GET', status: 200, durationSeconds: 0.004 });
  const { resourceMetrics } = await reader.collect();
  const metric = resourceMetrics.scopeMetrics[0].metrics.find((m) => m.descriptor.name === REQUEST_DURATION);

  assert.ok(metric, `${REQUEST_DURATION} was not recorded`);
  // If the View did not apply, this is DataPointType.HISTOGRAM and the whole
  // native-histogram design silently degrades to explicit buckets.
  assert.equal(metric.dataPointType, DataPointType.EXPONENTIAL_HISTOGRAM);
  assert.equal(metric.descriptor.unit, 's');
  await provider.shutdown();
});

test('temporality is CUMULATIVE, so a lost export costs resolution and not requests', async () => {
  const { reader, provider } = await collectOne();
  recordRequest({ route: '/items', method: 'POST', status: 201, durationSeconds: 0.01 });
  await reader.collect();
  recordRequest({ route: '/items', method: 'POST', status: 201, durationSeconds: 0.01 });
  const { resourceMetrics } = await reader.collect();
  const point = resourceMetrics.scopeMetrics[0].metrics
    .find((m) => m.descriptor.name === REQUEST_DURATION).dataPoints[0];

  // Cumulative: the second collection carries BOTH observations. Under delta it
  // would carry one, and a dropped export would lose a request forever.
  assert.equal(point.value.count, 2);
  await provider.shutdown();
});

test('attributes carry the route TEMPLATE and nothing unbounded', async () => {
  const { reader, provider } = await collectOne();
  recordRequest({ route: '/items/:pk/:sk', method: 'GET', status: 200, durationSeconds: 0.004 });
  const { resourceMetrics } = await reader.collect();
  const point = resourceMetrics.scopeMetrics[0].metrics
    .find((m) => m.descriptor.name === REQUEST_DURATION).dataPoints[0];

  assert.deepEqual(point.attributes, {
    'http.route': '/items/:pk/:sk',
    'http.request.method': 'GET',
    'http.response.status_code': 200,
  });
  await provider.shutdown();
});

test('recordRequest is a no-op before bindHistogram, so unit tests need no OTel', () => {
  // Imported fresh in a child context this would be unbound; here we assert the
  // contract does not throw, which is what every existing server test relies on.
  assert.doesNotThrow(() => recordRequest({ route: '/x', method: 'GET', status: 200, durationSeconds: 0 }));
});

test('maxSize matches Grafana Cloud max_native_histogram_buckets', () => {
  const views = buildViews();
  assert.equal(views.length, 1);
  // 160 is not a taste call: a histogram above the receiver's cap is rejected
  // or downscaled at ingest (spec section 14). Reach for the option rather than
  // stringifying the View -- serialisation is an implementation detail and a
  // test that passes because '160' appeared somewhere is not a test.
  const found = JSON.stringify(views[0]).match(/"maxSize":\s*(\d+)/);
  assert.ok(found, 'could not find maxSize on the view; check the v2 aggregation shape');
  assert.equal(found[1], '160');
});
```

- [x] **Step 3: Run it and watch it fail**

Run: `npm test -- test/otel.test.js`
Expected: FAIL — `Cannot find module '../src/otel.js'`.

- [x] **Step 4: Write `src/otel.js`**

```js
// src/otel.js
// All OpenTelemetry wiring lives here so server.js keeps one responsibility and
// so the exporter can be swapped per platform (ECS timer vs Lambda flush-on-end)
// without touching request handling. The SLI contract is the histogram; the
// transport is an implementation detail.
import {
  AggregationTemporality,
  AggregationType,
  InstrumentType,
  MeterProvider,
  PeriodicExportingMetricReader,
  View,
} from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { detectResources, resourceFromAttributes } from '@opentelemetry/resources';
import { awsEcsDetector } from '@opentelemetry/resource-detector-aws';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';

/** OpenTelemetry semantic convention name and unit. Do not localise either. */
export const REQUEST_DURATION = 'http.server.request.duration';
const METER_NAME = 'ecs-dynamodb-rps-ceiling';

/**
 * Exponential buckets, not explicit ones. This is what lets Grafana apply the
 * class thresholds at QUERY time via histogram_fraction -- change a threshold
 * and nothing is rebuilt or redeployed. maxSize is 160 to match Grafana Cloud's
 * max_native_histogram_buckets exactly; above the cap, ingest downscales.
 */
export function buildViews() {
  return [new View({
    instrumentType: InstrumentType.HISTOGRAM,
    aggregation: { type: AggregationType.EXPONENTIAL_HISTOGRAM, options: { maxSize: 160, recordMinMax: true } },
  })];
}

export function buildMeterProvider({ resource, readers }) {
  return new MeterProvider({ resource, readers, views: buildViews() });
}

let histogram = null;

export function bindHistogram(meterProvider) {
  histogram = meterProvider.getMeter(METER_NAME).createHistogram(REQUEST_DURATION, {
    unit: 's',
    description: 'Duration of inbound HTTP requests, callback start to response finish.',
  });
}

/**
 * The ONLY thing the service records. No threshold comparison, no verdict, no
 * ratio -- the objective is applied in Grafana (spec S3). A no-op until
 * bindHistogram runs, so unit tests need no OpenTelemetry setup at all.
 */
export function recordRequest({ route, method, status, durationSeconds }) {
  if (!histogram) return;
  histogram.record(durationSeconds, {
    'http.route': route,
    'http.request.method': method,
    'http.response.status_code': status,
  });
}

export async function startOtel(config) {
  // service.instance.id is what keeps four tasks from colliding on one series:
  // Prometheus's OTLP translation maps it to `instance`. Detected once at boot
  // from the ECS task metadata endpoint -- never per request.
  const detected = detectResources({ detectors: [awsEcsDetector] });
  if (typeof detected.waitForAsyncAttributes === 'function') await detected.waitForAsyncAttributes();

  const resource = detected.merge(resourceFromAttributes({
    'service.name': config.serviceName,
    'service.namespace': config.serviceName,
    // Fallback only. If the ECS detector supplied one, its value wins on merge.
    'service.instance.id': detected.attributes['service.instance.id'] ?? config.instanceIdFallback,
  }));

  const reader = new PeriodicExportingMetricReader({
    exportIntervalMillis: config.exportIntervalMs,
    exporter: new OTLPMetricExporter({
      url: `${config.otlpEndpoint}/v1/metrics`,
      // Explicit, never defaulted (spec S6): if the collector is down or the
      // event loop is blocked past the knee, the next successful export carries
      // full cumulative state. Delta would lose those requests permanently.
      temporalityPreference: AggregationTemporality.CUMULATIVE,
    }),
  });

  const meterProvider = buildMeterProvider({ resource, readers: [reader] });
  bindHistogram(meterProvider);

  // Two instrumentations, both metrics-only -- no tracer provider is registered,
  // so span creation is a no-op tracer.
  //
  // AwsInstrumentation gives DynamoDB call counts, errors and SDK RETRIES, which
  // is how throttling presents before it becomes errors. It does NOT fix
  // attribution: like the Server-Timing `db` phase it wraps an await, so it
  // absorbs event-loop queueing the same way and inflates under load. CloudWatch
  // SuccessfulRequestLatency stays the DB-bound discriminator (spec section 11).
  //
  // RuntimeNodeInstrumentation emits nodejs.eventloop.delay, superseding the
  // /stats poll -- which stays anyway, because the k6 scripts are frozen.
  //
  // NOT registered: @opentelemetry/auto-instrumentations-node. It pulls in
  // instrumentation for libraries this service does not use and adds context
  // propagation the metrics path does not need, against a 250us/request budget.
  registerInstrumentations({
    meterProvider,
    instrumentations: [new AwsInstrumentation(), new RuntimeNodeInstrumentation()],
  });

  return { meterProvider, shutdown: () => meterProvider.shutdown() };
}
```

- [x] **Step 5: Run the test until green**

Run: `npm test -- test/otel.test.js`
Expected: PASS, 5 tests.

If the exponential assertion fails, the v2 `View` shape differs from the code above — read the installed type declarations and fix `buildViews`, not the test.

> **CORRECTION (fixed in `cdd6e14`). The `buildViews()` above is wrong** and the warning above it
> is what caught it. In `@opentelemetry/sdk-metrics@2.10.0` the `View` **class is not exported at
> all** (`Named export 'View' not found`); `MeterProviderOptions.views` is typed `ViewOptions[]`,
> i.e. plain objects. The code was half-migrated: a correct v2 `AggregationOption` wrapped in a v1
> `new View({...})` call. Drop the `View` import and return the bare options object:
>
> ```js
> export function buildViews() {
>   return [{
>     instrumentType: InstrumentType.HISTOGRAM,
>     aggregation: { type: AggregationType.EXPONENTIAL_HISTOGRAM, options: { maxSize: 160, recordMinMax: true } },
>   }];
> }
> ```
>
> This is also the only shape the `maxSize` assertion can pass against: constructing a `View`
> converts `aggregation` into an internal `Aggregation` instance that no longer carries a readable
> `maxSize`. The exponential assertion was confirmed non-vacuous — a provider with no views
> collects `dataPointType = 0` (`HISTOGRAM`), so the view is genuinely what flips it.

- [x] **Step 6: Record what the ECS detector actually supplies**

Spec §14 item 2 asks whether `resource-detector-aws` populates `service.instance.id` uniquely per task. Resolve it now, on the record, rather than at deploy time:

```bash
node -e '
import("@opentelemetry/resource-detector-aws").then(async (m) => {
  const r = m.awsEcsDetector.detect();
  if (r.waitForAsyncAttributes) await r.waitForAsyncAttributes();
  console.log(JSON.stringify(r.attributes, null, 2));
});'
```
Expected **off** ECS: an empty or near-empty object — there is no metadata endpoint locally. That is the answer for the local case and is why `startOtel` carries `instanceIdFallback`. The on-ECS answer is Task 12's job; record whichever you observe in the task report.

- [x] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS, 63 tests. No pre-existing test changed — `recordRequest`'s no-op contract is what guarantees that.

- [x] **Step 8: Commit**

```bash
git add package.json package-lock.json src/otel.js test/otel.test.js
git commit -m "feat(ecs-dynamodb-rps-ceiling): add opentelemetry metrics bootstrap"
```

---

### Task 6: Record every request

**Files:**
- Modify: `ecs-dynamodb-rps-ceiling/src/config.js`
- Modify: `ecs-dynamodb-rps-ceiling/src/server.js:23-70`
- Modify: `ecs-dynamodb-rps-ceiling/test/config.test.js`
- Modify: `ecs-dynamodb-rps-ceiling/test/integration.test.js`

**Interfaces:**
- Consumes: `matchRoute(...).template` (Task 4); `recordRequest`, `startOtel` (Task 5).
- Produces: a running service that emits `http.server.request.duration`. Nothing later imports from it; Task 12 verifies it over the wire.

**The clock, stated exactly.** Timing starts at the first line of the `http.createServer` callback and stops on the response's `finish` event. *(A follow-up, `f9b8810`, adds a
diag logger inside `startOtel`: OpenTelemetry discards exporter errors unless one is installed, and
nothing in this stack reads `OTEL_LOG_LEVEL` — that belongs to `NodeSDK`, deliberately unused. Without
it a dead collector produced zero output and Task 11 Step 6's check could never go red.)* That is strictly wider than the existing `Server-Timing` `app` phase, which excludes both the request-body read and the response write. It is still **narrower than what a client sees**: it cannot include the time a request spent in the kernel accept queue while `pbkdf2Sync` blocked the event loop. That gap is the project's headline failure mode and is deliberately left out of the SLI — spec §11 covers how it is observed instead.

- [x] **Step 1: Write the failing config test**

Append to `test/config.test.js`:

```js
test('otel config has safe defaults and is disabled without an endpoint', () => {
  const off = loadConfig({});
  assert.equal(off.otlpEndpoint, undefined);
  assert.equal(off.exportIntervalMs, 15000);
  assert.equal(off.serviceName, 'ecs-dynamodb-rps-ceiling');

  const on = loadConfig({ OTLP_ENDPOINT: 'http://collector.local:4318', OTEL_EXPORT_INTERVAL_MS: '5000' });
  assert.equal(on.otlpEndpoint, 'http://collector.local:4318');
  assert.equal(on.exportIntervalMs, 5000);
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `npm test -- test/config.test.js`
Expected: FAIL — `expected undefined to equal 15000`.

- [x] **Step 3: Extend `loadConfig`**

In `src/config.js`, add to the returned object:

```js
    serviceName: env.OTEL_SERVICE_NAME ?? 'ecs-dynamodb-rps-ceiling',
    // Absent => no exporter is started and recordRequest stays a no-op. That is
    // what lets every unit and integration test run with no collector present.
    otlpEndpoint: env.OTLP_ENDPOINT || undefined,
    exportIntervalMs: num(env, 'OTEL_EXPORT_INTERVAL_MS', 15_000),
```

- [x] **Step 4: Record the request in `server.js`**

Replace the `createServer` body. Two changes only: a start timestamp before anything else, and a `finish` listener.

```js
export function createServer({ handlers }) {
  return http.createServer(async (req, res) => {
    // First line: as close to "the event loop reached this request" as Node
    // allows. Everything before it -- accept queue, header parse -- is
    // invisible to the process by construction. See spec section 11.
    const startedAt = performance.now();
    const timer = createTimer();
    const path = req.url.split('?')[0];
    const route = matchRoute(req.method, path);
    // Unmatched paths collapse to one bounded label value. Recording req.url
    // here would let any internet scanner mint new time series.
    const template = route ? route.template : 'unmatched';

    res.on('finish', () => recordRequest({
      route: template,
      method: req.method,
      status: res.statusCode,
      durationSeconds: (performance.now() - startedAt) / 1000,
    }));

    const send = (status, body) => {
      const header = timer.header();
      if (header) res.setHeader('Server-Timing', header);
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };

    if (!route) return send(404, { error: 'no route' });

    try {
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      const dispatch = () => handlers[route.name]({ params: route.params, body, timer });
      const result = route.name === 'health' ? await dispatch() : await timer.measure('app', dispatch);
      send(result.status, result.body);
    } catch (err) {
      send(500, { error: err.message });
    }
  });
}
```

Add to the imports at the top of `server.js`:

```js
import { performance } from 'node:perf_hooks';
import { recordRequest, startOtel } from './otel.js';
```

- [x] **Step 5: Start the exporter at boot and flush on shutdown**

In the `import.meta.url === ...` block, replace the startup and signal handling:

```js
  const config = loadConfig();
  const repo = createRepo(config);
  // Started before the listener so no request is served unrecorded.
  const otel = config.otlpEndpoint
    ? await startOtel({ ...config, instanceIdFallback: `local-${process.pid}` })
    : null;
  const server = createServer({ handlers: createHandlers({ repo, config }) });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout   = 66_000;
  server.listen(config.port, () => console.log(JSON.stringify({ msg: 'listening', ...config })));

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => server.close(async () => {
      // ECS sends SIGTERM then waits stopTimeout. Flushing here is worth doing:
      // at 1000 RPS an unflushed 15s interval is 15,000 requests missing from
      // the window. Counters are cumulative, but only for a task still alive to
      // send them.
      if (otel) await otel.shutdown().catch(() => {});
      repo.destroy();
      process.exit(0);
    }));
  }
```

The enclosing block must become `async`, or wrap it in an IIFE — `await` at module top level is legal in ESM, so `await startOtel(...)` works as written.

- [x] **Step 6: Add the integration assertion**

Append to `test/integration.test.js`. This runs against DynamoDB Local and asserts the metric exists with the right attributes, without any collector:

```js
test('a served request produces one exponential-histogram datapoint per route', async (t) => {
  const { AggregationTemporality, DataPointType, MetricReader } = await import('@opentelemetry/sdk-metrics');
  const { resourceFromAttributes } = await import('@opentelemetry/resources');
  const { REQUEST_DURATION, bindHistogram, buildMeterProvider } = await import('../src/otel.js');

  class TestReader extends MetricReader {
    selectAggregationTemporality() { return AggregationTemporality.CUMULATIVE; }
    async onForceFlush() {}
    async onShutdown() {}
  }
  const reader = new TestReader();
  const provider = buildMeterProvider({
    resource: resourceFromAttributes({ 'service.name': 'itest', 'service.instance.id': 'itest-1' }),
    readers: [reader],
  });
  bindHistogram(provider);
  t.after(() => provider.shutdown());

  await fetch(`${baseUrl}/healthz`);
  await fetch(`${baseUrl}/items/feed-00/item-00`);
  await fetch(`${baseUrl}/nope/whatever`);

  const { resourceMetrics } = await reader.collect();
  const metric = resourceMetrics.scopeMetrics[0].metrics.find((m) => m.descriptor.name === REQUEST_DURATION);
  const routes = metric.dataPoints.map((p) => p.attributes['http.route']).sort();

  assert.equal(metric.dataPointType, DataPointType.EXPONENTIAL_HISTOGRAM);
  // /healthz IS emitted -- it is excluded in the SLO QUERY, not at the source
  // (spec S15). 'unmatched' proves a scanner cannot mint series from raw paths.
  assert.deepEqual(routes, ['/healthz', '/items/:pk/:sk', 'unmatched']);
});
```

- [x] **Step 7: Run everything**

```bash
docker compose -f docker-compose.test.yml up -d
npm test
npm run test:integration
docker compose -f docker-compose.test.yml down
```
Expected: unit PASS (64), integration PASS (10).

- [x] **Step 8: Confirm the image still builds and stays production-only**

```bash
docker build -t ecs-dynamodb-rps-ceiling:otel .
docker run --rm ecs-dynamodb-rps-ceiling:otel node -e "console.log(require('@opentelemetry/sdk-metrics/package.json').version)"
docker run --rm ecs-dynamodb-rps-ceiling:otel node -e "require('yaml')" ; echo "yaml-present=$?"
```
Expected: the OTel version prints (runtime deps are in the image); the `yaml` require **fails** with `MODULE_NOT_FOUND` and a non-zero code — it is a devDependency and `npm ci --omit=dev` must have excluded it. A build tool in the runtime image is a defect, not a convenience.

- [x] **Step 9: Commit**

```bash
git add src/config.js src/server.js test/config.test.js test/integration.test.js
git commit -m "feat(ecs-dynamodb-rps-ceiling): record request duration as an otel histogram"
```

---

### Task 7: Measure what the instrumentation costs

**Files:**
- Create: `ecs-dynamodb-rps-ceiling/scripts/bench-otel.js`

**Interfaces:**
- Consumes: `recordRequest`, `bindHistogram`, `buildMeterProvider` (Task 5).
- Produces: a per-call microsecond figure, printed as JSON. Task 13 uses it as the expectation to check the Fargate re-calibration against.

**Why.** `pbkdf2_iterations = 2675` was calibrated against an uninstrumented service to put the service ceiling at ~70% of the DB ceiling. Instrumentation costs CPU, so that number moves. Measuring the cost *locally first* means Task 13 has a prediction to falsify rather than only a result to accept — and "what OpenTelemetry costs per request at this scale" is itself a number worth publishing.

- [x] **Step 1: Write the benchmark**

Create `scripts/bench-otel.js`:

```js
// Isolates the cost of the metric record itself: no HTTP, no DynamoDB, no GC
// pressure from anything else. The absolute number is machine-specific and
// meaningless on its own -- the RATIO to the 250us/request budget is the point,
// and Task 13 re-measures on real Fargate hardware.
import { AggregationTemporality, MetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { bindHistogram, buildMeterProvider, recordRequest } from '../src/otel.js';

class NullReader extends MetricReader {
  selectAggregationTemporality() { return AggregationTemporality.CUMULATIVE; }
  async onForceFlush() {}
  async onShutdown() {}
}

const N = Number(process.env.N ?? 200_000);
const ROUTES = ['/items/:pk/:sk', '/items', '/feeds/:pk', '/reports'];

const provider = buildMeterProvider({
  resource: resourceFromAttributes({ 'service.name': 'bench', 'service.instance.id': 'bench-1' }),
  readers: [new NullReader()],
});
bindHistogram(provider);

// Warm up so the JIT has settled before the measured window.
for (let i = 0; i < 20_000; i++) recordRequest({ route: ROUTES[i % 4], method: 'GET', status: 200, durationSeconds: 0.004 });

const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) recordRequest({ route: ROUTES[i % 4], method: 'GET', status: 200, durationSeconds: 0.004 });
const t1 = process.hrtime.bigint();

const perCallUs = Number(t1 - t0) / N / 1000;
console.log(JSON.stringify({
  iterations: N,
  perCallMicroseconds: Number(perCallUs.toFixed(3)),
  // 0.25 vCPU at 1000 RPS is 250us per request, all in.
  percentOfBudgetAt1000rps: Number(((perCallUs / 250) * 100).toFixed(2)),
}));
await provider.shutdown();
```

- [x] **Step 2: Run it and record the output verbatim**

Run: `node scripts/bench-otel.js`
Expected: a single JSON line. Paste it into the task report — this is a measured number and `CLAUDE.md` forbids reporting it from memory later.

- [x] **Step 3: Sanity-check the magnitude**

If `percentOfBudgetAt1000rps` is above ~5%, stop and investigate before proceeding: at that level the instrumentation is a material share of the thing being measured and the exponential histogram's `maxSize` or the attribute set is the first place to look. A single `record()` into an exponential histogram with three attributes should be well under a microsecond on a modern laptop core.

This is a **local laptop core**, not an x86_64 Fargate slice. Do not treat the number as the answer for production — it is the prediction Task 13 tests.

- [x] **Step 4: Commit**

```bash
git add scripts/bench-otel.js
git commit -m "test(ecs-dynamodb-rps-ceiling): benchmark the otel record path"
```

---

## Phase 3 — Collector infrastructure (written and planned, not applied)

### Task 8: The Alloy configuration and its class map

**Files:**
- Modify: `ecs-dynamodb-rps-ceiling/slo.yaml`
- Modify: `ecs-dynamodb-rps-ceiling/scripts/generate-slo.js`
- Create: `ecs-dynamodb-rps-ceiling/grafana/alloy.alloy.tftpl`
- Create: `ecs-dynamodb-rps-ceiling/grafana/classmap.json` (generated)
- Modify: `ecs-dynamodb-rps-ceiling/test/generate-slo.test.js`

**Interfaces:**
- Consumes: `loadSlo` (Task 1); route templates (Task 4).
- Produces: `grafana/classmap.json` — `{ "<route template>": "<class>" }` — consumed by `templatefile()` in Task 9; `grafana/alloy.alloy.tftpl` taking one variable, `class_statements`.

**Why `slo.yaml` grows an `endpoints:` block.** `slo.yaml` names endpoints (`getItem`, `feed`) but the collector keys on route templates (`/items/:pk/:sk`). Something has to hold the mapping, and if it lives anywhere but the source file it becomes a fourth place the SLO is defined. Putting it in `slo.yaml` also makes a cross-check possible: a test asserts every template in `slo.yaml` exists in `handlers.js` and vice versa, so renaming a route breaks the build instead of silently unclassifying its traffic.

- [x] **Step 1: Write the failing tests**

Append to `test/generate-slo.test.js`:

```js
import { matchRoute } from '../src/handlers.js';
import { renderClassMap } from '../scripts/generate-slo.js';

test('every endpoint in slo.yaml maps to a route template that handlers.js serves', () => {
  const model = loadSlo(`${HERE}slo.yaml`);
  for (const [name, template] of Object.entries(model.endpoints)) {
    // Rebuild a concrete path from the template so matchRoute can be asked
    // whether this route still exists under that exact name.
    const concrete = template.replace(/:[^/]+/g, 'x');
    const method = template === '/items' || template === '/reports' ? 'POST' : 'GET';
    const hit = matchRoute(method, concrete);
    assert.ok(hit, `slo.yaml names endpoint "${name}" at ${template}, which handlers.js does not serve`);
    assert.equal(hit.template, template);
    assert.equal(hit.name, name);
  }
});

test('every class member is a declared endpoint', () => {
  const model = loadSlo(`${HERE}slo.yaml`);
  const slo = model.slos.find((s) => s.sli === 'class_threshold_ratio');
  for (const cls of Object.values(slo.classes)) {
    for (const endpoint of cls.endpoints) {
      assert.ok(model.endpoints[endpoint], `class references undeclared endpoint "${endpoint}"`);
    }
  }
});

test('the class map is keyed by route template, not endpoint name', () => {
  const map = JSON.parse(renderClassMap(loadSlo(`${HERE}slo.yaml`)));
  assert.deepEqual(map, {
    '/items/:pk/:sk': 'fast',
    '/items': 'fast',
    '/feeds/:pk': 'standard',
    '/reports': 'heavy',
  });
  // /healthz and /stats are absent on purpose: they are emitted but unclassified,
  // and the SLO query excludes them by selector (spec S15).
  assert.equal(map['/healthz'], undefined);
});
```

- [x] **Step 2: Run and watch them fail**

Run: `npm test -- test/generate-slo.test.js`
Expected: FAIL — `model.endpoints` is undefined, `renderClassMap` is not exported.

- [x] **Step 3: Add `endpoints:` to `slo.yaml`**

Insert after the `service`/`window` lines:

```yaml
# endpoint name -> route TEMPLATE as handlers.js matches it. The collector keys
# its class mapping on the template; a test cross-checks both directions, so a
# renamed route fails the build instead of silently leaving traffic unclassified.
endpoints:
  getItem: /items/:pk/:sk
  putItem: /items
  feed:    /feeds/:pk
  report:  /reports
```

- [x] **Step 4: Validate and render in the generator**

Add to `loadSlo`, after the class-uniqueness loop:

```js
  for (const slo of doc.slos ?? []) {
    if (slo.sli !== 'class_threshold_ratio') continue;
    for (const [name, cls] of Object.entries(slo.classes)) {
      for (const endpoint of cls.endpoints) {
        if (!doc.endpoints?.[endpoint]) throw new Error(`class "${name}" references undeclared endpoint "${endpoint}"`);
      }
    }
  }
```

And export the renderer:

```js
/** { "<route template>": "<class>" } -- what the collector's OTTL keys on. */
export function renderClassMap(doc) {
  const slo = classRatio(doc);
  const map = {};
  for (const [name, cls] of Object.entries(slo.classes)) {
    for (const endpoint of cls.endpoints) map[doc.endpoints[endpoint]] = name;
  }
  return `${JSON.stringify(map, null, 2)}\n`;
}
```

Add `['grafana/classmap.json', renderClassMap]` to `OUTPUTS`.

- [x] **Step 5: Write the Alloy template**

Create `grafana/alloy.alloy.tftpl`. This is spec §16 with the class statements lifted out so Terraform can interpolate them from `classmap.json`:

```hcl
// GENERATED into ALLOY_CONFIG_CONTENT by Terraform. Do not edit in the console.
// Spec: docs/superpowers/specs/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection-design.md section 16

// === Pipeline 1: service metrics. OTLP in, OTLP out, exponential histograms
// === pass through unconverted and land in Mimir as native histograms.
otelcol.receiver.otlp "app" {
  http { endpoint = "0.0.0.0:4318" }
  grpc { endpoint = "0.0.0.0:4317" }
  output { metrics = [otelcol.processor.transform.classify.input] }
}

otelcol.processor.transform "classify" {
  error_mode = "ignore"

  metric_statements {
    context = "datapoint"
    statements = [
${class_statements}
      // traffic_source: default first, then override. OTTL runs statements in
      // order. Bounded to three values so an arbitrary internet user-agent
      // cannot become a label; the raw user-agent is dropped for that reason.
      `set(attributes["traffic_source"], "other")`,
      `set(attributes["traffic_source"], "k6")        where IsMatch(attributes["user_agent.original"], "^k6/")`,
      `set(attributes["traffic_source"], "synthetic") where IsMatch(attributes["user_agent.original"], "Synthetic")`,
      `delete_key(attributes, "user_agent.original")`,
    ]
  }

  output { metrics = [otelcol.processor.batch.default.input] }
}

otelcol.processor.batch "default" {
  output { metrics = [otelcol.exporter.otlphttp.grafana_cloud.input] }
}

otelcol.auth.basic "grafana_cloud_otlp" {
  username = sys.env("OTLP_USERNAME")
  password = sys.env("OTLP_PASSWORD")
}

otelcol.exporter.otlphttp "grafana_cloud" {
  client {
    endpoint = sys.env("OTLP_ENDPOINT")
    auth     = otelcol.auth.basic.grafana_cloud_otlp.handler
  }
}

// === Pipeline 2: AWS metrics, discovered by the Project tag. One collector for
// === the cluster, so this polls once rather than once per app task.
// delay is mandatory: CloudWatch publishes with lag, and polling up to now
// returns empty recent periods that look like an outage during a load test.
prometheus.exporter.cloudwatch "aws" {
  sts_region = "${region}"

  discovery {
    type        = "AWS/DynamoDB"
    regions     = ["${region}"]
    search_tags = { "Project" = "${project}" }
    period      = "60s"
    length      = "300s"
    delay       = "120s"

    metric { name = "ThrottledRequests",          statistics = ["Sum"] }
    metric { name = "ReadThrottleEvents",         statistics = ["Sum"] }
    metric { name = "WriteThrottleEvents",        statistics = ["Sum"] }
    metric { name = "ConsumedReadCapacityUnits",  statistics = ["Sum"] }
    metric { name = "ConsumedWriteCapacityUnits", statistics = ["Sum"] }
    metric { name = "SuccessfulRequestLatency",   statistics = ["Average", "Maximum"] }
  }

  discovery {
    type        = "AWS/ApplicationELB"
    regions     = ["${region}"]
    search_tags = { "Project" = "${project}" }
    period      = "60s"
    length      = "300s"
    delay       = "120s"

    metric { name = "RequestCount",              statistics = ["Sum"] }
    metric { name = "TargetResponseTime",        statistics = ["Average", "Maximum"] }
    metric { name = "HTTPCode_Target_5XX_Count", statistics = ["Sum"] }
  }

  discovery {
    type        = "AWS/ECS"
    regions     = ["${region}"]
    search_tags = { "Project" = "${project}" }
    period      = "60s"
    length      = "300s"
    delay       = "120s"

    metric { name = "CPUUtilization",    statistics = ["Average", "Maximum"] }
    metric { name = "MemoryUtilization", statistics = ["Average", "Maximum"] }
  }
}

prometheus.scrape "cloudwatch" {
  targets         = prometheus.exporter.cloudwatch.aws.targets
  forward_to      = [prometheus.remote_write.grafana_cloud.receiver]
  scrape_interval = "60s"
}

prometheus.remote_write "grafana_cloud" {
  endpoint {
    url = sys.env("PROM_URL")
    basic_auth {
      username = sys.env("PROM_USERNAME")
      password = sys.env("PROM_PASSWORD")
    }
  }
}
```

Note `TargetResponseTime` carries only `Average` and `Maximum`. Spec §14 item 7 flags `p95` as unverified in a YACE `statistics` list; a config that fails to load takes the whole collector down, so the percentile is added in Task 12 only after the collector is confirmed healthy.

> **CORRECTION (fixed in `487aa5f`). The config above does not parse.** `alloy validate`, run out
> of the pinned `grafana/alloy:v1.10.0` image, rejects it — and a config that fails to load
> crash-loops the collector at task start. Three defects, all in
> `prometheus.exporter.cloudwatch`; pipeline 1 and the OTTL block were always valid.
>
> 1. **Block arguments are newline-separated, never comma-separated.** All 11
>    `metric { name = "X", statistics = [...] }` one-liners are syntax errors
>    (`expected TERMINATOR, got ,`). Removing just the commas is still invalid
>    (`expected TERMINATOR, got IDENT`) — each attribute needs its own line.
> 2. **`period` and `length` belong to `metric`, not `discovery`.** On `discovery` they are
>    `unrecognized attribute name`; omitted from `metric`, `missing required attribute "period"` ×11.
> 3. **`delay` does not exist on this component in v1.10.0** — not on `discovery`, not on `metric`,
>    not at the exporter root. The comment above calls it mandatory; **that premise is wrong and
>    spec §16 must be corrected.** The CloudWatch publish lag it was meant to absorb is handled by
>    `length` being 5× `period`: each poll asks for a 300 s window and takes the newest datapoint
>    actually published. (`add_cloudwatch_timestamp` on `metric` and `decoupled_scraping` on the
>    exporter do exist, if ever needed.)
>
> The corrected config validates at exit 0 and renders to 5,313 B, ~8% of the 64 KiB
> task-definition limit — closing spec §14 item 8.
>
> **Spec §14 item 9 was right and the component reference was wrong.** Validate any Alloy config
> against the pinned image before applying; if `alloy` is not installed locally, run it from the
> image: `docker run --rm -v "$PWD:/w" --entrypoint /bin/alloy grafana/alloy:v1.10.0 validate
> --stability.level=experimental /w/config.alloy`.

- [x] **Step 6: Regenerate and run the suite**

```bash
npm run slo:generate
npm test
git diff --stat
```
Expected: `grafana/classmap.json` created; `k6/lib/slo.js` and `capacity.auto.tfvars` **unchanged**; all tests pass.

- [x] **Step 7: Commit**

```bash
git add slo.yaml scripts/generate-slo.js grafana/classmap.json grafana/alloy.alloy.tftpl test/generate-slo.test.js
git commit -m "feat(ecs-dynamodb-rps-ceiling/grafana): add the alloy config and class map"
```

---

### Task 9: Terraform for the collector

**Files:**
- Create: `ecs-dynamodb-rps-ceiling/terraform/collector.tf`
- Modify: `ecs-dynamodb-rps-ceiling/terraform/variables.tf`
- Modify: `ecs-dynamodb-rps-ceiling/terraform/ecs.tf:68-74`
- Modify: `ecs-dynamodb-rps-ceiling/terraform/outputs.tf`

**Interfaces:**
- Consumes: `grafana/alloy.alloy.tftpl`, `grafana/classmap.json` (Task 8); the existing `aws_vpc.main`, `aws_subnet.public`, `aws_security_group.task`, `aws_iam_role.execution`.
- Produces: a Cloud Map DNS name the app task reaches as `OTLP_ENDPOINT`. Task 11 applies it.

- [x] **Step 1: Add the variables**

Append to `terraform/variables.tf`:

```hcl
variable "collector_cpu" {
  description = "Collector task CPU units. Separate from the app task -- the whole point of a gateway collector is that it never draws on the app's 256."
  type        = number
  default     = 256
}

variable "collector_memory" {
  description = "Collector task memory (MiB). A starting point, not a measured size: YACE's CloudWatch polling is the memory risk."
  type        = number
  default     = 512
}

variable "alloy_image" {
  description = "Pinned. 'latest' would make the collector's behaviour change without a commit."
  type        = string
  default     = "grafana/alloy:v1.10.0"
}

variable "grafana_otlp_endpoint" {
  description = "Grafana Cloud OTLP gateway URL, e.g. https://otlp-gateway-<zone>.grafana.net/otlp"
  type        = string
}

variable "grafana_otlp_username" {
  description = "Grafana Cloud OTLP instance ID."
  type        = string
}

variable "grafana_otlp_password" {
  description = "Grafana Cloud access policy token, metrics:write scope only."
  type        = string
  sensitive   = true
}

variable "grafana_prom_url" {
  description = "Grafana Cloud Prometheus remote-write URL (the existing K6_PROMETHEUS_RW_SERVER_URL)."
  type        = string
}

variable "grafana_prom_username" {
  description = "Grafana Cloud Prometheus instance ID."
  type        = string
}

variable "grafana_prom_password" {
  description = "Grafana Cloud Prometheus password."
  type        = string
  sensitive   = true
}

variable "prometheus_datasource_uid" {
  description = "Grafana Cloud Prometheus datasource UID. Passed to the grafana module in Task 15."
  type        = string
  default     = "grafanacloud-prom"
}

variable "cloudwatch_datasource_uid" {
  description = "Existing CloudWatch datasource, verified against this AWS account on 2026-08-30. Its defaultRegion is us-east-1, so every panel pins eu-central-1 itself."
  type        = string
  default     = "a4139e7c-dc84-47c8-b90b-d710ec0fe3fb"
}
```

Every credential is `sensitive = true` so plan and apply output redacts it. They still reach the container as **plain task-definition environment variables** (spec S11) and are readable via `ecs:DescribeTaskDefinition` — which is why the OTLP token must be scoped to metrics write and nothing else.

- [x] **Step 2: Write `collector.tf`**

```hcl
# One collector for the cluster, not a sidecar per task (spec S1). Fargate's CPU
# limit is per TASK, so a sidecar would draw on the 256 units that
# pbkdf2_iterations is calibrated against -- and would poll CloudWatch once per
# task, quadrupling both series and API charges under 1->4 autoscaling.
#
# This diverges from Grafana's documented ECS pattern, which is a sidecar. The
# divergence is deliberate; see spec section 6.

resource "aws_service_discovery_private_dns_namespace" "internal" {
  name        = "${var.project}.local"
  description = "Service discovery for the metrics collector"
  vpc         = aws_vpc.main.id
}

resource "aws_service_discovery_service" "collector" {
  name = "collector"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.internal.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_security_group" "collector" {
  name        = "${var.project}-collector"
  description = "Collector accepts OTLP only from the app tasks"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 4317
    to_port         = 4318
    protocol        = "tcp"
    security_groups = [aws_security_group.task.id]
  }

  # Outbound to Grafana Cloud and the CloudWatch API. No NAT gateway exists, so
  # the task carries a public IP and egresses through the internet gateway.
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project}-collector"
  }
}

resource "aws_cloudwatch_log_group" "collector" {
  name              = "/ecs/${var.project}-collector"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "collector_task" {
  name               = "${var.project}-collector-task"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_tasks.json
}

data "aws_iam_policy_document" "collector_cloudwatch_read" {
  statement {
    # Read-only. GetMetricData and ListMetrics do not take a resource ARN;
    # tag:GetResources is what YACE's discovery jobs use to find this project's
    # resources by the Project tag.
    actions = [
      "cloudwatch:GetMetricData",
      "cloudwatch:ListMetrics",
      "tag:GetResources",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "collector_task" {
  name   = "${var.project}-collector-cloudwatch-read"
  role   = aws_iam_role.collector_task.id
  policy = data.aws_iam_policy_document.collector_cloudwatch_read.json
}

locals {
  # OTTL statements, one per route template, generated from slo.yaml by
  # `npm run slo:generate`. Sorted so the rendered config is stable across plans
  # and a diff means a real change.
  alloy_class_statements = join("\n", [
    for template, class in jsondecode(file("${path.module}/../grafana/classmap.json")) :
    format("      `set(attributes[\"class\"], \"%s\") where attributes[\"http.route\"] == \"%s\"`,", class, template)
  ])

  alloy_config = templatefile("${path.module}/../grafana/alloy.alloy.tftpl", {
    class_statements = local.alloy_class_statements
    region           = data.aws_region.current.region
    project          = var.project
  })
}

resource "aws_ecs_task_definition" "collector" {
  family                   = "${var.project}-collector"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.collector_cpu
  memory                   = var.collector_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.collector_task.arn

  container_definitions = jsonencode([{
    name      = "alloy"
    image     = var.alloy_image
    essential = true

    # Alloy does not read ALLOY_CONFIG_CONTENT itself. This is Grafana's own
    # documented ECS pattern: write the variable to a file, then exec.
    # --stability.level=experimental is REQUIRED for the native OTLP receiver
    # path, not a nicety.
    entryPoint = ["/bin/sh", "-c"]
    command = [
      "printenv ALLOY_CONFIG_CONTENT > /tmp/config.alloy && exec /bin/alloy run --stability.level=experimental --server.http.listen-addr=0.0.0.0:12345 /tmp/config.alloy"
    ]

    portMappings = [
      { containerPort = 4317, protocol = "tcp" },
      { containerPort = 4318, protocol = "tcp" },
    ]

    environment = [
      { name = "ALLOY_CONFIG_CONTENT", value = local.alloy_config },
      { name = "OTLP_ENDPOINT", value = var.grafana_otlp_endpoint },
      { name = "OTLP_USERNAME", value = var.grafana_otlp_username },
      { name = "OTLP_PASSWORD", value = var.grafana_otlp_password },
      { name = "PROM_URL", value = var.grafana_prom_url },
      { name = "PROM_USERNAME", value = var.grafana_prom_username },
      { name = "PROM_PASSWORD", value = var.grafana_prom_password },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.collector.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "alloy"
      }
    }
  }])
}

resource "aws_ecs_service" "collector" {
  name            = "${var.project}-collector"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.collector.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.collector.id]
    assign_public_ip = true
  }

  service_registries {
    registry_arn = aws_service_discovery_service.collector.arn
  }
}
```

- [x] **Step 3: Point the app tasks at the collector**

In `terraform/ecs.tf`, append to the app container's `environment` list:

```hcl
      { name = "OTLP_ENDPOINT", value = "http://collector.${aws_service_discovery_private_dns_namespace.internal.name}:4318" },
```

Absent this variable the service runs with `recordRequest` as a no-op — which is the correct failure mode: the service serves traffic normally and emits nothing, rather than crash-looping because a collector is missing.

- [x] **Step 4: Add outputs**

Append to `terraform/outputs.tf`:

```hcl
output "collector_endpoint" {
  description = "OTLP endpoint the app tasks export to. Task 12 verifies traffic reaches it."
  value       = "http://collector.${aws_service_discovery_private_dns_namespace.internal.name}:4318"
}

output "collector_service_name" {
  value = aws_ecs_service.collector.name
}
```

- [x] **Step 5: Validate**

```bash
terraform -chdir=terraform fmt -check -recursive
terraform -chdir=terraform init -input=false
terraform -chdir=terraform validate
```
Expected: `fmt` silent, `validate` succeeds.

- [x] **Step 6: Render the config locally and eyeball it before it is ever deployed**

A malformed Alloy config crash-loops the collector, and the feedback loop through ECS is minutes long. Render it first:

```bash
terraform -chdir=terraform console <<'EOF'
local.alloy_config
EOF
```

Confirm the class statements are present, one per route template, and that no `${...}` placeholder survived un-interpolated. If Alloy is installed locally, also run `alloy fmt` on the rendered output — OTTL syntax is version-sensitive and the component reference is not a substitute for the parser (spec §14, item 9).

- [x] **Step 7: Commit**

```bash
git add terraform/collector.tf terraform/variables.tf terraform/ecs.tf terraform/outputs.tf
git commit -m "feat(ecs-dynamodb-rps-ceiling/terraform): add the alloy collector service"
```

---

### Task 10: Move the workspace to remote execution

**Files:**
- Modify: `.env.example` (documents the new variables; `.env` is gitignored and edited by hand)

**Interfaces:**
- Consumes: nothing.
- Produces: an HCP workspace that injects credentials into runs. Task 11 depends on it.

**Why this is forced, and why it is its own task.** Holding credentials in Terraform Cloud (spec S11) only works in **remote** execution mode — in local mode Terraform runs on the developer's machine and reads the root `.env`, and workspace variables are ignored entirely. So "stored in Terraform Cloud" would otherwise be a no-op that looks configured. This touches how every future apply authenticates against a **live, billing** environment, so it gets its own task and its own verification, and it is reversible in one API call.

The `terraform apply` approval gate is unaffected: runs are still CLI-initiated, so `.claude/hooks/guard-terraform.sh` still fires.

- [x] **Step 1: Create the Grafana Cloud OTLP access policy**

The root `.env` has `K6_PROMETHEUS_RW_*` for remote-write, but **nothing for the OTLP gateway** — a different endpoint with its own instance ID and token (spec §11). In the Grafana Cloud portal, create an access policy scoped to **`metrics:write` only**, generate a token, and read the OTLP endpoint and instance ID from the stack's connection details.

Add to `.env` (gitignored) and to `.env.example` (with empty values):

```bash
# --- Grafana Cloud OTLP gateway (the collector's metrics egress) ------------
# Distinct from K6_PROMETHEUS_RW_* — different endpoint, different instance ID.
# Scope the access policy to metrics:write ONLY: this value reaches the ECS task
# definition as a plain environment variable and is readable by anyone with
# ecs:DescribeTaskDefinition.
GRAFANA_OTLP_ENDPOINT=
GRAFANA_OTLP_USERNAME=
GRAFANA_OTLP_PASSWORD=
```

- [x] **Step 2: Capture the current plan as the baseline**

Before changing anything, record what a correct plan looks like:

```bash
set -a && source .env && set +a
cd ecs-dynamodb-rps-ceiling
terraform -chdir=terraform plan -var-file=dev.tfvars -no-color -input=false > /tmp/plan-local-baseline.txt
grep -E '^(Plan:|No changes)' /tmp/plan-local-baseline.txt
```

Expected: the collector resources appear as adds. **Record the exact counts** — Step 6 compares against them, and a plan that differs after the migration means credentials or variables resolved differently.

- [x] **Step 3: Set the workspace variables**

Via the HCP Terraform API, so the change is scripted and auditable rather than clicked. `TF_TOKEN_app_terraform_io` is already in `.env`.

```bash
WS=$(curl -s -H "Authorization: Bearer $TF_TOKEN_app_terraform_io" \
  "https://app.terraform.io/api/v2/organizations/$TF_CLOUD_ORGANIZATION/workspaces/ecs-dynamodb-rps-ceiling" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
echo "workspace=$WS"
```

Then create each variable. Environment-category variables for provider credentials, Terraform-category for the `grafana_*` inputs:

| name | category | sensitive | value |
|---|---|---|---|
| `AWS_ACCESS_KEY_ID` | env | yes | from `.env` |
| `AWS_SECRET_ACCESS_KEY` | env | yes | from `.env` |
| `AWS_REGION` | env | no | `eu-central-1` |
| `GRAFANA_URL` | env | no | from `.env` |
| `GRAFANA_AUTH` | env | yes | from `.env` |
| `grafana_otlp_endpoint` | terraform | no | from `.env` |
| `grafana_otlp_username` | terraform | no | from `.env` |
| `grafana_otlp_password` | terraform | **yes** | from `.env` |
| `grafana_prom_url` | terraform | no | `K6_PROMETHEUS_RW_SERVER_URL` |
| `grafana_prom_username` | terraform | no | `K6_PROMETHEUS_RW_USERNAME` |
| `grafana_prom_password` | terraform | **yes** | `K6_PROMETHEUS_RW_PASSWORD` |

```bash
create_var() {  # name category sensitive value
  curl -s -X POST -H "Authorization: Bearer $TF_TOKEN_app_terraform_io" \
    -H "Content-Type: application/vnd.api+json" \
    -d "$(python3 - "$1" "$2" "$3" "$4" <<'PY'
import json, sys
name, category, sensitive, value = sys.argv[1:5]
print(json.dumps({"data": {"type": "vars", "attributes": {
    "key": name, "value": value, "category": category,
    "sensitive": sensitive == "true", "hcl": False}}}))
PY
)" "https://app.terraform.io/api/v2/workspaces/$WS/vars" | head -c 200; echo
}
```

Mark every credential `sensitive: true`. A sensitive HCP variable is write-only afterwards — **you cannot read it back**, so verify each value before submitting it.

- [x] **Step 4: Switch execution mode to remote**

```bash
curl -s -X PATCH -H "Authorization: Bearer $TF_TOKEN_app_terraform_io" \
  -H "Content-Type: application/vnd.api+json" \
  -d '{"data":{"type":"workspaces","attributes":{"execution-mode":"remote"}}}' \
  "https://app.terraform.io/api/v2/workspaces/$WS" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["attributes"]["execution-mode"])'
```
Expected: `remote`.

- [x] **Step 5: Re-initialise**

Run: `terraform -chdir=terraform init -input=false -reconfigure`
Expected: success. State is unchanged by an execution-mode switch — it already lives in this workspace.

- [x] **Step 6: Verify the plan is identical to the baseline**

```bash
terraform -chdir=terraform plan -var-file=dev.tfvars -no-color -input=false > /tmp/plan-remote.txt
grep -E '^(Plan:|No changes)' /tmp/plan-remote.txt
diff <(grep -E '^  # ' /tmp/plan-local-baseline.txt) <(grep -E '^  # ' /tmp/plan-remote.txt) && echo "IDENTICAL"
```

Expected: `IDENTICAL`, and the same `Plan:` counts as Step 2.

**This is the safety gate.** If the plan now proposes destroying or replacing anything that Step 2 did not, the workspace is authenticating as a different principal or a variable is missing. **Stop, revert `execution-mode` to `local`, and diagnose.** Do not apply a plan you have not seen before.

- [x] **Step 7: Commit**

```bash
git add ../.env.example
git commit -m "build(repo): document the grafana cloud otlp credentials"
```

The body must record that the workspace moved to remote execution and why — spec S12.

---

### Task 11: APPROVAL GATE — apply the collector

**Files:** none changed.

**This task creates billable AWS resources and STOPS for approval. A subagent must not run `apply`.**

- [x] **Step 1: Present the plan for review**

```bash
terraform -chdir=terraform plan -var-file=dev.tfvars -out=terraform/tfplan-collector -input=false
terraform -chdir=terraform show -no-color terraform/tfplan-collector | grep -E '^  # '
```

Expected adds: the Cloud Map namespace and service, the collector security group, log group, IAM role and policy, the collector task definition and service — plus a **replacement of `aws_ecs_task_definition.app`** and an in-place update of `aws_ecs_service.app`, caused solely by the new `OTLP_ENDPOINT` environment variable.

> **CORRECTION (executed 2026-08-31).** Not "solely". The replacement carried three changes:
> `+ OTLP_ENDPOINT`, `+ stopTimeout = 120` (added in Task 9 so the SIGTERM flush is reachable),
> and **`PBKDF2_ITERATIONS 0 → 2675`** — pre-existing drift, because the old plan's Task 17
> calibration reached `dev.tfvars` but was never applied. The live service had been running with
> no CPU burn at all. Applying therefore changed the service's CPU behaviour at the same moment
> the collector appeared.
>
> Actual result: `Apply complete! Resources: 11 added, 1 changed, 1 destroyed.` The two extra adds
> versus this list are `grafana_folder.project` and `grafana_dashboard.attribution`, which had
> never been applied — which also means **Task 15's `moved` blocks will be no-ops.**
>
> The DynamoDB table was untouched, as required: capacity is pinned to 25/25 in `dev.tfvars` (see
> the Deviations section). Outputs confirmed `provisioned_capacity = {read 25, write 25}`.

Expected **not** present: any change to `aws_dynamodb_table.items`. Capacity stays 25/25 — raising it is Task 18 of the *old* plan and is explicitly out of scope. If the plan proposes 1025/200, `capacity.auto.tfvars` has leaked into this run; stop.

- [x] **Step 2: State the cost before asking**

Say plainly: the collector is `0.25 vCPU / 0.5 GB` running continuously, roughly **$0.04/hour**, which approximately **doubles** the environment's ~$0.041/hour idle cost. CloudWatch `GetMetricData` adds on the order of **$0.20/day**. Both stop at `/env down`.

- [x] **Step 3: STOP. Ask for explicit approval.**

- [x] **Step 4: Apply, once approved**

```bash
terraform -chdir=terraform apply terraform/tfplan-collector
```

- [x] **Step 5: Confirm both services are healthy**

```bash
aws ecs describe-services --cluster ecs-dynamodb-rps-ceiling \
  --services ecs-dynamodb-rps-ceiling ecs-dynamodb-rps-ceiling-collector \
  --query 'services[].{name:serviceName,desired:desiredCount,running:runningCount}'
aws logs tail /ecs/ecs-dynamodb-rps-ceiling-collector --since 5m
```

Expected: both services `desired == running`. The collector log shows Alloy starting and **no config parse error**. A crash-loop here is almost always the OTTL syntax of Task 8 Step 6 — read the log, do not restart and hope.

- [x] **Step 6: Confirm the app can resolve the collector**

```bash
aws logs tail /ecs/ecs-dynamodb-rps-ceiling --since 5m | grep -i -E 'otlp|econnrefused|enotfound' || echo "no export errors"
```

> **CORRECTION.** That pattern does not match the line it is looking for. The service logs
> `{"msg":"otel",...}` and an unreachable collector reports `metrics export timed out`, not
> `ECONNREFUSED` — and `otlp` never matches `otel`. Use:
>
> ```bash
> aws logs tail /ecs/ecs-dynamodb-rps-ceiling --since 5m | grep -i -E 'otel|otlp|econnrefused|enotfound'
> ```
>
> Note also that the export timeout is clamped to the export interval, so in production (15 s) a
> dead collector reports a 15 s timeout. Before commit `f9b8810` the SDK logged **nothing at all**
> and this check could never go red.

Expected: no DNS or connection errors. A missing Cloud Map record surfaces as `ENOTFOUND collector.ecs-dynamodb-rps-ceiling.local`.

- [x] **Step 7 (ADDED during execution): rebuild and push the container image**

> **This plan had no task that rebuilt the image, and without it everything downstream is
> dead.** The deployed ECR `:latest` was pushed 2026-08-29 22:09:45; the OpenTelemetry code was
> committed 2026-08-30 21:32:31. The running container was ~23 hours older than the
> instrumentation and contained no OTel code whatsoever, so the collector would have received
> nothing — presenting as an empty query with a healthy service, a healthy collector, and no error
> anywhere. Task 12 would have failed with no way to see why.
>
> The tell was the boot line: `serviceName` and `exportIntervalMs` were absent from
> `{"msg":"listening",...}`. `JSON.stringify` drops `undefined`, which explains a missing
> `otlpEndpoint` on its own — but those two always have values, so their absence proved the image
> predated `loadConfig`'s OTel keys.
>
> ```bash
> ECR=$(terraform -chdir=terraform output -raw ecr_repository_url)
> SHA=$(git rev-parse --short HEAD)
> # --platform: Fargate is x86_64. --provenance=false: single-platform manifest.
> # Brace ${ECR}: in zsh, "$ECR:latest" loses ":l" to a history modifier.
> docker build --platform linux/amd64 --provenance=false --sbom=false \
>   -t "${ECR}:latest" -t "${ECR}:${SHA}" .
> aws ecr get-login-password --region eu-central-1 \
>   | docker login --username AWS --password-stdin "${ECR%%/*}"
> docker push "${ECR}:latest" && docker push "${ECR}:${SHA}"
> aws ecs update-service --cluster ecs-dynamodb-rps-ceiling \
>   --service ecs-dynamodb-rps-ceiling --force-new-deployment
> aws ecs wait services-stable --cluster ecs-dynamodb-rps-ceiling --services ecs-dynamodb-rps-ceiling
> ```
>
> Verify the image before pushing (`ls src/` shows `otel.js`; `require('yaml')` must FAIL), and
> verify after deploying that the boot line carries `serviceName`, `otlpEndpoint` and
> `exportIntervalMs`. Tag with the commit SHA so a running task can be traced to a commit.
>
> **Any future change to `src/` needs this cycle.** Terraform does not rebuild the image.

---

## Phase 4 — Prove the pipeline, then re-calibrate

### Task 12: Prove the histogram arrives, and resolve the spec's open questions

> **CORRECTION (executed 2026-08-31).** Every `curl` in this task authenticates with
> `K6_PROMETHEUS_RW_USERNAME/PASSWORD`. **Those credentials are write-scoped and cannot query** —
> they return `{"status":"error","error":"authentication error: invalid scope requested"}`. Worse,
> a naive parser reads that as zero series, i.e. "no data" when the truth is "could not ask".
>
> Query through the Grafana datasource proxy instead. It needs no new credential:
>
> ```bash
> PROXY="$GRAFANA_URL/api/datasources/proxy/uid/grafanacloud-prom/api/v1"
> curl -s -H "Authorization: Bearer $GRAFANA_AUTH" --data-urlencode "query=<promql>" "$PROXY/query"
> ```
>
> Datasource UIDs confirmed against the live stack: `grafanacloud-prom`, and CloudWatch
> `a4139e7c-dc84-47c8-b90b-d710ec0fe3fb` (the value already defaulted in `variables.tf`).
>
> **Steps 1, 2, 3, 5 and 7 are done.** Steps 4 and 6 remain. Findings are recorded below and in
> `.superpowers/sdd/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection/progress.md`.
>
> | spec §14 item | answer observed |
> |---|---|
> | 2 — detector supplies `service.instance.id`? | **No**, on Fargate as well as locally. Fixed in `c924b4d` by reading `ECS_CONTAINER_METADATA_URI_V4`. |
> | 4 — does OTLP ingest promote `service.name` → `job`? | **Partly.** It joins `service.namespace/service.name`. `service.namespace` was dropped in `c924b4d` so `job` is now the bare name and every query in Task 15 is correct as written. |
> | 6 — YACE `AWS/ECS` discovery by tag? | **Yes** — 2 series. No `static` fallback needed. |
> | — metric name | `http_server_request_duration_seconds`, a true native histogram (`resultType` carries `histogram`, no `_bucket`/`_sum`/`_count`). |
> | — `class` / `traffic_source` | Both present. `/healthz` correctly unclassified. |
>
> `histogram_fraction(0, 0.05, ...)` returned **1** for both fast routes, and the full class-ratio
> query returned **SLI = 1** at fast 0.23 / standard 0.12 / heavy 0.12 req/s.

**Files:** none changed. Findings go in the task report.

**Interfaces:**
- Consumes: the applied environment.
- Produces: verified answers to spec §14 items 2, 4, 5 and 7. Task 15's queries are written against what this task observes, not against what the docs promise.

**Why before anything else depends on it.** Every Grafana resource in Task 15 queries series whose exact names and labels are determined by the OTLP→Prometheus translation. Guessing them means writing alert rules that silently match nothing — which is the *precise* failure the committed `alerts.tf` already has.

- [x] **Step 1: Generate a little traffic**

```bash
BASE=$(terraform -chdir=terraform output -raw base_url)
for i in $(seq 1 200); do
  curl -s -o /dev/null "$BASE/items/feed-00/item-00"
  curl -s -o /dev/null "$BASE/feeds/feed-01"
  curl -s -o /dev/null -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/items"
done
```

Not a load test — a few hundred requests by hand, well under any threshold, purely to populate the histogram. This spends no VU-hours.

- [x] **Step 2: Wait one export interval plus one scrape, then query Grafana Cloud**

Wait at least 45 seconds (15 s export + remote-write flush + ingest).

```bash
set -a && source ../.env && set +a
curl -s -u "$K6_PROMETHEUS_RW_USERNAME:$K6_PROMETHEUS_RW_PASSWORD" \
  --data-urlencode 'query=http_server_request_duration_seconds' \
  "${K6_PROMETHEUS_RW_SERVER_URL%/api/prom/push}/api/prom/api/v1/query" | python3 -m json.tool
```

**Record verbatim in the task report:**

1. The exact **metric name** as it landed. OTLP translation converts dots to underscores and appends the unit; if the name differs from `http_server_request_duration_seconds`, every query in Task 15 uses the observed name.
2. Whether the result type is a **native histogram** (`"histogram"` in the value) rather than `_bucket`/`_sum`/`_count` series. This is the whole design.
3. Whether `instance` and `job` are present as labels — spec §14 item 4. `instance` is what keeps four tasks from colliding on one series.
4. Whether `class` and `traffic_source` are present — proving the Alloy transform ran.

- [x] **Step 3: Prove `histogram_fraction` returns something sane**

```bash
curl -s -u "$K6_PROMETHEUS_RW_USERNAME:$K6_PROMETHEUS_RW_PASSWORD" \
  --data-urlencode 'query=histogram_fraction(0, 0.05, rate(http_server_request_duration_seconds{class="fast"}[5m]))' \
  "${K6_PROMETHEUS_RW_SERVER_URL%/api/prom/push}/api/prom/api/v1/query" | python3 -m json.tool
```

Expected: a value at or very near `1` — unloaded, every fast-class request is far under 50 ms. A value of `0`, `NaN`, or an empty result means the metric is not a native histogram and Task 15 must not be written until that is understood.

- [x] **Step 4: Confirm `service.instance.id` distinguishes tasks**

```bash
aws ecs update-service --cluster ecs-dynamodb-rps-ceiling --service ecs-dynamodb-rps-ceiling --desired-count 2
# wait for both tasks to reach RUNNING, generate a little more traffic, then:
curl -s -u "$K6_PROMETHEUS_RW_USERNAME:$K6_PROMETHEUS_RW_PASSWORD" \
  --data-urlencode 'query=count by (instance) (http_server_request_duration_seconds)' \
  "${K6_PROMETHEUS_RW_SERVER_URL%/api/prom/push}/api/prom/api/v1/query"
aws ecs update-service --cluster ecs-dynamodb-rps-ceiling --service ecs-dynamodb-rps-ceiling --desired-count 1
```

Expected: **two distinct `instance` values.** One value means the tasks are colliding on a single series and the ratio will be corrupt under autoscaling — resolve it by setting `service.instance.id` explicitly from `ECS_CONTAINER_METADATA_URI_V4` in `otel.js` before continuing.

`update-service --desired-count` is a scaling operation, not infrastructure: `aws_ecs_service.app` already has `ignore_changes = [desired_count]`, so Terraform will not fight it and the count is restored in the same step.

- [x] **Step 5: Confirm CloudWatch discovery found this project's resources**

```bash
curl -s -u "$K6_PROMETHEUS_RW_USERNAME:$K6_PROMETHEUS_RW_PASSWORD" \
  --data-urlencode 'query=aws_dynamodb_consumed_read_capacity_units_sum' \
  "${K6_PROMETHEUS_RW_SERVER_URL%/api/prom/push}/api/prom/api/v1/query"
```

Expected: a series for the `ecs-dynamodb-rps-ceiling` table. An empty result for the ECS namespace specifically is spec §14 item 6 — ECS service tag discovery depends on the account's long-ARN setting; the documented fallback is a `static` job naming `ClusterName`/`ServiceName` explicitly. DynamoDB and ALB discovery are not affected by that.

- [x] **Step 6: Try adding the p95 statistic**

Spec §14 item 7. Now that the collector is confirmed healthy, add `"p95"` to `TargetResponseTime`'s `statistics` in `grafana/alloy.alloy.tftpl`, re-plan, apply through the Task 11 gate procedure, and check the collector log. If Alloy rejects it, revert — `Average` and `Maximum` are the documented fallback and are already present.

- [x] **Step 7: Write the findings into the task report and commit any code fix**

If Step 4 forced a change to `otel.js`, commit it:

```bash
git add src/otel.js test/otel.test.js
git commit -m "fix(ecs-dynamodb-rps-ceiling): set service.instance.id from ecs task metadata"
```

---

### Task 13: Re-derive the CPU knob against the instrumented service

**Files:**
- Modify: `ecs-dynamodb-rps-ceiling/terraform/dev.tfvars`

**Interfaces:**
- Consumes: the local benchmark from Task 7 as a prediction.
- Produces: a new `pbkdf2_iterations`. The old plan's Tasks 18–21 read it from `dev.tfvars`.

**Why.** `2675` was calibrated on real Fargate hardware against an **uninstrumented** service, to put the service ceiling at ~70% of the budgeted DB ceiling. Instrumentation costs CPU per request, so the knob must move to preserve that relationship — otherwise the discovery run's knee lands somewhere the plan did not intend and the whole attribution sequence in old-spec §9 loses its footing.

- [x] **Step 1: Use the method that worked, not the ones that did not**

The old plan's ledger records that `aws ecs execute-command` is unavailable (the service was created without `enableExecuteCommand`) and that `docker run --cpus 0.25` is actively misleading on Apple Silicon: the arm64 image measures an M-series core and the amd64 image measures QEMU emulation, and **they err in opposite directions**.

Use a **one-off Fargate task with a command override** — real x86_64, real 0.25 vCPU, seconds of compute, no Terraform change:

```bash
SUBNET=$(aws ec2 describe-subnets \
  --filters "Name=tag:Project,Values=ecs-dynamodb-rps-ceiling" \
  --query 'Subnets[0].SubnetId' --output text)
SG=$(aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=ecs-dynamodb-rps-ceiling-task" \
  --query 'SecurityGroups[0].GroupId' --output text)

aws ecs run-task \
  --cluster ecs-dynamodb-rps-ceiling \
  --launch-type FARGATE \
  --task-definition ecs-dynamodb-rps-ceiling \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG],assignPublicIp=ENABLED}" \
  --overrides '{"containerOverrides":[{"name":"app","command":["node","scripts/calibrate.js"],"environment":[{"name":"TARGET_MS","value":"1.4"}]}]}' \
  --query 'tasks[0].taskArn' --output text
```

`assignPublicIp=ENABLED` is required — there is no NAT gateway, so without it the image pull fails
and the task dies before running anything. Read the result from the task's CloudWatch log stream
under `/ecs/ecs-dynamodb-rps-ceiling`, not from the exit code: `calibrate.js` prints its answer as
JSON on stdout and exits 0 either way.

- [x] **Step 2: Run it twice**

Two runs. If they are within ~5% of each other, take the mean; if not, run a third. The previous calibration got 2653 and 2698 — 1.7% apart — and took their mean.

- [x] **Step 3: Compare against the prediction**

`calibrate.js` binary-searches iterations for a target of 1.4 ms of CPU. Instrumentation consumes part of the per-request budget, so the iteration count should come out **lower** than 2675 by roughly the benchmark figure from Task 7 scaled to Fargate.

If the new number is *higher* than 2675, something is wrong: instrumentation cannot make the CPU faster. Investigate before recording it.

> **CORRECTION (executed 2026-08-31). This test cannot detect the instrumentation, so neither
> direction means what this step claims.** `scripts/calibrate.js` imports `burn()` from `cpu.js`
> and binary-searches it in isolation — no HTTP, no `server.js`, no `otel.js`. It is structurally
> blind to whatever the request path costs, and a *higher* result would send a reader hunting a
> bug that is not there.
>
> Measured: **2665 and 2659**, 0.23% apart, mean **2662** — a −0.49% move against 2675, i.e. host
> variance at twice the same-day spread. The overhead is real but below this method's noise floor
> by construction: Task 7's **0.51 µs/request is 0.036% of the 1.4 ms target, about ONE iteration**.
> The honest prediction was "no detectable change", and that is what happened.
>
> Note also that the `TARGET_MS` environment variable in Step 1's `run-task` override is inert —
> `calibrate.js` reads `process.argv[2]`, so the built-in default of 1.4 applies. Same target, but
> the override does nothing.
>
> To actually measure instrumentation cost, a calibration would have to drive the whole request
> path rather than `burn()` alone.

- [x] **Step 4: Record both the knob and the overhead**

Update `terraform/dev.tfvars`:

```hcl
# Re-calibrated on a real 0.25 vCPU Fargate slice AFTER OpenTelemetry was added
# (this plan, Task 13). The pre-instrumentation value was 2675.
# Two one-off Fargate runs: <a> and <b>; value is their mean.
# Measured instrumentation overhead: <x> us/request, <y>% of the 250us budget.
pbkdf2_iterations = <mean>
```

Fill every placeholder with a measured number from **this session**. `CLAUDE.md` forbids reporting a figure without the output that produced it — paste the raw log lines into the task report.

- [x] **Step 5: Commit**

```bash
git add terraform/dev.tfvars
git commit -m "perf(ecs-dynamodb-rps-ceiling): re-derive the cpu knob for the instrumented service"
```

`perf`, not `fix`: this is a change whose point is the latency/throughput relationship, and `CLAUDE.md` asks that its body carry the numbers.

---

### Task 14: APPROVAL GATE — apply the re-derived CPU knob

**Files:** none changed.

**This task changes a running service and STOPS for approval.**

> **SUPERSEDED 2026-08-31 (user decision): this gate is FOLDED INTO TASK 16.** Do not run a
> separate apply here.
>
> Task 13 re-derived `pbkdf2_iterations` to **2662** from 2675 — a **−0.49% change that sits inside
> the measurement's own noise** (two same-day runs were 0.23% apart), and which the calibration
> cannot attribute to instrumentation anyway; see the Task 13 CORRECTION. A task-definition
> replacement and a rolling deploy to buy a change smaller than the error bars is not worth a
> deploy cycle.
>
> Two changes are therefore pending and ride along with Task 16's apply:
> - `pbkdf2_iterations` 2675 → 2662 (`fbc41e5`) — app task definition replaced
> - `p95` added to `TargetResponseTime` (`c178276`) — collector task definition replaced
>
> Neither creates a resource and neither changes cost. **Task 16's plan review must expect both**,
> plus the Grafana resources, or the extra task-definition churn will look unexplained.

- [x] **Step 1: Plan and show**

```bash
terraform -chdir=terraform plan -var-file=dev.tfvars -out=terraform/tfplan-cpu -input=false
terraform -chdir=terraform show -no-color terraform/tfplan-cpu | grep -E '^  # '
```
Expected: `aws_ecs_task_definition.app` replaced, `aws_ecs_service.app` updated in place. Nothing else. Specifically **not** the DynamoDB table.

- [x] **Step 2: STOP. Ask for explicit approval.**

- [x] **Step 3: Apply and confirm the rollout**

```bash
terraform -chdir=terraform apply terraform/tfplan-cpu
aws ecs describe-services --cluster ecs-dynamodb-rps-ceiling --services ecs-dynamodb-rps-ceiling \
  --query 'services[0].{desired:desiredCount,running:runningCount,deployments:length(deployments)}'
```
Expected: `deployments == 1` once the rollout settles — more than one means the new task definition is failing its health check.

---

## Phase 5 — Grafana as code

### Task 15: Rewrite the alert rules, add the SLO and the idle population

**Files:**
- Modify: `ecs-dynamodb-rps-ceiling/scripts/generate-slo.js`
- Rewrite: `ecs-dynamodb-rps-ceiling/grafana/alerts.tf` (generated)
- Create: `ecs-dynamodb-rps-ceiling/grafana/variables.tf`
- Create: `ecs-dynamodb-rps-ceiling/grafana/slo.tf`
- Modify: `ecs-dynamodb-rps-ceiling/terraform/grafana.tf`
- Modify: `ecs-dynamodb-rps-ceiling/test/generate-slo.test.js`

**Interfaces:**
- Consumes: `loadSlo`, `burnWindows` (Tasks 1–2); the **observed** metric name and labels from Task 12.
- Produces: applied Grafana resources. Task 17 queries them.

**Use what Task 12 observed, not what this plan predicts.** Every identifier below — the metric name, `job`, `instance`, `class` — is written as expected. If Task 12 recorded something different, that is the truth and this task follows it.

- [x] **Step 1: Write the failing test for the alert renderer**

Append to `test/generate-slo.test.js`:

```js
import { renderAlerts } from '../scripts/generate-slo.js';

test('alert rules query native histograms and carry the derived burn windows', () => {
  const out = renderAlerts(loadSlo(`${HERE}slo.yaml`));

  // The whole point of native histograms: thresholds applied at query time.
  assert.match(out, /histogram_fraction\(0, 0\.05,/);   // fast     50ms
  assert.match(out, /histogram_fraction\(0, 0\.2,/);    // standard 200ms
  assert.match(out, /histogram_fraction\(0, 0\.8,/);    // heavy    800ms

  // Derived from window: 3d, not copied from a 30-day reference.
  assert.match(out, /\[6m\]/);
  assert.match(out, /\[36m\]/);
  assert.doesNotMatch(out, /\[1h\]/);
  assert.doesNotMatch(out, /\[6h\]/);

  // The k6-era series must be gone entirely, not merely unused.
  assert.doesNotMatch(out, /slo_met/);
  assert.doesNotMatch(out, /http_req_failed/);

  // Scoped by job, which OTLP derives from service.name -- not by a --tag a run
  // can forget to pass.
  assert.match(out, /job="ecs-dynamodb-rps-ceiling"/);

  // Health checks outnumber real traffic between runs by 1.5x to 6x.
  assert.match(out, /http_route!~"\/healthz\|\/stats"/);
});
```

- [x] **Step 2: Run and watch it fail**

Run: `npm test -- test/generate-slo.test.js`
Expected: FAIL — `renderAlerts` is not exported.

- [x] **Step 3: Implement `renderAlerts`**

Append to `scripts/generate-slo.js`:

```js
const METRIC = 'http_server_request_duration_seconds';
const SCOPE = (doc) => `job="${doc.service}", http_route!~"/healthz|/stats"`;

/** Proportion of requests meeting their own class threshold, over `range`. */
export function ratioExpr(doc, { multiplier = 1, range }) {
  const slo = classRatio(doc);
  const base = SCOPE(doc);
  const good = Object.entries(slo.classes).map(([name, c]) => {
    const bound = ((c.threshold_ms * multiplier) / 1000);
    const sel = `${METRIC}{${base}, class="${name}"}`;
    return `    sum(histogram_fraction(0, ${bound}, rate(${sel}[${range}])) * histogram_count(rate(${sel}[${range}])))`;
  }).join('\n  +\n');
  return `(\n${good}\n  )\n  /\n  sum(histogram_count(rate(${METRIC}{${base}}[${range}])))`;
}

/** Burn alerting reads the MISS rate, so the ratio inverts. */
const missExpr = (doc, opts) => `1 - (\n  ${ratioExpr(doc, opts)}\n)`;

export function renderAlerts(doc) {
  const slo = classRatio(doc);
  const blocks = [];
  for (const [kind, burn] of Object.entries(doc.burn)) {
    for (const [label, objective, multiplier] of [
      ['primary', slo.objective, 1],
      ['tail', slo.tail_objective, slo.tail_multiplier],
    ]) {
      const sustainable = (100 - objective) / 100;
      const threshold = Number((burn.multiplier * sustainable).toFixed(6));
      blocks.push(`resource "grafana_rule_group" "latency_classes_${label}_${kind}burn" {
  name             = "${doc.service} / latency-classes ${label} / ${kind} burn"
  folder_uid       = var.grafana_folder_uid
  interval_seconds = 60

  rule {
    name      = "latency-classes ${label} burn rate >= ${burn.multiplier}x over ${burn.window}"
    condition = "C"
    for       = "${burn.forDuration}"

    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      query_type     = "instant"
      relative_time_range {
        from = ${durationSeconds(burn.window)}
        to   = 0
      }
      model = jsonencode({
        expr = <<-PROMQL
          ${missExpr(doc, { multiplier, range: burn.window }).split('\n').join('\n          ')}
        PROMQL
      })
    }

    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      query_type     = "threshold"
      relative_time_range {
        from = ${durationSeconds(burn.window)}
        to   = 0
      }
      model = jsonencode({
        type       = "threshold"
        expression = "A"
        conditions = [{ evaluator = { type = "gt", params = [${threshold}] } }]
      })
    }

    no_data_state  = "OK"
    exec_err_state = "Error"

    annotations = {
      summary     = "latency-classes ${label} (${objective}% objective) burning error budget ~${burn.multiplier}x sustainable over ${burn.window}."
      computation = "window ${doc.window}; sustainable miss rate = 1 - ${objective / 100} = ${(sustainable * 100).toFixed(3)}%; ${kind}-burn threshold = ${burn.multiplier} * ${(sustainable * 100).toFixed(3)}% = ${(threshold * 100).toFixed(3)}%; alert window ${burn.window} = ${burn.budgetFraction * 100}% of budget"
    }
    labels = {
      severity = "${burn.severity}"
      slo      = "latency-classes-${label}"
    }
  }
}`);
    }
  }
  return `# GENERATED from slo.yaml by /slo. Do not edit by hand.
#
# Burn-rate alerting on error budget, not the raw SLI. Both the multipliers and
# the ALERT WINDOWS are derived from slo.yaml's window (${doc.window}): the
# familiar 14.4x/1h and 6x/6h encode "2% and 5% of budget" on a 30-day window,
# and against ${doc.window} the windows must scale or the same rules silently
# mean something else. Each rule's `computation` annotation shows its own
# arithmetic.
#
# The SLI is emitted by the service continuously -- these rules no longer depend
# on a k6 run having happened, which was the unresolved precondition the previous
# version of this file documented at its top.

${blocks.join('\n\n')}
`;
}
```

Add `['grafana/alerts.tf', renderAlerts]` to `OUTPUTS`.

- [x] **Step 4: Regenerate and read the result**

```bash
npm run slo:generate
npm test
terraform fmt -check grafana/alerts.tf
```
Expected: tests pass, `fmt` silent. **Read the generated file.** A generator's first output is where an escaping bug hides; check the heredoc PromQL is valid and indented consistently.

- [x] **Step 5: Add the module inputs**

Create `grafana/variables.tf`:

```hcl
variable "project" {
  type = string
}

variable "prometheus_datasource_uid" {
  description = "Grafana Cloud Prometheus datasource holding the service-emitted native histograms."
  type        = string
}

variable "cloudwatch_datasource_uid" {
  description = "Existing CloudWatch datasource, verified against this AWS account. Default region is us-east-1, so panels pin eu-central-1 themselves."
  type        = string
}

variable "base_url" {
  description = "Public ALB URL the synthetic checks hit."
  type        = string
}
```

- [x] **Step 6: Add `slo.tf` — the SLO object and the idle population**

> **SUPERSEDED.** The `grafana_synthetic_monitoring_*` resources below were written, then removed
> before they ever applied. The account's Synthetic Monitoring **tenant is disabled**
> (`403 tenant is disabled` straight from the SM API, with a valid token), and re-enabling it needs
> a third credential from the grafana.com org portal. The idle population is an **EventBridge
> Scheduler + Lambda** instead — `terraform/heartbeat.tf` and `heartbeat/index.mjs`. It hits all
> **four** measured routes rather than three, so `heavy` gets an idle population too, and it
> destroys with the rest of the environment. `var.base_url` went with the checks.
>
> `grafana_slo` itself is as written, except the objective and window are no longer literals — they
> come from `slo.yaml` through the generated `grafana/locals.tf`, because typing `0.99` and `"3d"`
> here duplicated the source of truth into a file `slo:check` never read.

Create `grafana/slo.tf`:

```hcl
# The SLO. grafana_slo derives the error budget and the burn windows itself, so
# nothing here pre-computes a ratio -- that is why the SLI had to be a ratio
# rather than a percentile (2026-08-29 spec, D5).
resource "grafana_slo" "latency_classes" {
  name        = "${var.project} latency classes"
  description = "Proportion of requests meeting their own class threshold: fast 50ms, standard 200ms, heavy 800ms."

  query {
    type = "freeform"
    freeform {
      query = local.class_ratio_query
    }
  }

  objectives {
    value  = 0.99
    window = "3d"
  }

  destination_datasource {
    uid = var.prometheus_datasource_uid
  }

  label {
    key   = "project"
    value = var.project
  }
}

# Without this, the SLI has no population between load tests: health checks are
# excluded by selector, so the ratio would simply be no-data. These checks are
# what makes an error budget accrue against real traffic while nothing is
# running -- the premise of the whole SLI-collection design.
data "grafana_synthetic_monitoring_probes" "all" {}

resource "grafana_synthetic_monitoring_check" "endpoints" {
  for_each = {
    read  = "/items/feed-00/item-00"
    feed  = "/feeds/feed-00"
    write = "/items"
  }

  job     = "${var.project}-${each.key}"
  target  = "${var.base_url}${each.value}"
  enabled = true
  # Frankfurt: the same zone the load tests originate from, so the synthetic and
  # k6 populations are not separated by geography as well as by rate.
  probes  = [data.grafana_synthetic_monitoring_probes.all.probes.Frankfurt]

  labels = {
    project = var.project
  }

  settings {
    http {
      method = each.key == "write" ? "POST" : "GET"
      body   = each.key == "write" ? "{}" : null
    }
  }
}
```

Add to `grafana/alerts.tf`'s companion — put `local.class_ratio_query` in a new `grafana/locals.tf` rather than in the generated file, so the generator owns only what it generates:

```hcl
locals {
  # Kept in step with grafana/alerts.tf by test/generate-slo.test.js.
  class_ratio_query = <<-PROMQL
    (
      sum(histogram_fraction(0, 0.05, rate(http_server_request_duration_seconds{job="${var.project}", http_route!~"/healthz|/stats", class="fast"}[5m])) * histogram_count(rate(http_server_request_duration_seconds{job="${var.project}", http_route!~"/healthz|/stats", class="fast"}[5m])))
      + sum(histogram_fraction(0, 0.2, rate(http_server_request_duration_seconds{job="${var.project}", http_route!~"/healthz|/stats", class="standard"}[5m])) * histogram_count(rate(http_server_request_duration_seconds{job="${var.project}", http_route!~"/healthz|/stats", class="standard"}[5m])))
      + sum(histogram_fraction(0, 0.8, rate(http_server_request_duration_seconds{job="${var.project}", http_route!~"/healthz|/stats", class="heavy"}[5m])) * histogram_count(rate(http_server_request_duration_seconds{job="${var.project}", http_route!~"/healthz|/stats", class="heavy"}[5m])))
    )
    /
    sum(histogram_count(rate(http_server_request_duration_seconds{job="${var.project}", http_route!~"/healthz|/stats"}[5m])))
  PROMQL
}
```

- [x] **Step 7: Turn `grafana/` into a module and relocate the existing resources**

Replace `terraform/grafana.tf` with:

```hcl
# CLAUDE.md requires alert rules and SLO definitions to live under the project's
# grafana/. Terraform cannot include a .tf from outside the root module, so
# grafana/ IS a module. Auth still comes from GRAFANA_URL / GRAFANA_AUTH in the
# environment -- never a token in a .tf or .tfvars file.
provider "grafana" {}

module "grafana" {
  source = "../grafana"

  project                   = var.project
  prometheus_datasource_uid = var.prometheus_datasource_uid
  cloudwatch_datasource_uid = var.cloudwatch_datasource_uid
  base_url                  = "http://${aws_lb.main.dns_name}"
}

# The folder and dashboard were declared here before grafana/ became a module.
# `moved` relocates them in state with no manual `terraform state mv`.
#
# NOTE (2026-08-31): these are NO LONGER no-ops. This plan assumed the resources
# might never have been applied -- Task 11's apply created both, and
# `terraform state list` now shows grafana_folder.project and
# grafana_dashboard.attribution at the ROOT module. The moved blocks are
# load-bearing: get them wrong and the folder is destroyed and recreated,
# orphaning the dashboard. Step 8's plan review is the check.
moved {
  from = grafana_folder.project
  to   = module.grafana.grafana_folder.project
}

moved {
  from = grafana_dashboard.attribution
  to   = module.grafana.grafana_dashboard.attribution
}
```

Move the `grafana_folder` and `grafana_dashboard` resources out of `terraform/grafana.tf` and into a new `grafana/folder.tf`, unchanged:

```hcl
resource "grafana_folder" "project" {
  title = var.project
}

resource "grafana_dashboard" "attribution" {
  folder      = grafana_folder.project.uid
  config_json = file("${path.module}/dashboard.json")
}
```

Note `path.module` now resolves to `grafana/`, so the `../grafana/` prefix goes away.

The module owns its folder rather than taking a UID as input, so `renderAlerts` must emit
`folder_uid = grafana_folder.project.uid` instead of `folder_uid = var.grafana_folder_uid`. Change
that one string in the generator, re-run Step 4, and confirm the test still passes.

- [x] **Step 8: Confirm the state relocation is a no-op for infrastructure**

```bash
terraform -chdir=terraform init -input=false
terraform -chdir=terraform validate
terraform -chdir=terraform plan -var-file=dev.tfvars -no-color | grep -E '^(Plan:|No changes|  # )'
```

Expected: the plan shows the alert rules, `grafana_slo` and the synthetic checks as **adds**, and the folder/dashboard as **moved**, never destroyed and recreated. A destroy/create of `grafana_folder` would orphan the dashboard — if you see one, the `moved` blocks are not matching and must be fixed before applying.

- [x] **Step 9: Commit**

```bash
git add scripts/generate-slo.js grafana/ terraform/grafana.tf test/generate-slo.test.js
git commit -m "feat(ecs-dynamodb-rps-ceiling/grafana): compute the slo from service metrics"
```

---

### Task 16: APPROVAL GATE — apply the Grafana resources

**Files:** none changed.

Grafana Cloud resources are not AWS-billable, but Synthetic Monitoring consumes plan allowance and the checks generate continuous traffic against the live service. It gets a gate.

- [x] **Step 1: Plan and show**

```bash
terraform -chdir=terraform plan -var-file=dev.tfvars -out=terraform/tfplan-grafana2 -input=false
terraform -chdir=terraform show -no-color terraform/tfplan-grafana2 | grep -E '^  # '
```

- [x] **Step 2: State what the checks will do.** Three HTTP checks from Frankfurt on the default interval, hitting `/items/feed-00/item-00`, `/feeds/feed-00` and `POST /items`. The `POST` writes an item per check — under the `w#` prefix, which never enters a seeded partition, so it cannot change a feed `Query`'s cost. Confirm the interval and the resulting request rate before approving.

> **What was actually approved.** No Grafana checks (see Task 15 Step 6). A Lambda on
> `rate(1 minute)` hitting all four measured routes — 4 req/min, well inside the Lambda free tier,
> EventBridge Scheduler $0 at this rate. The `POST /items` writes one row per beat (~1,440/day),
> every one carrying `expires_at = now + 3600`, so DynamoDB TTL reclaims them.
>
> The apply also carried two task-definition replacements folded in from Task 14
> (`pbkdf2_iterations` 2675 -> 2662 and `p95`), plus the new container image — the app task
> definition being replaced is what makes ECS pull `:latest` again.

- [x] **Step 3: STOP. Ask for explicit approval.**

- [x] **Step 4: Apply, once approved**

```bash
terraform -chdir=terraform apply terraform/tfplan-grafana2
```

- [x] **Step 5: Confirm the rules evaluate rather than error**

In Grafana, open the project folder's alert rules. Every rule must be `Normal` — not `Error`, and not `NoData` once the synthetic checks have run for a few minutes. `Error` means the PromQL is invalid against the real datasource; `NoData` after ten minutes means the queries match nothing, which is the exact failure this whole plan exists to remove.

---

### Task 17: Verify the SLI exists with no load test running

**Files:** none changed. Evidence goes in the task report.

**This is the success criterion.** Everything before it is machinery.

- [x] **Step 1: Run nothing. Wait.**

Do not start k6. Let the synthetic checks be the only traffic for at least 15 minutes.

- [x] **Step 2: Query the SLI**

```bash
set -a && source ../.env && set +a
Q='(sum(histogram_fraction(0, 0.05, rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps-ceiling", http_route!~"/healthz|/stats", class="fast"}[5m])) * histogram_count(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps-ceiling", http_route!~"/healthz|/stats", class="fast"}[5m]))))/sum(histogram_count(rate(http_server_request_duration_seconds{job="ecs-dynamodb-rps-ceiling", http_route!~"/healthz|/stats"}[5m])))'
curl -s -u "$K6_PROMETHEUS_RW_USERNAME:$K6_PROMETHEUS_RW_PASSWORD" \
  --data-urlencode "query=$Q" \
  "${K6_PROMETHEUS_RW_SERVER_URL%/api/prom/push}/api/prom/api/v1/query" | python3 -m json.tool
```

Expected: a numeric value, near `1`. **Paste the raw response into the task report** — `CLAUDE.md` forbids stating an SLO number without the query that produced it.

- [x] **Step 3: Confirm the error budget is accruing**

> **Verified 2026-08-31 from the SLO app's own recording rules**, not from the UI:
>
> ```
> grafana_slo_sli_1h                    0.99104
> grafana_slo_sli_1d                    0.79343
> grafana_slo_objective                 0.99
> grafana_slo_objective_window_seconds  604800
> ```
>
> The budget is being computed over a 7d window. The 1h figure is above objective; the **1d figure
> is not**, because it still contains the pre-fix period when scanner 404s counted as violations
> (see F19). That history does not heal — the recorded SLI keeps the old population. Read the 1d
> number as an artefact of the fix, not as a service regression, until 2026-09-01.

In Grafana's SLO app, the `ecs-dynamodb-rps-ceiling latency classes` SLO should show a budget over a 3-day window with data, not "no data". This is the thing that was impossible before: an SLI that exists when no test is running.

- [x] **Step 4: Prove a burn alert can actually fire**

> **Done via the provisioning API rather than the UI** — same thing, scriptable, and still not the
> generated file. Set the primary fast-burn threshold to `-1`, and the rule walked the full state
> machine, respecting its 70s `for`:
>
> ```
> 12:37:13Z pending -> 12:38:45Z pending -> 12:39:16Z FIRING
> ```
>
> Reverted with `terraform apply`, which detected exactly the one drifted resource and restored
> `params = [0.144]`.
>
> Gotcha: the provisioning API refuses `X-Disable-Provenance` on a Terraform-managed rule
> (`409 provenanceMismatch`, stored provenance `api`). Omit the header.

An alert that has never fired is not evidence of anything. Temporarily lower the fast-burn threshold in Grafana's UI — **not in the generated file** — until the rule fires, confirm it reaches `Alerting`, then revert. Record what you did.

- [x] **Step 5: Record the traffic-source split**

```bash
curl -s -u "$K6_PROMETHEUS_RW_USERNAME:$K6_PROMETHEUS_RW_PASSWORD" \
  --data-urlencode 'query=sum by (traffic_source, class) (histogram_count(rate(http_server_request_duration_seconds[15m])))' \
  "${K6_PROMETHEUS_RW_SERVER_URL%/api/prom/push}/api/prom/api/v1/query"
```

Expected: `synthetic` and `other`, no `k6` yet. This is the label that keeps spec §17.1 open — confirm it is populated **before** the first load test, because that decision cannot be made retroactively without it.

---

### Task 18: Update the record

**Files:**
- Modify: `docs/superpowers/plans/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection.md` (this file)
- Modify: `docs/superpowers/specs/2026-08-30-ecs-dynamodb-rps-ceiling-sli-collection-design.md`
- Modify: `docs/superpowers/plans/2026-08-29-ecs-dynamodb-rps-ceiling.md`
- Modify: `ecs-dynamodb-rps-ceiling/results.md`
- Modify: `ecs-dynamodb-rps-ceiling/README.md`

- [x] **Step 1: Close out the spec's unverified list**

Spec §14 lists nine items to prove rather than assume. Tasks 12 and 15 answered most of them. Convert each to a verified row with the observed evidence, or state plainly that it remains open and why. An unverified list that is never revisited is worse than none.

- [x] **Step 2: Extend the results schema (spec §17.3)**

`results.md` now needs two attainment columns, because two different numbers both legitimately answer "did it meet the SLO":

| column | source |
|---|---|
| `k6 attainment` | the run gate — client-side, includes Frankfurt RTT and ALB queueing |
| `service attainment` | the SLO — server-side, includes neither |

The old plan's Task 22 validates rows with an `awk` check on fixed column positions. Adding columns shifts those indices. **Update the check in the old plan's Task 22 text** — that is a description of a check, not an executed task number, so editing it does not renumber anything.

- [x] **Step 3: Update both status headers**

This plan → `complete`. The 2026-08-29 plan's status header → Tasks 18–23 are unblocked, naming this plan as what unblocked them, and recording the new `pbkdf2_iterations`.

- [x] **Step 4: Commit**

```bash
git add docs/ ecs-dynamodb-rps-ceiling/results.md ecs-dynamodb-rps-ceiling/README.md
git commit -m "docs(ecs-dynamodb-rps-ceiling): record the sli collection results"
```

- [x] **Step 5: Hand back**

The 2026-08-29 plan's **Task 18** resumes here, with a real SLO to report. Do not renumber it.

---

## What this plan does NOT do

- **No load test.** No k6 run, cloud or local. VU-hours are the binding budget (2026-08-29 spec §10) and the runs belong to the old plan's Tasks 18–21.
- **No DynamoDB capacity change.** It stays 25/25. Raising it to 1025/200 is the old plan's Task 18 and costs ~$0.32/hour.
- **No teardown.** `terraform destroy` is the old plan's Task 23. When it runs, its sweep must now also cover the collector service, its log group, and the Cloud Map namespace — a namespace refuses deletion while a service is registered, which surfaces as a `destroy` failure rather than a silent survivor.
