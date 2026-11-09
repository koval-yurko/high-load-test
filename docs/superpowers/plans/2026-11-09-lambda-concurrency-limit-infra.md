# lambda-concurrency-limit — Infrastructure, Observability and Scripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

- **Status:** **partially executed (on hold)** (2026-11-09) — executed subagent-driven, one commit
  for the whole plan (the user's instruction; no per-task commits). **Done:** Tasks 1–10, each
  reviewed (Tasks 1, 6, 7, 9 and 10 needed one fix round), and Task 11 steps 1–2 (the
  `platform/tfc.tf` line; `platform` plan: 2 to add, 0 to change, 0 to destroy). A final whole-branch
  review found 3 Important issues, all fixed and re-reviewed: the knob 2 rate (about 300 RPS) and
  the spike peak (about 80 RPS at most) are bounded by the 100-VU cap (rate × client latency ≤ VUs);
  the profiles now tag `rate_source`; this Status line. **Blocking the rest:** Task 11 step 3, the
  `platform/` apply, waits for the user's approval; steps 4–7 (init, the reviewed `infra/main`
  plan, the two refused plans) follow it.
  Deviations from the task text: `timeout_seconds` joined the `--config-only` list; `--check`
  also compares `Timeout` and `CodeSha256`; the burn alerts query `to = 300`.
- **Plan 2 of 3** (the spec's "Execution shape"). Plan 1
  (`docs/superpowers/plans/2026-11-09-lambda-concurrency-limit-service.md`, complete) built the code
  that runs in and against the Lambda. This plan builds everything that provisions, deploys and
  observes it, and ends at a reviewed `terraform plan`. **No `infra/main` apply.** The only apply is
  `platform/` (Task 11), which creates a Terraform Cloud workspace and nothing billable; it stops
  for approval. Plan 3 applies, seeds and measures, with no code changes.

**Goal:** `lambda-concurrency-limit/` gets its Terraform (Lambda, API Gateway, DynamoDB, CloudWatch,
Grafana, k6 project), its deploy and upload scripts, and its README and `loadtest.md`, so that
plan 3 needs only `dev.tfvars` edits, applies, script runs and k6 runs.

**Architecture:** One root module `infra/main` (AWS resources and a CloudWatch dashboard) calls two
child modules, `../grafana` (folder, dashboard, alert rules, all on CloudWatch metrics) and `../k6`
(the Grafana Cloud k6 project). Terraform creates the function with a placeholder zip and an alias
`live`, then ignores code and alias moves. `scripts/deploy-service.sh` publishes versions and moves
the alias. `slo.yaml` generates both the k6 thresholds (plan 1) and `infra/grafana/slo.json` (this
plan).

**Tech Stack:** Terraform 1.14 with `hashicorp/aws ~> 6.0`, `grafana/grafana ~> 3.0`,
`hashicorp/archive ~> 2.0`; HCP Terraform (remote execution); AWS CLI 2.23; k6 2.3.0; Node 22
(`node --test`); bash with the root `scripts/lib.sh` helpers.

**Spec:** `docs/superpowers/specs/2026-11-09-lambda-concurrency-limit-design.md`

## Findings made while writing this plan (2026-11-09)

Read-only checks made before writing. Task 1 writes each one into the spec at the decision it
changes.

1. **The region is `eu-central-1`, not `us-east-1`.** The root `.env` sets
   `AWS_REGION=eu-central-1` for every project. `aws lambda get-account-settings` on 2026-11-09:
   `eu-central-1` has `ConcurrentExecutions` 400 and `UnreservedConcurrentExecutions` 352 (the
   numbers the spec quotes); `us-east-1` has an account limit of **10**. The research reading was
   made in `eu-central-1` and labelled wrongly. Consequence: the k6 load zone must be Frankfurt
   (`amazon:de:frankfurt`), next to `eu-central-1`, not Ashburn. Plan 1's `lib/env.js` says Ashburn.
2. **Every k6 profile exceeds the 100-VU cap.** Grafana Cloud refuses an upload above 100 VUs
   (`E2004`, an organization limit; `.claude/skills/loadtest/SKILL.md`). `k6 inspect
   --execution-requirements` with no `-e` values: `discovery` 920, `noisy-neighbour` 400, `spike`
   400, `constant` 160. Two causes: `vus()` in `lib/arrivals.js` sets `maxVUs = 4 × max(10, rate)`,
   and sequential scenarios overlap by their `gracefulStop` (default 30 s), so k6 adds their VUs.
   Tested: `gracefulStop: '0s'` on the warm-up takes `constant` from 160 to 80.
3. **A configuration change does not reach the alias by itself.** The alias `live` points to a
   published version, and a version freezes its environment variables, memory and layers. So a
   `dev.tfvars` change to `otel_enabled`, `trace_sample_ratio`, `memory_size`,
   `heavy_cpu_iterations` or `sdk_max_attempts` needs a new version and an alias move. The spec says
   "`deploy-service.sh` is needed only when code changes", which is wrong. Fix: the function keeps
   `publish = true`, and `deploy-service.sh --config-only` moves the alias to the newest version (no
   build, no upload). This is a script run, not a code change, so plan 3 stays code-free.
4. **The Grafana SLO object needs Prometheus data, and this project has none.** `grafana_slo` takes
   only a Prometheus query. The function emits no service-side metrics; the SLI is k6 only (spec
   decision 5). So Grafana gets no SLO object. Its "SLO" row shows API Gateway `5XXError` (Average
   = the 5xx fraction) against the 1% budget and per-route `Latency` p95 against each class
   threshold. The burn alerts are availability-only, on `5XXError` Average. There is no
   server-side latency burn alert: no per-request latency data exists outside k6.
5. **Two dashboard rows cannot be built from CloudWatch.** Row 7 "per user" (k6 `user` tag): API
   Gateway publishes no per-API-key metric, so that view stays in the k6 app. Row 3's "predicted A
   as a reference line": `A` changes per run, so it goes in `results.md`, not on the dashboard.
6. **Settled:** both OTel layers exist in `eu-central-1` and list `arm64`
   (`aws lambda get-layer-version-by-arn`, 2026-11-09: `opentelemetry-nodejs-0_24_0:1` lists
   `nodejs22.x` and `arm64`; `opentelemetry-collector-arm64-0_24_0:1` lists `arm64`).
   `aws_cloudwatch_dashboard` has no `tags` argument (provider schema, `hashicorp/aws` 6.x), so the
   tag sweep cannot see the dashboard; `terraform destroy` deletes it, and the README's teardown
   checks it by name. The account limits are unchanged since 2026-11-08 (finding 1).
7. **Per-route latency needs method-level metrics.** API Gateway publishes `Latency` per resource
   only when the stage enables detailed metrics (`aws_api_gateway_method_settings`,
   `metrics_enabled = true`). They are billed as CloudWatch custom metrics: 3 methods × 7 metrics,
   prorated by the hour, cents per session. API Gateway access logs and execution logs stay off:
   both need the account-wide API Gateway CloudWatch role (`aws_api_gateway_account`), and the
   account is shared.

## Global Constraints

- Project directory `lambda-concurrency-limit/`; commits are
  `<type>(lambda-concurrency-limit[/terraform|/k6]): <subject>`, imperative, lowercase, ≤ 72
  characters, with the Claude attribution trailers. The `platform/tfc.tf` line is its own commit,
  `feat(platform): add lambda-concurrency-limit workspace`.
- Git is `/usr/bin/git`, one git command per Bash call (worktree hook quirk). Terraform and AWS
  commands that need credentials run through `direnv exec <repo root>`.
- **No `terraform apply` or `destroy` on `infra/main` in this plan.** Task 11's `platform/` apply is
  its own step and stops for approval. No project script runs `terraform apply`.
- Region `eu-central-1` for everything. AWS account limit 400, unreserved 352;
  `reserved_concurrency` is validated to 1–252 (352 − the 100 AWS keeps unreserved).
- Every AWS resource is tagged through `default_tags` only (`Project`, `ManagedBy`, `Workspace`),
  never per resource.
- Function name, table name, API name and log group all derive from `var.project`
  (`lambda-concurrency-limit`). Alias `live`, stage `dev`.
- Routes (REST v1 events, explicit resources, not `{proxy+}`): `GET /items/{pk}/{sk}` (fast),
  `GET /feeds/{pk}` (standard), `GET /reports/{pk}` (heavy). Handler setting
  `src/handler.handler`. `collector.yaml` at the zip root (`/var/task/collector.yaml`).
- Function environment: `TABLE_NAME`, `HEAVY_CPU_ITERATIONS`, `AWS_MAX_ATTEMPTS` (only when
  `sdk_max_attempts` is set), and with OTel on: `AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-handler`,
  `OPENTELEMETRY_COLLECTOR_CONFIG_URI=/var/task/collector.yaml`, `OTEL_SERVICE_NAME`,
  `OTEL_TRACES_SAMPLER=parentbased_traceidratio`, `OTEL_TRACES_SAMPLER_ARG`,
  `OTEL_METRICS_EXPORTER=none`, `OTEL_LOGS_EXPORTER=none`, `GRAFANA_OTLP_ENDPOINT`,
  `GRAFANA_OTLP_AUTH` (value `Basic <base64(username:password)>`).
- API keys: `normal-1` … `normal-4`, `noisy` share the usage plan `users` (throttle
  `user_rate_limit_rps`, burst 2 ×, none when 0); `load` has its own plan with no throttle.
- k6: every profile's `k6 inspect --execution-requirements` `maxVUs` ≤ 100, at default and at
  plan-3 rates. Load zone `amazon:de:frankfurt`.
- Every file forked from a sibling starts with
  `# Forked from <sibling>/<path> on 2026-11-09.` /
  `# A bug fixed here does not reach the sibling copy; fix both.` (`//` in JavaScript).
- HCL per-task check: `terraform fmt -check -recursive lambda-concurrency-limit/infra`, then
  `terraform -chdir=lambda-concurrency-limit/infra/main init -backend=false` and `validate`.
  The `PostToolUse` hook also formats and validates on every `.tf` edit.

## Review Focus

1. **A `dev.tfvars` change to a version-frozen setting, applied without a deploy.** Expected: the
   alias keeps running the old settings, and something says so. `deploy-service.sh --check`
   compares the alias's version with `$LATEST` (memory, environment, layers) and reports a
   difference; `--config-only` fixes it. The README's knob table names which knobs need it.
   Pinned in Task 7.
2. **`reserved_concurrency` above 252, or `provisioned_concurrency` above `reserved_concurrency`.**
   Expected: the plan fails on variable validation before any resource is touched. Pinned in
   Task 11 (two refused remote plans).
3. **Credentials or `AWS_REGION` for the wrong account or region.** Expected: the plan fails on a
   precondition, because the concurrency facts hold only for account `var.aws_account_id` in
   `eu-central-1`. Pinned in Task 3 (preconditions) and Task 11 (the reviewed plan shows them pass).
4. **A destroy and re-apply.** The API id, the URL and all six API key values change. Expected:
   `upload-k6.sh --check` reports an archive whose `BASE_URL` or `API_KEY_LOAD` is not the live one.
   Pinned in Task 8.
5. **A profile at plan-3 rates exceeds the 100-VU cap.** Expected: a unit test runs `k6 inspect
   --execution-requirements` on every profile at the highest rates plan 3 uses and fails above 100.
   Pinned in Task 1.

---

## File Structure

```
lambda-concurrency-limit/
  .terraformignore                upload root for remote runs: no service/, tests, *.md
  .gitignore                      + infra/main/placeholder.zip
  slo.yaml                        + availability burn block
  loadtest.md                     the project side of /loadtest
  results.md                      header only
  README.md                       written to the /readme structure
  infra/main/
    versions.tf                   cloud workspace, providers, default_tags, region/account data
    variables.tf                  every switch, with validations
    dev.tfvars                    the switch values
    dynamodb.tf                   the table
    lambda.tf                     log group, cold-start filter, IAM, function, alias, provisioned concurrency
    placeholder.js                the handler the first apply ships (returns 503)
    api.tf                        REST API, routes, stage, metrics, keys, usage plans
    dashboard.tf                  CloudWatch dashboard "Where the Lambda time goes"
    grafana.tf                    grafana provider, modules ../grafana and ../k6
    outputs.tf                    base_url, k6_project_id, names, api_keys, knobs, URLs
  infra/grafana/
    versions.tf variables.tf      forked
    slo.json                      GENERATED from slo.yaml
    folder.tf                     folder under high-load-test, local.slo
    dashboard.tf                  Grafana dashboard, CloudWatch panels
    alerts.tf                     5 alert rules (burn ×2, throttles, shared pool, DynamoDB, PC left on)
    outputs.tf                    dashboard_url
  infra/k6/
    main.tf variables.tf outputs.tf versions.tf   forked unchanged from ecs-rds-postgres-pool
  infra/k6/tests/lib/arrivals.js  vus(rate, cap) under the 100-VU cap
  infra/k6/tests/lib/env.js       Frankfurt
  infra/k6/tests/*.js             gracefulStop '0s'; per-scenario VU caps
  service/scripts/generate-slo.js + renderGrafana, writes infra/grafana/slo.json
  service/test/k6-vus.test.js     k6 inspect maxVUs ≤ 100
  scripts/deploy-service.sh       build → zip → upload → publish → alias → PC READY; --config-only, --check, --dry-run
  scripts/upload-k6.sh            forked; four profiles; keys and seed shape baked in
platform/tfc.tf                   + one workspace line
README.md (root), CLAUDE.md      project row, deployment and layout notes
```

---

### Task 1: Spec corrections, k6 load zone and the 100-VU cap

**Files:**
- Modify: `docs/superpowers/specs/2026-11-09-lambda-concurrency-limit-design.md`
- Modify: `docs/research/lambda-concurrency-limit.md` (the region label of the account reading)
- Modify: `lambda-concurrency-limit/infra/k6/tests/lib/env.js`
- Modify: `lambda-concurrency-limit/infra/k6/tests/lib/arrivals.js`
- Modify: `lambda-concurrency-limit/infra/k6/tests/{constant,discovery,spike,noisy-neighbour}.js`
- Modify: `lambda-concurrency-limit/service/test/k6-lib.test.js` (delete the old `vus` test)
- Test: `lambda-concurrency-limit/service/test/k6-vus.test.js`

**Interfaces:**
- Consumes: `CLASS_THRESHOLD_MS`, `MIX` from `infra/k6/tests/lib/slo.js` (generated, plan 1).
- Produces: `vus(targetRps, cap = VU_CAP) → { preAllocatedVUs: n, maxVUs: n }`, `VU_CAP = 100`,
  `MEAN_SECONDS` in `lib/arrivals.js`; `CLOUD` in `lib/env.js` now Frankfurt. Task 8 relies on
  the profile `-e` names: `RATE`, `START_RATE`, `MAX_RATE`, `STEP_RPS`, `STEP_SECONDS`,
  `PEAK_RATE`, `NORMAL_RATE`, `NOISY_RATE`.

- [ ] **Step 1: Write the failing test**

Create `lambda-concurrency-limit/service/test/k6-vus.test.js`:

```js
'use strict';
// Grafana Cloud k6 refuses an upload whose VU count passes 100 (E2004, an organization cap).
// k6 itself computes that count; this asks it, at default rates and at the highest rates plan 3
// uses (C = 100: about 404 RPS; discovery to 420; a 400 RPS spike; the noisy-neighbour defaults).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const TESTS = path.join(__dirname, '..', '..', 'infra', 'k6', 'tests');
const hasK6 = spawnSync('k6', ['version']).status === 0;

function maxVUs(profile, env = {}) {
  const args = ['inspect', '--execution-requirements'];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(path.join(TESTS, `${profile}.js`));
  const r = spawnSync('k6', args, { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).maxVUs;
}

const CASES = [
  ['constant', {}], ['constant', { RATE: 404 }],
  ['discovery', {}], ['discovery', { START_RATE: 20, STEP_RPS: 20, MAX_RATE: 420 }],
  ['spike', {}], ['spike', { PEAK_RATE: 400 }],
  ['noisy-neighbour', {}], ['noisy-neighbour', { NORMAL_RATE: 10, NOISY_RATE: 60 }],
];

for (const [profile, env] of CASES) {
  test(`${profile} ${JSON.stringify(env)} stays within 100 VUs`, { skip: !hasK6 && 'k6 not installed' }, () => {
    const n = maxVUs(profile, env);
    assert.ok(n <= 100, `${profile} needs ${n} VUs`);
  });
}

test('vus() follows Little\'s law and the cap', async () => {
  const { vus, VU_CAP, MEAN_SECONDS } = await import(path.join(TESTS, 'lib', 'arrivals.js'));
  assert.equal(VU_CAP, 100);
  assert.ok(Math.abs(MEAN_SECONDS - 0.36) < 1e-9, `MEAN_SECONDS ${MEAN_SECONDS}`); // 0.7×0.3 + 0.25×0.4 + 0.05×1.0
  assert.deepEqual(vus(55), { preAllocatedVUs: 40, maxVUs: 40 });   // ceil(2 × 55 × 0.36)
  assert.deepEqual(vus(1), { preAllocatedVUs: 5, maxVUs: 5 });      // floor of 5
  assert.deepEqual(vus(404), { preAllocatedVUs: 100, maxVUs: 100 });
  assert.deepEqual(vus(60, 52), { preAllocatedVUs: 44, maxVUs: 44 });   // ceil(43.2)
  assert.deepEqual(vus(400, 80), { preAllocatedVUs: 80, maxVUs: 80 });
});

test('the load zone is Frankfurt, next to eu-central-1', async () => {
  const { CLOUD } = await import(path.join(TESTS, 'lib', 'env.js'));
  assert.deepEqual(CLOUD, { distribution: { frankfurt: { loadZone: 'amazon:de:frankfurt', percent: 100 } } });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd lambda-concurrency-limit/service && node --test test/k6-vus.test.js`
Expected: FAIL — `constant {} … needs 160 VUs`, `discovery … needs 920 VUs`, `VU_CAP` undefined,
the load zone is `amazon:us:ashburn`.

- [ ] **Step 3: Change `lib/arrivals.js` `vus()`**

Replace the `vus` function and its comment with:

```js
import { CLASS_THRESHOLD_MS, MIX } from './slo.js';

// Grafana Cloud k6 refuses an upload above 100 VUs (E2004, an organization cap). k6 counts the
// VUs of every scenario that can run at the same time, so a profile with parallel scenarios
// splits the cap between them (the `cap` argument).
export const VU_CAP = 100;
// Little's law: busy VUs = sent rate × mean latency. The mean is the mix-weighted class threshold
// from slo.yaml, an upper bound for a run that meets its SLO; × 2 is room for random bunching.
// Skipped iterations (3 in 4) end at once and hold no VU.
export const MEAN_SECONDS = Object.keys(MIX).reduce((s, c) => s + MIX[c] * CLASS_THRESHOLD_MS[c], 0) / 1000;
// shortcut: at the cap, a run needs mean latency ≤ cap ÷ (2 × rate); past that, dropped_iterations
// fails the run (a gated threshold), so it can never pass at a lower rate.
export function vus(targetRps, cap = VU_CAP) {
  const n = Math.min(cap, Math.max(5, Math.ceil(2 * targetRps * MEAN_SECONDS)));
  return { preAllocatedVUs: n, maxVUs: n };
}
```

The `import` goes at the top of the file, above the existing comment block.

In `service/test/k6-lib.test.js`, delete the plan 1 test that pins the old sizing (it asserts
`vus(1)` = `{ preAllocatedVUs: 10, maxVUs: 40 }` and `vus(400).maxVUs >= 400`). The new file
`k6-vus.test.js` replaces it.

- [ ] **Step 4: Change `lib/env.js` to Frankfurt**

Replace the `CLOUD` export and its comment with:

```js
// Frankfurt is next to eu-central-1, where the function runs (the root .env's AWS_REGION), so the
// API Gateway overhead `o` is not an ocean crossing. Corrected 2026-11-09 from Ashburn: the spec
// had the region wrong.
export const CLOUD = {
  distribution: { frankfurt: { loadZone: 'amazon:de:frankfurt', percent: 100 } },
};
```

- [ ] **Step 5: Stop sequential scenarios from overlapping, and split the cap in parallel ones**

- `constant.js`: add `gracefulStop: '0s',` to the `warmup` scenario.
- `discovery.js`: add `gracefulStop: '0s',` to the `warmup` scenario; change the steps'
  `gracefulStop: '5s'` to `gracefulStop: '0s'`.
- `spike.js`: `base` uses `...vus(BASE, 20)`, `surge` uses `...vus(PEAK - BASE, 80)`.
- `noisy-neighbour.js`: the `user` helper takes the cap: `const user = (rate, cap) => ({ … ...vus(rate, cap) })`;
  `noisy: user(NOISY, 52)`, each `normal-N`: `user(NORMAL, 12)` (4 × 12 + 52 = 100).

Add one comment line above each change: `// 0s: k6 adds the VUs of scenarios whose graceful stop
overlaps the next one, and the cap is 100.` (sequential) or `// Parallel scenarios share the
100-VU cap.` (parallel). An iteration still running when its scenario ends is interrupted; it is at
most one request per VU, under 1 s.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd lambda-concurrency-limit/service && npm test`
Expected: PASS, all tests (plan 1's 40 plus the new ones). Then
`for f in ../infra/k6/tests/*.js; do k6 inspect "$f" >/dev/null || echo "BROKEN: $f"; done` prints
nothing.

- [ ] **Step 7: Correct the spec and the research document**

Edit the spec in place, each correction at the decision it changes, each marked
**Corrected 2026-11-09, during plan 2:** with the reason (the pattern plan 1 used in "Random
arrivals in k6"):

1. Status line: add "Corrected during plan 2 (2026-11-09): region, load zone, VU cap, alias
   versions, Grafana SLO rows — see the marked paragraphs."
2. "The shared account": `us-east-1` → `eu-central-1`; add that `us-east-1` has an account limit of
   10 (read 2026-11-09), and that the reading was re-checked 2026-11-09: still 400 / 352.
3. "Random arrivals in k6", the load zone paragraph: Frankfurt (`amazon:de:frankfurt`), and why.
4. "Profiles": a paragraph on the 100-VU cap and `vus(rate, cap)` (finding 2 above, with its
   numbers).
5. "What Terraform owns": the function keeps `publish = true`; a configuration change publishes a
   version, and `deploy-service.sh --config-only` moves the alias. "What the scripts own": add the
   `--config-only` and `--check` modes. "Configuration — every switch": replace
   "`deploy-service.sh` is needed only when code changes" with the list of knobs that need
   `--config-only` after the apply (`otel_enabled`, `trace_sample_ratio`, `otel_layer_version`,
   `memory_size`, `heavy_cpu_iterations`, `sdk_max_attempts`) and the ones that do not
   (`reserved_concurrency`, `provisioned_concurrency`, `user_rate_limit_rps`, every DynamoDB
   setting, `log_retention_days`).
6. "Observability and alerts", Grafana: row 2 is API Gateway `5XXError` Average against the 1%
   budget plus per-route `Latency` p95 against each class threshold; no `grafana_slo` object, and
   why (finding 4); row 3 has no predicted-A line; row 7 is in the k6 app, not Grafana (finding 5).
   The "SLO burn" alert row becomes "Availability burn (fast and slow), on API Gateway `5XXError`
   Average, factors from `slo.yaml`".
7. "Unverified": mark settled — "Node.js OTel layer on arm64" (finding 6), "CloudWatch dashboard
   tags through Terraform" (no `tags` argument; destroy deletes it, the sweep checks it by name),
   "Account limits unchanged" (re-read 2026-11-09). Add one row: "Alias-level Lambda metrics use
   `Resource = <function>:live` | plan 3, phase 0: the CloudWatch widget shows data".
8. "Architecture": add the method-level metrics and their cost, and that access logs stay off
   (finding 7).

In `docs/research/lambda-concurrency-limit.md`, at "What the account looks like today": change
"region `us-east-1`" to "region `eu-central-1`", and add one line: "Corrected 2026-11-09: the
reading was made in `eu-central-1`, the region every project here uses; `us-east-1` has an account
limit of 10."

- [ ] **Step 8: Commit**

```bash
/usr/bin/git add docs/superpowers/specs/2026-11-09-lambda-concurrency-limit-design.md docs/research/lambda-concurrency-limit.md lambda-concurrency-limit/infra/k6/tests lambda-concurrency-limit/service/test/k6-vus.test.js lambda-concurrency-limit/service/test/k6-lib.test.js
/usr/bin/git commit -m "fix(lambda-concurrency-limit/k6): fit profiles in 100 VUs, run from frankfurt"
```

(The pre-commit hook runs `k6 inspect` on every profile.)

---

### Task 2: `slo.yaml` generates the Grafana side

**Files:**
- Modify: `lambda-concurrency-limit/slo.yaml`
- Modify: `lambda-concurrency-limit/service/scripts/generate-slo.js`
- Create (generated): `lambda-concurrency-limit/infra/grafana/slo.json`
- Test: `lambda-concurrency-limit/service/test/generate-slo.test.js`

**Interfaces:**
- Consumes: `render`, `loadSlo`, `SLO_PATH`, `OUT_PATH` (plan 1).
- Produces: `renderGrafana(slo) → string` (JSON + newline), `GRAFANA_OUT_PATH`,
  `windowSeconds(text) → number`. `infra/grafana/slo.json` keys, read by Task 6:
  `availability_objective` (0.99), `latency_objective` (0.95), `class_threshold_ms`
  (`{fast, standard, heavy}`), `class_route` (`{fast: "/items/{pk}/{sk}", standard:
  "/feeds/{pk}", heavy: "/reports/{pk}"}`), `burn` (`{fast: {factor, window_seconds}, slow: {…}}`).

JSON, not generated HCL: the pre-commit hook runs `terraform fmt -check` on staged `.tf` files, and
generated HCL would have to reproduce `fmt`'s alignment exactly.

- [ ] **Step 1: Add the burn block to `slo.yaml`**

Under the `availability` entry, after `objective: 99.0`:

```yaml
    # Burn-rate alerts (infra/grafana/alerts.tf), on API Gateway 5XXError Average = the 5xx
    # fraction. Alert when the fraction passes factor × (1 − objective) over the window.
    # factor × (1 − objective) must stay below 1, or the alert can never fire.
    burn:
      fast: { factor: 14.4, window: 1h }
      slow: { factor: 6, window: 6h }
```

- [ ] **Step 2: Write the failing tests**

Append to `service/test/generate-slo.test.js` (it already imports `test`, `assert`, `loadSlo`,
`SLO_PATH`; add `renderGrafana`, `windowSeconds`, `GRAFANA_OUT_PATH` to its `require`):

```js
test('renderGrafana writes what the alert rules and panels read', () => {
  const g = JSON.parse(renderGrafana(loadSlo(SLO_PATH)));
  assert.equal(g.availability_objective, 0.99);
  assert.equal(g.latency_objective, 0.95);
  assert.deepEqual(g.class_threshold_ms, { fast: 300, standard: 400, heavy: 1000 });
  assert.deepEqual(g.class_route, { fast: '/items/{pk}/{sk}', standard: '/feeds/{pk}', heavy: '/reports/{pk}' });
  assert.deepEqual(g.burn, { fast: { factor: 14.4, window_seconds: 3600 }, slow: { factor: 6, window_seconds: 21600 } });
});

test('windowSeconds reads m and h, and refuses anything else', () => {
  assert.equal(windowSeconds('30m'), 1800);
  assert.equal(windowSeconds('6h'), 21600);
  assert.throws(() => windowSeconds('1d'), /window/);
});

test('a burn factor that can never fire is refused', () => {
  const slo = loadSlo(SLO_PATH);
  slo.slos.find((s) => s.name === 'availability').burn.fast.factor = 100; // 100 × 1% = 100%
  assert.throws(() => renderGrafana(slo), /can never fire/);
});

test('the committed slo.json is current', () => {
  const fs = require('node:fs');
  assert.equal(fs.readFileSync(GRAFANA_OUT_PATH, 'utf8'), renderGrafana(loadSlo(SLO_PATH)));
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd lambda-concurrency-limit/service && node --test test/generate-slo.test.js`
Expected: FAIL — `renderGrafana is not a function`.

- [ ] **Step 4: Implement**

In `generate-slo.js`: change the header comment to "this writes the k6 side and the Grafana side";
add after `OUT_PATH`:

```js
const GRAFANA_OUT_PATH = path.join(ROOT, 'infra', 'grafana', 'slo.json');

function windowSeconds(text) {
  const m = /^(\d+)([mh])$/.exec(String(text));
  if (!m) throw new Error(`slo.yaml: burn window must look like 30m or 6h, got ${JSON.stringify(text)}`);
  return Number(m[1]) * (m[2] === 'h' ? 3600 : 60);
}

function renderGrafana(slo) {
  const lat = slo.slos.find((s) => s.name === 'latency-classes');
  const avail = slo.slos.find((s) => s.name === 'availability');
  const budget = 1 - avail.objective / 100;
  const burn = {};
  for (const [k, b] of Object.entries(avail.burn)) {
    if (!(b.factor * budget < 1)) throw new Error(`slo.yaml: burn ${k} factor ${b.factor} × budget ${budget} ≥ 1, so the alert can never fire`);
    burn[k] = { factor: b.factor, window_seconds: windowSeconds(b.window) };
  }
  const out = {
    availability_objective: avail.objective / 100,
    latency_objective: lat.objective / 100,
    class_threshold_ms: Object.fromEntries(CLASSES.map((c) => [c, lat.classes[c].threshold_ms])),
    // "GET /items/{pk}/{sk}" -> "/items/{pk}/{sk}", the API Gateway Resource dimension.
    class_route: Object.fromEntries(CLASSES.map((c) => [c, lat.classes[c].route.split(' ')[1]])),
    burn,
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}
```

Change the `require.main` block so both files are written and both are checked:

```js
if (require.main === module) {
  const slo = loadSlo(SLO_PATH);
  const outputs = [[OUT_PATH, render(slo)], [GRAFANA_OUT_PATH, renderGrafana(slo)]];
  if (process.argv.includes('--check')) {
    let stale = false;
    for (const [p, out] of outputs) {
      const current = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
      if (current !== out) { console.error(`${p} is stale: run npm run slo:generate`); stale = true; }
    }
    if (stale) process.exit(1);
  } else {
    for (const [p, out] of outputs) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, out);
      console.log(`wrote ${p}`);
    }
  }
}

module.exports = { render, renderGrafana, windowSeconds, loadSlo, SLO_PATH, OUT_PATH, GRAFANA_OUT_PATH };
```

- [ ] **Step 5: Generate and run the tests**

Run: `cd lambda-concurrency-limit/service && npm run slo:generate && npm test && npm run slo:check`
Expected: `wrote …/slo.js`, `wrote …/infra/grafana/slo.json`; all tests PASS; `slo:check` exits 0.
`git diff ../infra/k6/tests/lib/slo.js` is empty (the k6 side did not change).

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add lambda-concurrency-limit/slo.yaml lambda-concurrency-limit/service/scripts/generate-slo.js lambda-concurrency-limit/service/test/generate-slo.test.js lambda-concurrency-limit/infra/grafana/slo.json
/usr/bin/git commit -m "feat(lambda-concurrency-limit): generate grafana slo values from slo.yaml"
```

---

### Task 3: Root module skeleton and the DynamoDB table

**Files:**
- Create: `lambda-concurrency-limit/.terraformignore`
- Modify: `lambda-concurrency-limit/.gitignore`
- Create: `lambda-concurrency-limit/infra/main/versions.tf`
- Create: `lambda-concurrency-limit/infra/main/variables.tf`
- Create: `lambda-concurrency-limit/infra/main/dev.tfvars`
- Create: `lambda-concurrency-limit/infra/main/dynamodb.tf`

**Interfaces:**
- Produces: every `var.*` below; `aws_dynamodb_table.items` (`.name`, `.arn`);
  `data.aws_region.current.region`; `data.aws_caller_identity.current.account_id`.

- [ ] **Step 1: `.terraformignore` and `.gitignore`**

`lambda-concurrency-limit/.terraformignore`:

```
# Forked from ecs-dynamodb-rps/.terraformignore on 2026-11-09.
# A bug fixed here does not reach the sibling copy; fix both.
# Upload root for HCP CLI-driven runs is this directory, because the workspace's working directory
# is infra/main. That is what makes ../grafana and ../k6 resolve in a remote run. Nothing below is
# needed by a plan.
service/
scripts/
infra/k6/tests/
*.md
infra/main/.terraform/
infra/main/tfplan*
infra/main/placeholder.zip
```

Append to `lambda-concurrency-limit/.gitignore`:

```
# built by archive_file at plan time (infra/main/lambda.tf)
infra/main/placeholder.zip
```

- [ ] **Step 2: `versions.tf`**

```hcl
# Forked from ecs-rds-postgres-pool/infra/main/versions.tf on 2026-11-09.
# A bug fixed here does not reach the sibling copy; fix both.
#
# The workspace is named here, never in the shell. It runs in REMOTE execution mode with working
# directory infra/main, both set by platform/tfc.tf: the upload root is then
# lambda-concurrency-limit/, so ../grafana and ../k6 resolve inside the run. The sibling's copy of
# this file explains the failure when they do not.
terraform {
  required_version = "~> 1.14.0"

  cloud {
    workspaces {
      name = "lambda-concurrency-limit"
    }
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    grafana = {
      source  = "grafana/grafana"
      version = "~> 3.0"
    }
    # Zips placeholder.js at plan time, so the first apply needs no build step.
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}

# Region comes from AWS_REGION (the shared variable set; eu-central-1). The preconditions on
# aws_dynamodb_table.items refuse any other region or account.
provider "aws" {
  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
      Workspace = var.project
    }
  }
}

data "aws_region" "current" {}

data "aws_caller_identity" "current" {}
```

- [ ] **Step 3: `variables.tf`**

```hcl
variable "project" {
  description = "Project name. Also the AWS Project tag, the function, table and API name, and the commit scope. Do not change."
  type        = string
  default     = "lambda-concurrency-limit"
}

variable "aws_account_id" {
  description = "The AWS account this project belongs to. From the high-load-test variable set; no default, so a workspace without it fails loudly."
  type        = string
}

variable "expected_region" {
  description = "The only region where the concurrency facts in the spec hold: account limit 400, unreserved 352 (read 2026-11-09). us-east-1 has a limit of 10."
  type        = string
  default     = "eu-central-1"
}

# --- Knobs (spec, "Configuration — every switch") ---------------------------------------------

variable "reserved_concurrency" {
  description = "Knob 2. The function ALWAYS reserves concurrency, so a load test never drains the shared unreserved pool (352; other apps use it). AWS keeps 100 unreserved, so the ceiling is 252. Takes effect at apply; no deploy needed."
  type        = number
  default     = 20
  validation {
    condition     = var.reserved_concurrency >= 1 && var.reserved_concurrency <= 252 && floor(var.reserved_concurrency) == var.reserved_concurrency
    error_message = "reserved_concurrency must be a whole number in 1..252 (352 unreserved minus the 100 AWS keeps). Re-read aws lambda get-account-settings if other apps reserved more."
  }
}

variable "provisioned_concurrency" {
  description = "Knob 3. Provisioned concurrency on alias live; 0 = no resource. Billed per hour while it exists. Takes effect at apply."
  type        = number
  default     = 0
  validation {
    condition     = var.provisioned_concurrency >= 0 && var.provisioned_concurrency <= var.reserved_concurrency && floor(var.provisioned_concurrency) == var.provisioned_concurrency
    error_message = "provisioned_concurrency must be a whole number in 0..reserved_concurrency."
  }
}

variable "user_rate_limit_rps" {
  description = "Knob 1. Per-API-key throttle on the users usage plan (normal-1..4, noisy). 0 = no throttle. Burst is 2 x rate (spec: random arrivals need it). Takes effect at apply."
  type        = number
  default     = 0
  validation {
    condition     = var.user_rate_limit_rps >= 0 && floor(var.user_rate_limit_rps) == var.user_rate_limit_rps
    error_message = "user_rate_limit_rps must be a whole number >= 0."
  }
}

variable "otel_enabled" {
  description = "OTel layers and wrapper on or off. Frozen into the published version: run deploy-service.sh --config-only after the apply."
  type        = bool
  default     = true
}

variable "trace_sample_ratio" {
  description = "OTEL_TRACES_SAMPLER_ARG. Frozen into the published version: deploy-service.sh --config-only after the apply."
  type        = number
  default     = 1
  validation {
    condition     = var.trace_sample_ratio >= 0 && var.trace_sample_ratio <= 1
    error_message = "trace_sample_ratio must be in 0..1."
  }
}

variable "otel_layer_version" {
  description = "Upstream open-telemetry/opentelemetry-lambda release, in the layer-name form (0_24_0). Frozen into the published version."
  type        = string
  default     = "0_24_0"
}

variable "memory_size" {
  description = "MB. Lambda gives CPU in proportion to memory, so this moves Duration. Frozen into the published version."
  type        = number
  default     = 512
  validation {
    condition     = var.memory_size >= 128 && var.memory_size <= 10240
    error_message = "memory_size must be in 128..10240."
  }
}

variable "heavy_cpu_iterations" {
  description = "CPU loop iterations on the heavy route (iterations, not ms, so memory changes show). Set in phase 0. Frozen into the published version."
  type        = number
  default     = 0
}

variable "sdk_max_attempts" {
  description = "AWS_MAX_ATTEMPTS for the bundled SDK (3.1164.0: default 3, standard mode). null = unset, the SDK default. Exploration only. Frozen into the published version."
  type        = number
  default     = null
}

variable "timeout_seconds" {
  description = "Function timeout. Below API Gateway's 29 s integration timeout."
  type        = number
  default     = 10
}

variable "billing_mode" {
  description = "DynamoDB. PAY_PER_REQUEST for every comparison run; PROVISIONED is exploration. Provisioned -> on-demand at most 4 times in a rolling 24 h."
  type        = string
  default     = "PAY_PER_REQUEST"
  validation {
    condition     = contains(["PAY_PER_REQUEST", "PROVISIONED"], var.billing_mode)
    error_message = "billing_mode must be PAY_PER_REQUEST or PROVISIONED."
  }
}

variable "read_capacity" {
  description = "RCU when billing_mode = PROVISIONED (ignored otherwise). Decreases: 4 available, +1 per hour, 27 per day, so step upward."
  type        = number
  default     = 100
}

variable "write_capacity" {
  description = "WCU when billing_mode = PROVISIONED (ignored otherwise). The load writes nothing; the seed runs on-demand."
  type        = number
  default     = 5
}

variable "max_read_request_units" {
  description = "On-demand maximum read throughput (on_demand_throughput). null = no maximum. Exploration only."
  type        = number
  default     = null
}

variable "log_retention_days" {
  type    = number
  default = 7
}

# --- Grafana and OTLP (values from the shared variable set) ----------------------------------

variable "grafana_otlp_endpoint" {
  description = "Grafana Cloud OTLP gateway URL, e.g. https://otlp-gateway-<zone>.grafana.net/otlp. The collector's otlphttp exporter appends /v1/traces."
  type        = string
}

variable "grafana_otlp_username" {
  description = "Grafana Cloud OTLP instance ID."
  type        = string
}

variable "grafana_otlp_password" {
  description = "Grafana Cloud access policy token with traces:write. Reaches the function as GRAFANA_OTLP_AUTH (spec: accepted for a lab)."
  type        = string
  sensitive   = true
}

variable "cloudwatch_datasource_uid" {
  description = "Existing Grafana CloudWatch datasource, verified for this AWS account on 2026-08-30 (the siblings use it). Its default region is us-east-1, so every query pins eu-central-1."
  type        = string
  default     = "a4139e7c-dc84-47c8-b90b-d710ec0fe3fb"
}
```

- [ ] **Step 4: `dev.tfvars`**

```hcl
# The switch values (spec, "Configuration — every switch"). Nothing secret here.
#
# After an apply that changes otel_enabled, trace_sample_ratio, otel_layer_version, memory_size,
# heavy_cpu_iterations or sdk_max_attempts, run ./scripts/deploy-service.sh --config-only: those
# settings are frozen into each published version, and alias live keeps the old one until moved.

# Knobs, in measurement order (README, "The knob sequence").
reserved_concurrency    = 20 # knob 2: 20 -> 100
user_rate_limit_rps     = 0  # knob 1: 0 -> L from capacity.js
provisioned_concurrency = 0  # knob 3: 0 -> N; billed per hour, set back to 0 right after phase 4

# Phase 0 settles these.
otel_enabled         = true
trace_sample_ratio   = 1
memory_size          = 512
heavy_cpu_iterations = 0

# DynamoDB: on-demand for every comparison. PROVISIONED rows are exploration only.
billing_mode = "PAY_PER_REQUEST"
```

- [ ] **Step 5: `dynamodb.tf`**

```hcl
# Key schema pk/sk is what service/scripts/seed.js writes and service/src/dynamo.js reads.
resource "aws_dynamodb_table" "items" {
  name           = var.project
  billing_mode   = var.billing_mode
  read_capacity  = var.billing_mode == "PROVISIONED" ? var.read_capacity : null
  write_capacity = var.billing_mode == "PROVISIONED" ? var.write_capacity : null
  hash_key       = "pk"
  range_key      = "sk"

  # A lab table, destroyed every session.
  deletion_protection_enabled = false

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  # Warm throughput is NOT a switch on purpose: raising it is charged and cannot be lowered.
  dynamic "on_demand_throughput" {
    for_each = var.billing_mode == "PAY_PER_REQUEST" && var.max_read_request_units != null ? [1] : []
    content {
      max_read_request_units = var.max_read_request_units
    }
  }

  lifecycle {
    # Every other resource depends on this table or on the function, so a wrong account or region
    # fails here, at plan, before anything is proposed.
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.aws_account_id
      error_message = "These credentials are for account ${data.aws_caller_identity.current.account_id}, not ${var.aws_account_id}."
    }
    precondition {
      condition     = data.aws_region.current.region == var.expected_region
      error_message = "Region is ${data.aws_region.current.region}; the concurrency limits this project is sized for exist in ${var.expected_region} only."
    }
  }
}
```

- [ ] **Step 6: Verify**

Run:
```bash
terraform fmt -check -recursive lambda-concurrency-limit/infra
terraform -chdir=lambda-concurrency-limit/infra/main init -backend=false
terraform -chdir=lambda-concurrency-limit/infra/main validate
```
Expected: `fmt` prints nothing; `validate` prints `Success! The configuration is valid.` (A warning
that `aws_account_id` and the OTLP variables have no value is fine; `validate` does not need them.)
If `data.aws_region.current.region` is refused, the provider is older than 6.0 — check
`.terraform.lock.hcl`, do not switch to the deprecated `.name`.

- [ ] **Step 7: Commit**

```bash
/usr/bin/git add lambda-concurrency-limit/.terraformignore lambda-concurrency-limit/.gitignore lambda-concurrency-limit/infra/main/versions.tf lambda-concurrency-limit/infra/main/variables.tf lambda-concurrency-limit/infra/main/dev.tfvars lambda-concurrency-limit/infra/main/dynamodb.tf lambda-concurrency-limit/infra/main/.terraform.lock.hcl
/usr/bin/git commit -m "feat(lambda-concurrency-limit/terraform): add root module and dynamodb table"
```

---

### Task 4: The function, its alias, logs and concurrency

**Files:**
- Create: `lambda-concurrency-limit/infra/main/placeholder.js`
- Create: `lambda-concurrency-limit/infra/main/lambda.tf`

**Interfaces:**
- Consumes: Task 3 variables, `aws_dynamodb_table.items`.
- Produces: `aws_lambda_function.app` (`.function_name`), `aws_lambda_alias.live` (`.name`,
  `.invoke_arn`), `aws_cloudwatch_log_group.app`, custom metric `ColdStarts` in namespace
  `var.project`, `local.otel_layers`.

- [ ] **Step 1: `placeholder.js`**

```js
// What the first apply ships, so Terraform can create the function before any build exists.
// scripts/deploy-service.sh replaces it; Terraform then ignores the code (lambda.tf).
exports.handler = async () => ({
  statusCode: 503,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ error: 'not deployed: run scripts/deploy-service.sh' }),
});
```

- [ ] **Step 2: `lambda.tf`**

```hcl
# Terraform owns the function's INFRASTRUCTURE; scripts/deploy-service.sh owns its CODE and moves
# the alias (spec decision 13). So the code and the alias target are ignored below.
#
# publish = true: every configuration change Terraform makes publishes a new version, because a
# version freezes environment, memory and layers. Alias live does not follow it by itself:
# deploy-service.sh --config-only moves it. Published versions are deleted with the function.

data "archive_file" "placeholder" {
  type        = "zip"
  output_path = "${path.module}/placeholder.zip"

  source {
    content  = file("${path.module}/placeholder.js")
    filename = "src/handler.js" # matches handler = "src/handler.handler"
  }
}

# Declared before the function, so Lambda never creates it untagged with no retention.
resource "aws_cloudwatch_log_group" "app" {
  name              = "/aws/lambda/${var.project}"
  retention_in_days = var.log_retention_days
}

# A cold start appears only as "Init Duration" on the REPORT line; there is no Init metric.
# Provisioned environments initialise before any request, so their REPORT lines carry none.
resource "aws_cloudwatch_log_metric_filter" "cold_starts" {
  name           = "${var.project}-cold-starts"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "\"REPORT RequestId\" \"Init Duration\""

  metric_transformation {
    name      = "ColdStarts"
    namespace = var.project
    value     = "1"
    unit      = "Count"
  }
}

data "aws_iam_policy_document" "assume_lambda" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = var.project
  assume_role_policy = data.aws_iam_policy_document.assume_lambda.json
}

data "aws_iam_policy_document" "app" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.app.arn}:*"]
  }
  # Reads only: the load is GET-only, and the seed runs from the laptop with its own credentials.
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.items.arn]
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "app"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}

locals {
  layer_prefix = "arn:aws:lambda:${data.aws_region.current.region}:184161586896:layer"
  # Upstream open-telemetry/opentelemetry-lambda; both checked in eu-central-1 on 2026-11-09.
  otel_layers = [
    "${local.layer_prefix}:opentelemetry-nodejs-${var.otel_layer_version}:1",
    "${local.layer_prefix}:opentelemetry-collector-arm64-${var.otel_layer_version}:1",
  ]

  otel_env = {
    AWS_LAMBDA_EXEC_WRAPPER            = "/opt/otel-handler"
    OPENTELEMETRY_COLLECTOR_CONFIG_URI = "/var/task/collector.yaml"
    OTEL_SERVICE_NAME                  = var.project
    OTEL_TRACES_SAMPLER                = "parentbased_traceidratio"
    OTEL_TRACES_SAMPLER_ARG            = tostring(var.trace_sample_ratio)
    # collector.yaml has a traces pipeline only.
    OTEL_METRICS_EXPORTER = "none"
    OTEL_LOGS_EXPORTER    = "none"
    # Read by collector.yaml as ${env:...}.
    GRAFANA_OTLP_ENDPOINT = var.grafana_otlp_endpoint
    GRAFANA_OTLP_AUTH     = "Basic ${base64encode("${var.grafana_otlp_username}:${var.grafana_otlp_password}")}"
  }

  app_env = merge(
    {
      TABLE_NAME           = aws_dynamodb_table.items.name
      HEAVY_CPU_ITERATIONS = tostring(var.heavy_cpu_iterations)
    },
    var.sdk_max_attempts == null ? {} : { AWS_MAX_ATTEMPTS = tostring(var.sdk_max_attempts) },
    var.otel_enabled ? local.otel_env : {},
  )
}

resource "aws_lambda_function" "app" {
  function_name = var.project
  role          = aws_iam_role.app.arn
  runtime       = "nodejs22.x"
  architectures = ["arm64"]
  handler       = "src/handler.handler"
  memory_size   = var.memory_size
  timeout       = var.timeout_seconds
  publish       = true

  # Always set: a function without reserved concurrency draws from the shared pool.
  reserved_concurrent_executions = var.reserved_concurrency

  filename         = data.archive_file.placeholder.output_path
  source_code_hash = data.archive_file.placeholder.output_base64sha256

  layers = var.otel_enabled ? local.otel_layers : []

  environment {
    variables = local.app_env
  }

  depends_on = [aws_cloudwatch_log_group.app, aws_iam_role_policy.app]

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

resource "aws_lambda_alias" "live" {
  name             = "live"
  function_name    = aws_lambda_function.app.function_name
  function_version = aws_lambda_function.app.version

  lifecycle {
    ignore_changes = [function_version] # deploy-service.sh moves it
  }
}

# Knob 3. Allocation takes 1-2 minutes; the provider waits for READY. Billed per hour while it exists.
resource "aws_lambda_provisioned_concurrency_config" "live" {
  count = var.provisioned_concurrency > 0 ? 1 : 0

  function_name                     = aws_lambda_function.app.function_name
  qualifier                         = aws_lambda_alias.live.name
  provisioned_concurrent_executions = var.provisioned_concurrency
}
```

`merge()` with `{}` from a conditional: the two branches are `{}` and an object; if `validate`
refuses "Inconsistent conditional result types", wrap both branches in `tomap(...)`. All values are
strings, so `tomap` is safe.

- [ ] **Step 3: Verify**

Run the three commands from Task 3, Step 6. Expected: no `fmt` output; `Success!`.
Then `ls lambda-concurrency-limit/infra/main/placeholder.zip` exists only if a plan ran; `validate`
alone does not create it. `git status --short` must not list it.

- [ ] **Step 4: Commit**

```bash
/usr/bin/git add lambda-concurrency-limit/infra/main/placeholder.js lambda-concurrency-limit/infra/main/lambda.tf
/usr/bin/git commit -m "feat(lambda-concurrency-limit/terraform): add function, alias and concurrency"
```

---

### Task 5: API Gateway — routes, stage, metrics, keys and usage plans

**Files:**
- Create: `lambda-concurrency-limit/infra/main/api.tf`

**Interfaces:**
- Consumes: `aws_lambda_function.app`, `aws_lambda_alias.live`, `var.user_rate_limit_rps`.
- Produces: `aws_api_gateway_rest_api.app` (`.name`), `aws_api_gateway_stage.dev` (`.invoke_url`,
  `.stage_name`), `aws_api_gateway_api_key.user` (map keyed `normal-1`…`normal-4`, `noisy`,
  `load`; `.value`).

- [ ] **Step 1: `api.tf`**

```hcl
# REST API (v1) on purpose: per-client throttling through usage plans exists only on REST APIs
# (spec decision 1). Explicit resources, not {proxy+}: the handler routes on event.resource.

locals {
  users = ["normal-1", "normal-2", "normal-3", "normal-4", "noisy"]
}

resource "aws_api_gateway_rest_api" "app" {
  name           = var.project
  api_key_source = "HEADER" # x-api-key, sent by infra/k6/tests/lib/request.js

  endpoint_configuration {
    types = ["REGIONAL"]
  }
}

resource "aws_api_gateway_resource" "items" {
  rest_api_id = aws_api_gateway_rest_api.app.id
  parent_id   = aws_api_gateway_rest_api.app.root_resource_id
  path_part   = "items"
}

resource "aws_api_gateway_resource" "items_pk" {
  rest_api_id = aws_api_gateway_rest_api.app.id
  parent_id   = aws_api_gateway_resource.items.id
  path_part   = "{pk}"
}

resource "aws_api_gateway_resource" "items_sk" {
  rest_api_id = aws_api_gateway_rest_api.app.id
  parent_id   = aws_api_gateway_resource.items_pk.id
  path_part   = "{sk}"
}

resource "aws_api_gateway_resource" "feeds" {
  rest_api_id = aws_api_gateway_rest_api.app.id
  parent_id   = aws_api_gateway_rest_api.app.root_resource_id
  path_part   = "feeds"
}

resource "aws_api_gateway_resource" "feeds_pk" {
  rest_api_id = aws_api_gateway_rest_api.app.id
  parent_id   = aws_api_gateway_resource.feeds.id
  path_part   = "{pk}"
}

resource "aws_api_gateway_resource" "reports" {
  rest_api_id = aws_api_gateway_rest_api.app.id
  parent_id   = aws_api_gateway_rest_api.app.root_resource_id
  path_part   = "reports"
}

resource "aws_api_gateway_resource" "reports_pk" {
  rest_api_id = aws_api_gateway_rest_api.app.id
  parent_id   = aws_api_gateway_resource.reports.id
  path_part   = "{pk}"
}

locals {
  # class -> the leaf resource of its route (slo.yaml)
  routes = {
    fast     = aws_api_gateway_resource.items_sk.id
    standard = aws_api_gateway_resource.feeds_pk.id
    heavy    = aws_api_gateway_resource.reports_pk.id
  }
}

resource "aws_api_gateway_method" "get" {
  for_each = local.routes

  rest_api_id      = aws_api_gateway_rest_api.app.id
  resource_id      = each.value
  http_method      = "GET"
  authorization    = "NONE"
  api_key_required = true # identifies the test user; AWS: not authentication
}

resource "aws_api_gateway_integration" "get" {
  for_each = local.routes

  rest_api_id             = aws_api_gateway_rest_api.app.id
  resource_id             = each.value
  http_method             = aws_api_gateway_method.get[each.key].http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  # The alias, never $LATEST: deploy-service.sh moves live, and provisioned concurrency sits on it.
  uri = aws_lambda_alias.live.invoke_arn
}

resource "aws_lambda_permission" "api" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.app.function_name
  qualifier     = aws_lambda_alias.live.name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.app.execution_arn}/*/GET/*"
}

resource "aws_api_gateway_deployment" "app" {
  rest_api_id = aws_api_gateway_rest_api.app.id

  # A REST API serves a snapshot; a route change needs a new deployment.
  triggers = {
    redeployment = sha1(jsonencode([
      local.routes,
      [for m in aws_api_gateway_method.get : m.id],
      [for i in aws_api_gateway_integration.get : i.id],
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_api_gateway_stage" "dev" {
  rest_api_id   = aws_api_gateway_rest_api.app.id
  deployment_id = aws_api_gateway_deployment.app.id
  stage_name    = "dev"
}

# Per-method CloudWatch metrics, so Latency is visible per route (the Grafana SLO row). Billed as
# custom metrics, cents per session. Logging stays off: it needs the account-wide API Gateway
# CloudWatch role, and the account is shared with other apps.
resource "aws_api_gateway_method_settings" "all" {
  rest_api_id = aws_api_gateway_rest_api.app.id
  stage_name  = aws_api_gateway_stage.dev.stage_name
  method_path = "*/*"

  settings {
    metrics_enabled = true
  }
}

resource "aws_api_gateway_api_key" "user" {
  for_each = toset(concat(local.users, ["load"]))

  name = "${var.project}-${each.key}"
}

# Knob 1. AWS: usage plan throttling is best-effort, not a hard limit; the knob 1 run measures how
# far it leaks. Throttle is per API key.
resource "aws_api_gateway_usage_plan" "users" {
  name = "${var.project}-users"

  api_stages {
    api_id = aws_api_gateway_rest_api.app.id
    stage  = aws_api_gateway_stage.dev.stage_name
  }

  dynamic "throttle_settings" {
    for_each = var.user_rate_limit_rps > 0 ? [1] : []
    content {
      rate_limit  = var.user_rate_limit_rps
      burst_limit = 2 * var.user_rate_limit_rps # random arrivals bunch (spec, the knob 1 simulation)
    }
  }
}

# The load user drives discovery, constant and spike. Never throttled: those profiles measure the
# function's concurrency, not the usage plan.
resource "aws_api_gateway_usage_plan" "load" {
  name = "${var.project}-load"

  api_stages {
    api_id = aws_api_gateway_rest_api.app.id
    stage  = aws_api_gateway_stage.dev.stage_name
  }
}

resource "aws_api_gateway_usage_plan_key" "user" {
  for_each = toset(local.users)

  key_id        = aws_api_gateway_api_key.user[each.key].id
  key_type      = "API_KEY"
  usage_plan_id = aws_api_gateway_usage_plan.users.id
}

resource "aws_api_gateway_usage_plan_key" "load" {
  key_id        = aws_api_gateway_api_key.user["load"].id
  key_type      = "API_KEY"
  usage_plan_id = aws_api_gateway_usage_plan.load.id
}
```

- [ ] **Step 2: Verify** — the three commands from Task 3, Step 6. Expected: clean, `Success!`.

- [ ] **Step 3: Commit**

```bash
/usr/bin/git add lambda-concurrency-limit/infra/main/api.tf
/usr/bin/git commit -m "feat(lambda-concurrency-limit/terraform): add rest api, api keys and usage plans"
```

---

### Task 6: Observability — Grafana and k6 modules, CloudWatch dashboard, outputs

**Files:**
- Create: `lambda-concurrency-limit/infra/k6/{main,variables,outputs,versions}.tf` (forked)
- Create: `lambda-concurrency-limit/infra/grafana/{versions,variables,folder,dashboard,alerts,outputs}.tf`
- Create: `lambda-concurrency-limit/infra/main/{grafana,dashboard,outputs}.tf`

**Interfaces:**
- Consumes: `infra/grafana/slo.json` (Task 2); `aws_api_gateway_rest_api.app.name`,
  `aws_api_gateway_stage.dev` (Task 5); `aws_lambda_function.app`, `aws_lambda_alias.live`
  (Task 4); `aws_dynamodb_table.items` (Task 3).
- Produces: root outputs `base_url`, `k6_project_id`, `function_name`, `alias_name`,
  `table_name`, `api_keys` (sensitive map), `knobs` (map; `provisioned_concurrency` is read by
  Task 7), `cloudwatch_dashboard_url`, `grafana_dashboard_url`.

- [ ] **Step 1: Fork the k6 module unchanged**

```bash
for f in main variables outputs versions; do
  { printf '# Forked from ecs-rds-postgres-pool/infra/k6/%s.tf on 2026-11-09.\n# A bug fixed here does not reach the sibling copy; fix both.\n' "$f"
    grep -v '^# Forked from\|^# A bug fixed here' ecs-rds-postgres-pool/infra/k6/$f.tf; } > lambda-concurrency-limit/infra/k6/$f.tf
done
```

The limits stay exactly as in the sibling (an unset attribute resets the live value; the sibling's
comment explains). Do not change `vu_max_per_test`: the 100-VU cap is an organization limit, not
this object.

- [ ] **Step 2: Grafana module `versions.tf` and `variables.tf`**

`versions.tf`: copy `ecs-rds-postgres-pool/infra/grafana/versions.tf` with the fork header.

`variables.tf`:

```hcl
variable "project" {
  type = string
}

variable "cloudwatch_datasource_uid" {
  description = "Existing CloudWatch datasource. Its default region is us-east-1, so every query pins eu-central-1."
  type        = string
}

variable "function_name" {
  type = string
}

variable "alias_name" {
  type = string
}

variable "api_name" {
  type = string
}

variable "stage_name" {
  type = string
}

variable "table_name" {
  type = string
}

variable "reserved_concurrency" {
  description = "Drawn as the ceiling line on the concurrency panel."
  type        = number
}

variable "provisioned_concurrency" {
  description = "The 'left on' rule exists only while this is > 0."
  type        = number
}

variable "unreserved_alert" {
  description = "Account UnreservedConcurrentExecutions above this fires. 50% of the 352 unreserved (read 2026-11-09): the other apps in the account run from that pool, and this project's function always has reserved concurrency, so it should never fire."
  type        = number
  default     = 176
}

variable "alert_contact_point" {
  description = "Name of the EXISTING Grafana contact point. Not managed here; a typo fails at apply."
  type        = string
  default     = "Slack - Kovalchuk & Co"
}
```

- [ ] **Step 3: `folder.tf`**

```hcl
# Forked from ecs-rds-postgres-pool/infra/grafana/folder.tf on 2026-11-09 (the folder part).
# A bug fixed here does not reach the sibling copy; fix both.
# The parent folder is owned by platform/ and found by its fixed title, never by reading its state.
data "grafana_folder" "root" {
  title = "high-load-test"
}

resource "grafana_folder" "project" {
  title             = var.project
  parent_folder_uid = data.grafana_folder.root.uid
}

locals {
  # GENERATED from slo.yaml (npm run slo:generate): objectives, class thresholds, routes, burn.
  slo    = jsondecode(file("${path.module}/slo.json"))
  region = "eu-central-1"
}
```

- [ ] **Step 4: `dashboard.tf` (Grafana)**

```hcl
# Every panel reads CloudWatch: the function emits no service-side metrics, and the SLI is k6 only
# (spec decision 5). The k6 app holds the per-user view (API Gateway has no per-key metric).
locals {
  api   = { ApiName = var.api_name, Stage = var.stage_name }
  fn    = { FunctionName = var.function_name }
  alias = { FunctionName = var.function_name, Resource = "${var.function_name}:${var.alias_name}" }
  table = { TableName = var.table_name }

  method = { for c, r in local.slo.class_route : c => merge(local.api, { Method = "GET", Resource = r }) }

  panels = concat(
    [
      { title = "1 · Requests", unit = "short", threshold = null, targets = [
        { ns = "AWS/ApiGateway", metric = "Count", stat = "Sum", dims = local.api },
      ] },
      { title = "1 · 4xx (incl. per-user 429) and 5xx (incl. Lambda throttles)", unit = "short", threshold = null, targets = [
        { ns = "AWS/ApiGateway", metric = "4XXError", stat = "Sum", dims = local.api },
        { ns = "AWS/ApiGateway", metric = "5XXError", stat = "Sum", dims = local.api },
      ] },
      { title = "1 · Latency vs IntegrationLatency p95 (difference = overhead o)", unit = "ms", threshold = null, targets = [
        { ns = "AWS/ApiGateway", metric = "Latency", stat = "p95", dims = local.api },
        { ns = "AWS/ApiGateway", metric = "IntegrationLatency", stat = "p95", dims = local.api },
      ] },
      { title = "2 · 5xx fraction vs the availability budget", unit = "percentunit", threshold = 1 - local.slo.availability_objective, targets = [
        { ns = "AWS/ApiGateway", metric = "5XXError", stat = "Average", dims = local.api },
      ] },
    ],
    [for c in ["fast", "standard", "heavy"] : {
      title = "2 · ${c} ${local.slo.class_route[c]} p95 vs threshold", unit = "ms", threshold = local.slo.class_threshold_ms[c], targets = [
        { ns = "AWS/ApiGateway", metric = "Latency", stat = "p95", dims = local.method[c] },
      ]
    }],
    [
      { title = "3 · ConcurrentExecutions vs reserved", unit = "short", threshold = var.reserved_concurrency, targets = [
        { ns = "AWS/Lambda", metric = "ConcurrentExecutions", stat = "Maximum", dims = local.fn },
      ] },
      { title = "3 · Throttles (not in Invocations or Errors)", unit = "short", threshold = null, targets = [
        { ns = "AWS/Lambda", metric = "Throttles", stat = "Sum", dims = local.fn },
      ] },
      { title = "3 · Account UnreservedConcurrentExecutions (shared pool)", unit = "short", threshold = var.unreserved_alert, targets = [
        { ns = "AWS/Lambda", metric = "UnreservedConcurrentExecutions", stat = "Maximum", dims = {} },
      ] },
      { title = "4 · Duration and OTel export (avg, p99)", unit = "ms", threshold = null, targets = [
        { ns = "AWS/Lambda", metric = "Duration", stat = "Average", dims = local.alias },
        { ns = "AWS/Lambda", metric = "Duration", stat = "p99", dims = local.alias },
        { ns = "AWS/Lambda", metric = "PostRuntimeExtensionsDuration", stat = "Average", dims = local.alias },
        { ns = "AWS/Lambda", metric = "PostRuntimeExtensionsDuration", stat = "p99", dims = local.alias },
      ] },
      { title = "4 · Cold starts (REPORT lines with Init Duration)", unit = "short", threshold = null, targets = [
        { ns = var.project, metric = "ColdStarts", stat = "Sum", dims = {} },
      ] },
      { title = "5 · Provisioned concurrency", unit = "short", threshold = null, targets = [
        { ns = "AWS/Lambda", metric = "ProvisionedConcurrencyUtilization", stat = "Maximum", dims = local.alias },
        { ns = "AWS/Lambda", metric = "ProvisionedConcurrencySpilloverInvocations", stat = "Sum", dims = local.alias },
      ] },
      { title = "6 · DynamoDB read capacity (Sum per minute)", unit = "short", threshold = null, targets = [
        { ns = "AWS/DynamoDB", metric = "ConsumedReadCapacityUnits", stat = "Sum", dims = local.table },
        { ns = "AWS/DynamoDB", metric = "ProvisionedReadCapacityUnits", stat = "Average", dims = local.table },
      ] },
      { title = "6 · DynamoDB ReadThrottleEvents", unit = "short", threshold = null, targets = [
        { ns = "AWS/DynamoDB", metric = "ReadThrottleEvents", stat = "Sum", dims = local.table },
      ] },
      { title = "6 · DynamoDB SuccessfulRequestLatency", unit = "ms", threshold = null, targets = [
        { ns = "AWS/DynamoDB", metric = "SuccessfulRequestLatency", stat = "Average", dims = merge(local.table, { Operation = "GetItem" }) },
        { ns = "AWS/DynamoDB", metric = "SuccessfulRequestLatency", stat = "Average", dims = merge(local.table, { Operation = "Query" }) },
      ] },
    ],
  )

  datasource = { type = "cloudwatch", uid = var.cloudwatch_datasource_uid }

  dashboard_panels = [for i, p in local.panels : {
    id         = i + 1
    type       = "timeseries"
    title      = p.title
    datasource = local.datasource
    gridPos    = { h = 8, w = 8, x = (i % 3) * 8, y = floor(i / 3) * 8 }
    fieldConfig = {
      defaults = {
        unit   = p.unit
        custom = { thresholdsStyle = { mode = p.threshold == null ? "off" : "line" } }
        thresholds = {
          mode  = "absolute"
          steps = concat([{ color = "green", value = null }], p.threshold == null ? [] : [{ color = "red", value = p.threshold }])
        }
      }
      overrides = []
    }
    targets = [for j, t in p.targets : {
      refId            = substr("ABCDEFGH", j, 1)
      datasource       = local.datasource
      region           = local.region
      namespace        = t.ns
      metricName       = t.metric
      statistic        = t.stat
      dimensions       = t.dims
      matchExact       = true
      period           = "60"
      label            = "${t.metric} ${t.stat}"
      queryMode        = "Metrics"
      metricQueryType  = 0
      metricEditorMode = 0
    }]
  }]
}

resource "grafana_dashboard" "main" {
  folder = grafana_folder.project.uid
  config_json = jsonencode({
    uid           = var.project
    title         = var.project
    timezone      = "utc"
    refresh       = "1m"
    schemaVersion = 39
    time          = { from = "now-1h", to = "now" }
    panels        = local.dashboard_panels
  })
}
```

If `validate` refuses a type in `local.panels` (objects with different `dims` keys in one list),
build each `dims` with `tomap(...)` — all values are strings.

- [ ] **Step 5: `alerts.tf`**

```hcl
# Structure forked from ecs-rds-postgres-pool/infra/grafana/saturation.tf on 2026-11-09.
# A bug fixed here does not reach the sibling copy; fix both.
#
# One rule per metric, never math across two queries: CloudWatch publishes sparsely, and $A + $B
# goes NO DATA when one side is empty. no_data_state = "OK": no datapoint means no load.
# A -> reduce -> threshold, because Grafana will not threshold a time series directly.
#
# Availability burn: API Gateway 5XXError Average IS the 5xx fraction (each request is 0 or 1), so
# one metric gives the burn. There is no latency burn rule: no per-request latency exists outside
# k6, which is the only SLI (spec decision 5).
locals {
  budget = 1 - local.slo.availability_objective

  burn_rules = [for k, b in local.slo.burn : {
    name      = "Availability ${k} burn"
    ns        = "AWS/ApiGateway"
    metric    = "5XXError"
    dims      = { ApiName = var.api_name, Stage = var.stage_name }
    stat      = "Average"
    period    = tostring(b.window_seconds)
    from      = b.window_seconds + 300
    to        = 0
    reducer   = "last"
    threshold = b.factor * local.budget
    for       = k == "fast" ? "2m" : "15m"
    summary   = "The 5xx fraction over ${b.window_seconds / 3600} h is above ${b.factor} x the ${format("%.1f", local.budget * 100)}% budget. A Lambda throttle reaches the client as 500, so read the Throttles panel first."
  }]

  base_rules = [
    {
      name = "Lambda throttles", ns = "AWS/Lambda", metric = "Throttles", dims = { FunctionName = var.function_name }
      stat = "Sum", period = "60", from = 300, to = 0, reducer = "last", threshold = 0, for = "2m"
      summary = "Throttles > 0: the function hit its reserved concurrency. Expected in knob runs past the Erlang B rate; anywhere else it is a finding."
    },
    {
      name = "Shared pool in danger", ns = "AWS/Lambda", metric = "UnreservedConcurrentExecutions", dims = {}
      stat = "Maximum", period = "60", from = 300, to = 0, reducer = "last", threshold = var.unreserved_alert, for = "2m"
      summary = "The account's unreserved concurrency in use is above ${var.unreserved_alert} of 352. Other apps run from that pool. This function always reserves its own, so this should never fire: stop the load test and check reserved_concurrency."
    },
    {
      name = "DynamoDB read throttles", ns = "AWS/DynamoDB", metric = "ReadThrottleEvents", dims = { TableName = var.table_name }
      stat = "Sum", period = "60", from = 300, to = 0, reducer = "last", threshold = 0, for = "2m"
      summary = "The table throttled reads: the database binds, not concurrency, so a knob run made now is invalid. SDK retries first show as longer Duration."
    },
  ]

  # Data 2 h ago AND the knob still set = provisioned concurrency has been billed for 2 h.
  pc_rules = var.provisioned_concurrency > 0 ? [{
    name = "Provisioned concurrency left on", ns = "AWS/Lambda", metric = "ProvisionedConcurrencyUtilization"
    dims = { FunctionName = var.function_name, Resource = "${var.function_name}:${var.alias_name}" }
    stat = "Maximum", period = "60", from = 7500, to = 7200, reducer = "count", threshold = 0, for = "0s"
    summary = "Provisioned concurrency has existed for over 2 hours and is billed per hour. Set provisioned_concurrency = 0 in dev.tfvars and apply."
  }] : []

  rules = concat(local.burn_rules, local.base_rules, local.pc_rules)
}

resource "grafana_rule_group" "main" {
  name             = "${var.project} / concurrency and capacity"
  folder_uid       = grafana_folder.project.uid
  interval_seconds = 60

  dynamic "rule" {
    for_each = local.rules
    content {
      name      = rule.value.name
      condition = "C"
      for       = rule.value.for

      data {
        ref_id         = "A"
        datasource_uid = var.cloudwatch_datasource_uid
        relative_time_range {
          from = rule.value.from
          to   = rule.value.to
        }
        model = jsonencode({
          refId            = "A"
          region           = local.region
          namespace        = rule.value.ns
          metricName       = rule.value.metric
          statistic        = rule.value.stat
          period           = rule.value.period
          dimensions       = rule.value.dims
          metricQueryType  = 0
          metricEditorMode = 0
          matchExact       = true
        })
      }

      data {
        ref_id         = "B"
        datasource_uid = "__expr__"
        query_type     = "reduce"
        relative_time_range {
          from = rule.value.from
          to   = rule.value.to
        }
        model = jsonencode({ refId = "B", type = "reduce", reducer = rule.value.reducer, expression = "A" })
      }

      data {
        ref_id         = "C"
        datasource_uid = "__expr__"
        query_type     = "threshold"
        relative_time_range {
          from = rule.value.from
          to   = rule.value.to
        }
        model = jsonencode({
          refId      = "C"
          type       = "threshold"
          expression = "B"
          conditions = [{ evaluator = { type = "gt", params = [rule.value.threshold] } }]
        })
      }

      no_data_state  = "OK"
      exec_err_state = "Error"

      notification_settings {
        contact_point = var.alert_contact_point
        group_by      = ["alertname"]
      }

      annotations = {
        summary          = rule.value.summary
        __dashboardUid__ = grafana_dashboard.main.uid
      }
      labels = {
        severity = "ticket"
        project  = var.project
      }
    }
  }
}
```

If `validate` refuses `concat` of tuples whose `dims` differ in keys, apply `tomap()` to each
`dims`, as in Step 4.

`outputs.tf` (grafana module):

```hcl
output "dashboard_url" {
  value = grafana_dashboard.main.url
}
```

- [ ] **Step 6: Root `grafana.tf`, `dashboard.tf`, `outputs.tf`**

`infra/main/grafana.tf`:

```hcl
# Forked from ecs-rds-postgres-pool/infra/main/grafana.tf on 2026-11-09.
# A bug fixed here does not reach the sibling copy; fix both.
# Auth comes from GRAFANA_URL / GRAFANA_AUTH and the k6 token in the workspace's variable set.
provider "grafana" {}

module "grafana" {
  source = "../grafana"

  project                   = var.project
  cloudwatch_datasource_uid = var.cloudwatch_datasource_uid
  function_name             = aws_lambda_function.app.function_name
  alias_name                = aws_lambda_alias.live.name
  api_name                  = aws_api_gateway_rest_api.app.name
  stage_name                = aws_api_gateway_stage.dev.stage_name
  table_name                = aws_dynamodb_table.items.name
  reserved_concurrency      = var.reserved_concurrency
  provisioned_concurrency   = var.provisioned_concurrency
}

# Creates this project's k6 project, so /env down destroys it with its uploaded tests and run
# history. Re-upload after every /env up: ./scripts/upload-k6.sh
module "k6" {
  source = "../k6"

  project = var.project
}
```

`infra/main/dashboard.tf`:

```hcl
# The AWS-side view (spec, "CloudWatch dashboard"): where the Lambda time goes. Not tagged: the
# resource has no tags argument (hashicorp/aws 6.x), so the tag sweep cannot see it; destroy
# deletes it, and the README's teardown checks it by name.
locals {
  region = data.aws_region.current.region
  fn     = aws_lambda_function.app.function_name
  alias  = "${aws_lambda_function.app.function_name}:${aws_lambda_alias.live.name}"
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = var.project
  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 12, height = 8
        properties = {
          title  = "Where the Lambda time goes (avg, alias live)"
          region = local.region
          period = 60
          view   = "timeSeries"
          metrics = [
            ["AWS/Lambda", "Duration", "FunctionName", local.fn, "Resource", local.alias, { id = "d", stat = "Average", label = "Duration" }],
            [".", "PostRuntimeExtensionsDuration", ".", ".", ".", ".", { id = "x", stat = "Average", label = "OTel export (after the response)" }],
            [{ id = "code", expression = "d - x", label = "code's own time" }],
            [{ id = "pct", expression = "100 * x / d", label = "export % of Duration", yAxis = "right" }],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 0, width = 12, height = 8
        properties = {
          title  = "Where the Lambda time goes (p99, alias live)"
          region = local.region
          period = 60
          view   = "timeSeries"
          metrics = [
            ["AWS/Lambda", "Duration", "FunctionName", local.fn, "Resource", local.alias, { stat = "p99", label = "Duration p99" }],
            [".", "PostRuntimeExtensionsDuration", ".", ".", ".", ".", { stat = "p99", label = "OTel export p99" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 8, width = 8, height = 6
        properties = {
          title  = "Concurrency and throttles"
          region = local.region
          period = 60
          view   = "timeSeries"
          metrics = [
            ["AWS/Lambda", "ConcurrentExecutions", "FunctionName", local.fn, { stat = "Maximum" }],
            [".", "Throttles", ".", ".", { stat = "Sum" }],
          ]
          annotations = { horizontal = [{ label = "reserved", value = var.reserved_concurrency }] }
        }
      },
      {
        type = "metric", x = 8, y = 8, width = 8, height = 6
        properties = {
          title   = "Account unreserved concurrency in use (limit 352)"
          region  = local.region
          period  = 60
          view    = "timeSeries"
          metrics = [["AWS/Lambda", "UnreservedConcurrentExecutions", { stat = "Maximum" }]]
        }
      },
      {
        type = "metric", x = 16, y = 8, width = 8, height = 6
        properties = {
          title  = "DynamoDB reads"
          region = local.region
          period = 60
          view   = "timeSeries"
          metrics = [
            ["AWS/DynamoDB", "ConsumedReadCapacityUnits", "TableName", aws_dynamodb_table.items.name, { stat = "Sum" }],
            [".", "ReadThrottleEvents", ".", ".", { stat = "Sum" }],
          ]
        }
      },
    ]
  })
}
```

`infra/main/outputs.tf`:

```hcl
output "base_url" {
  description = "Target for k6: https://<id>.execute-api.eu-central-1.amazonaws.com/dev. New on every rebuild; read it with terraform output -json at the moment of use."
  value       = aws_api_gateway_stage.dev.invoke_url
}

output "k6_project_id" {
  description = "Grafana Cloud k6 project id. New after every /env down + /env up: read with terraform output -json, never copy."
  value       = module.k6.k6_project_id
}

output "function_name" {
  value = aws_lambda_function.app.function_name
}

output "alias_name" {
  value = aws_lambda_alias.live.name
}

output "table_name" {
  value = aws_dynamodb_table.items.name
}

output "api_keys" {
  description = "user -> API key value. Read by scripts/upload-k6.sh. Identifies a test user only; not authentication."
  value       = { for k, v in aws_api_gateway_api_key.user : k => v.value }
  sensitive   = true
}

output "knobs" {
  description = "Recorded in results.md next to every run. deploy-service.sh reads provisioned_concurrency."
  value = {
    reserved_concurrency    = var.reserved_concurrency
    provisioned_concurrency = var.provisioned_concurrency
    user_rate_limit_rps     = var.user_rate_limit_rps
    otel_enabled            = var.otel_enabled
    trace_sample_ratio      = var.trace_sample_ratio
    memory_size             = var.memory_size
    heavy_cpu_iterations    = var.heavy_cpu_iterations
    sdk_max_attempts        = var.sdk_max_attempts
    billing_mode            = var.billing_mode
    read_capacity           = var.billing_mode == "PROVISIONED" ? var.read_capacity : null
    max_read_request_units  = var.max_read_request_units
  }
}

output "cloudwatch_dashboard_url" {
  value = "https://${data.aws_region.current.region}.console.aws.amazon.com/cloudwatch/home?region=${data.aws_region.current.region}#dashboards/dashboard/${aws_cloudwatch_dashboard.main.dashboard_name}"
}

output "grafana_dashboard_url" {
  value = module.grafana.dashboard_url
}
```

- [ ] **Step 7: Verify**

The three commands from Task 3, Step 6 (re-run `init -backend=false`: there are two new modules).
Expected: clean `fmt`, `Success!`. Then:
`grep -rn 'Project *=' lambda-concurrency-limit/infra --include='*.tf'` lists only
`infra/main/versions.tf` (`default_tags`).

- [ ] **Step 8: Commit**

```bash
/usr/bin/git add lambda-concurrency-limit/infra/k6/main.tf lambda-concurrency-limit/infra/k6/variables.tf lambda-concurrency-limit/infra/k6/outputs.tf lambda-concurrency-limit/infra/k6/versions.tf lambda-concurrency-limit/infra/grafana lambda-concurrency-limit/infra/main/grafana.tf lambda-concurrency-limit/infra/main/dashboard.tf lambda-concurrency-limit/infra/main/outputs.tf
/usr/bin/git commit -m "feat(lambda-concurrency-limit/terraform): add dashboards, alerts and outputs"
```

---

### Task 7: `scripts/deploy-service.sh`

**Files:**
- Create: `lambda-concurrency-limit/scripts/deploy-service.sh` (executable)

**Interfaces:**
- Consumes: root outputs `function_name`, `alias_name`, `knobs.provisioned_concurrency`;
  `service/` (`src/`, `collector.yaml`, `package.json`, `package-lock.json`).
- Produces: modes `(default)` build and deploy code; `--config-only` publish and move the alias
  without a build; `--check` compare alias `live` with `$LATEST`; `--dry-run` build and inspect the
  zip only, no AWS call. The zip at `service/dist/function.zip`.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# deploy-service.sh [--config-only | --check | --dry-run]
#
# Ships this project's code to an ALREADY-APPLIED environment and moves alias live:
#     test -> build (production node_modules) -> zip -> update-function-code -> wait
#     -> publish-version -> update-alias live -> wait for provisioned concurrency READY (if on)
#
#     ./scripts/deploy-service.sh                 # code changed
#     ./scripts/deploy-service.sh --config-only   # dev.tfvars changed a version-frozen setting
#     ./scripts/deploy-service.sh --check         # does live run what $LATEST has?
#     ./scripts/deploy-service.sh --dry-run       # build and inspect the zip; no AWS call
#
# WHY --config-only EXISTS. A published version freezes environment variables, memory and layers.
# Terraform publishes a new version on every configuration change (publish = true), but alias live
# keeps pointing at the old one. So after an apply that changes otel_enabled, trace_sample_ratio,
# otel_layer_version, memory_size, heavy_cpu_iterations or sdk_max_attempts, run --config-only.
# publish-version returns the newest version when nothing changed, so a needless run is harmless.
#
# WHY node_modules IS BUNDLED. The SDK built into the Lambda runtime is a different version; the
# measured retry behaviour (AWS_MAX_ATTEMPTS, default 3, standard mode) is true for the bundled
# @aws-sdk/client-dynamodb 3.1164.0 only.
#
# It never runs terraform apply (CLAUDE.md: an apply inside a script never reaches the approval
# gate). Provision first: terraform -chdir=infra/main apply -var-file=dev.tfvars

. "$(dirname "${BASH_SOURCE[0]}")/../../scripts/lib.sh"

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PROJECT=$(basename "$PROJECT_DIR")
SERVICE="$PROJECT_DIR/service"
DIST="$SERVICE/dist"
ZIP="$DIST/function.zip"

MODE=code
for arg in "$@"; do
  case "$arg" in
    --config-only) MODE=config ;;
    --check)       MODE=check ;;
    --dry-run)     MODE=dry ;;
    *) die "unknown flag '$arg' (usage: ./scripts/deploy-service.sh [--config-only|--check|--dry-run])" ;;
  esac
done

d() { direnv exec "$REPO_ROOT" "$@"; }

header "deploy" "$PROJECT" "mode: $MODE"

step "Checking prerequisites"
for t in jq zip unzip npm; do have "$t" || require_step "$t is not installed" "brew install $t"; done
if [ "$MODE" != dry ]; then
  have aws || require_step "aws is not installed" "brew install awscli"
  have direnv || require_step "direnv is not installed" "brew install direnv"
fi
ok "tools present"

# --- build (code and dry-run) ------------------------------------------------
build() {
  step "Testing"
  (cd "$SERVICE" && npm test >/dev/null) || die "npm test failed in service/ — not deploying broken code"
  ok "npm test passed"

  step "Building $ZIP"
  rm -rf "$DIST"
  local stage="$DIST/stage"
  mkdir -p "$stage"
  cp -R "$SERVICE/src" "$SERVICE/collector.yaml" "$SERVICE/package.json" "$SERVICE/package-lock.json" "$stage/"
  (cd "$stage" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
  (cd "$stage" && zip -qr "$ZIP" src collector.yaml package.json node_modules)
  rm -rf "$stage"

  # The three things a broken bundle gets wrong, checked on the zip itself.
  local listing
  listing=$(unzip -Z1 "$ZIP")
  grep -qx 'collector.yaml' <<<"$listing" || die "collector.yaml is not at the zip root (/var/task/collector.yaml)"
  grep -qx 'src/handler.js' <<<"$listing" || die "src/handler.js is missing (handler = src/handler.handler)"
  grep -q '^node_modules/@aws-sdk/client-dynamodb/' <<<"$listing" || die "the DynamoDB SDK is not bundled"
  ! grep -q '^node_modules/aws-sdk-client-mock/' <<<"$listing" || die "dev dependencies leaked into the zip"
  ok "zip $(du -h "$ZIP" | cut -f1): collector.yaml at root, src/handler.js, bundled SDK, no dev deps"
}

if [ "$MODE" = dry ]; then
  build
  handoff "deploy (--dry-run)" "$ZIP — nothing uploaded" "./scripts/deploy-service.sh"
  exit 0
fi

# --- names from Terraform (output -json, never -raw: against empty state -raw prints a warning to stdout)
step "Reading terraform outputs"
OUT=$(d terraform -chdir="$PROJECT_DIR/infra/main" output -json 2>/dev/null || true)
FN=$(jq -r '.function_name.value // empty' <<<"$OUT")
ALIAS=$(jq -r '.alias_name.value // empty' <<<"$OUT")
PC=$(jq -r '.knobs.value.provisioned_concurrency // 0' <<<"$OUT")
[ -n "$FN" ] && [ -n "$ALIAS" ] || blocked "deploy" \
  "infra/main has no function_name output — the environment is not applied" \
  "terraform -chdir=infra/main apply -var-file=dev.tfvars   # approval gate" \
  "./scripts/deploy-service.sh"
ok "function $FN, alias $ALIAS, provisioned concurrency $PC"

# --- check -------------------------------------------------------------------
settings() { # [qualifier] -> normalised memory, environment, layers
  d aws lambda get-function-configuration --function-name "$FN" ${1:+--qualifier "$1"} --output json 2>/dev/null \
    | jq -S '{memory: .MemorySize, env: (.Environment.Variables // {}), layers: ([.Layers[]?.Arn] | sort)}'
}

if [ "$MODE" = check ]; then
  step "Comparing alias $ALIAS with \$LATEST"
  LIVE_V=$(d aws lambda get-alias --function-name "$FN" --name "$ALIAS" --query FunctionVersion --output text 2>/dev/null)
  if diff <(settings "$ALIAS") <(settings) >/dev/null; then
    ok "alias $ALIAS (version $LIVE_V) runs the settings Terraform last applied"
  else
    warn "alias $ALIAS (version $LIVE_V) runs OLDER settings than \$LATEST:"
    diff <(settings "$ALIAS" | jq 'del(.env.GRAFANA_OTLP_AUTH)') <(settings | jq 'del(.env.GRAFANA_OTLP_AUTH)') | sed 's/^/    /' || true
    note "fix: ./scripts/deploy-service.sh --config-only"
  fi
  exit 0
fi

# --- deploy ------------------------------------------------------------------
if [ "$MODE" = code ]; then
  build
  step "Uploading code"
  d aws lambda update-function-code --function-name "$FN" --zip-file "fileb://$ZIP" >/dev/null
  ok "uploaded"
fi

step "Waiting for the function update to finish"
d aws lambda wait function-updated-v2 --function-name "$FN"
ok "LastUpdateStatus Successful"

step "Publishing a version and moving alias $ALIAS"
VERSION=$(d aws lambda publish-version --function-name "$FN" --query Version --output text)
d aws lambda update-alias --function-name "$FN" --name "$ALIAS" --function-version "$VERSION" >/dev/null
ok "alias $ALIAS -> version $VERSION"

# None of the provisioned environments is usable until all are allocated (1-2 minutes).
if [ "$PC" -gt 0 ]; then
  step "Waiting for provisioned concurrency ($PC) to be READY on the new version"
  status=NONE
  for _ in $(seq 1 60); do
    status=$(d aws lambda get-provisioned-concurrency-config --function-name "$FN" --qualifier "$ALIAS" --query Status --output text 2>/dev/null || echo NONE)
    case "$status" in
      READY) break ;;
      FAILED) die "provisioned concurrency FAILED: aws lambda get-provisioned-concurrency-config --function-name $FN --qualifier $ALIAS" ;;
    esac
    sleep 10
  done
  [ "$status" = READY ] || die "provisioned concurrency not READY after 10 minutes (status $status)"
  ok "READY"
fi

handoff "deploy" "alias $ALIAS -> version $VERSION of $FN" \
  "./scripts/deploy-service.sh --check   # or seed, then ./scripts/upload-k6.sh" \
  "every k6 run hits the alias, never \$LATEST"
```

- [ ] **Step 2: Verify locally (no AWS)**

Run:
```bash
chmod +x lambda-concurrency-limit/scripts/deploy-service.sh
bash -n lambda-concurrency-limit/scripts/deploy-service.sh
command -v shellcheck >/dev/null && shellcheck -x lambda-concurrency-limit/scripts/deploy-service.sh
lambda-concurrency-limit/scripts/deploy-service.sh --dry-run
lambda-concurrency-limit/scripts/deploy-service.sh --bogus; echo "exit $?"
```
Expected: `bash -n` silent; shellcheck (if installed) has no errors; `--dry-run` ends with
`deploy (--dry-run) complete` and the four zip checks pass; `--bogus` prints `unknown flag` and
`exit 1`. `git status --short` does not list `service/dist/` (ignored since plan 1).

- [ ] **Step 3: Commit**

```bash
/usr/bin/git add lambda-concurrency-limit/scripts/deploy-service.sh
/usr/bin/git commit -m "feat(lambda-concurrency-limit): add deploy script that publishes and moves alias"
```

---

### Task 8: `scripts/upload-k6.sh`

**Files:**
- Create: `lambda-concurrency-limit/scripts/upload-k6.sh` (forked from
  `ecs-rds-postgres-pool/scripts/upload-k6.sh`, executable)

**Interfaces:**
- Consumes: root outputs `base_url`, `k6_project_id`, `api_keys`; `service/seed-manifest.json`
  (`.params.feeds`, `.itemsPerFeed`, `.reports`, `.itemsPerReport`); the profile `-e` names from
  Task 1.
- Produces: flags `--rate N` (constant `RATE`), `--start-rate`, `--max-rate`, `--step-rps`,
  `--step-seconds` (discovery), `--peak-rate` (spike `PEAK_RATE`), `--normal-rate`,
  `--noisy-rate` (noisy-neighbour), `--only <profile>`, `--check`, `--dry-run`, `--run`,
  `--base-url`.

- [ ] **Step 1: Copy and re-head**

```bash
cp ecs-rds-postgres-pool/scripts/upload-k6.sh lambda-concurrency-limit/scripts/upload-k6.sh
chmod +x lambda-concurrency-limit/scripts/upload-k6.sh
```

Replace line 2 (`# Forked from ecs-dynamodb-rps/…`) with
`# Forked from ecs-rds-postgres-pool/scripts/upload-k6.sh on 2026-11-09.`

- [ ] **Step 2: Apply these changes, each in the section named**

1. **Usage comment (top):** list the new flags and the four profiles. Replace the "three load
   profiles" wording with "four" (`discovery`, `constant`, `spike`, `noisy-neighbour`). Add: "Every
   profile is uploaded every time: each has provisional default rates, and the rates plan 3 freezes
   come from `npm run capacity`. The archive also carries the six API keys and the seed shape, so
   it holds secrets: a key identifies a test user, and the stack is private." Delete the paragraph
   about "Mimir active series limit" (request.js already names every URL by route).
2. **Flag parsing:** add
   ```bash
       --peak-rate)    PEAK_RATE="${2:-}";    shift 2 ;;
       --normal-rate)  NORMAL_RATE="${2:-}";  shift 2 ;;
       --noisy-rate)   NOISY_RATE="${2:-}";   shift 2 ;;
   ```
   with `PEAK_RATE=""`, `NORMAL_RATE=""`, `NOISY_RATE=""` initialised above the loop; add
   `--rate` to the positive-integer check loop as `"rate:$RATE"` and the three new ones likewise
   (delete the separate `--rate` regex line). The `--only` check becomes
   `case "${ONLY:-discovery}" in discovery|constant|spike|noisy-neighbour) ;; *) die "--only takes discovery, constant, spike or noisy-neighbour, got '$ONLY'" ;; esac`.
   The `--run` rule becomes: `--run` needs `--only` (four profiles are uploaded; say which one runs).
   Update the `die "unknown flag …"` usage text to match.
3. **New section after "Resolving BASE_URL":** resolve the keys and the seed shape.
   ```bash
   echo
   step "Resolving API keys and the seed shape"
   KEYS_JSON=$(d terraform -chdir="$PROJECT_DIR/infra/main" output -json 2>/dev/null | jq -c '.api_keys.value // empty' || true)
   [ -n "$KEYS_JSON" ] || blocked "k6 upload" "infra/main has no api_keys output" \
     "terraform -chdir=infra/main apply -var-file=dev.tfvars   # approval gate" "./scripts/upload-k6.sh"
   MANIFEST="$PROJECT_DIR/service/seed-manifest.json"
   [ -f "$MANIFEST" ] || blocked "k6 upload" "service/seed-manifest.json is missing — the table is not seeded from this checkout" \
     "(cd service && TABLE_NAME=<table_name output> direnv exec ../.. npm run seed)" "./scripts/upload-k6.sh"
   ok "6 API keys; seed $(jq -r '.params | "feeds=\(.feeds)x\(.itemsPerFeed) reports=\(.reports)x\(.itemsPerReport)"' "$MANIFEST")"
   ```
4. **`E_ARGS` (section "upload"):** after `E_ARGS=(-e "BASE_URL=$BASE_URL")`:
   ```bash
   # lib/env.js reads these names. The keys map user -> API_KEY_<USER> (normal-1 -> API_KEY_NORMAL_1).
   while IFS=$'\t' read -r user key; do
     E_ARGS+=(-e "API_KEY_$(tr 'a-z-' 'A-Z_' <<<"$user")=$key")
   done < <(jq -r 'to_entries[] | "\(.key)\t\(.value)"' <<<"$KEYS_JSON")
   E_ARGS+=(-e "FEEDS=$(jq -r .params.feeds "$MANIFEST")" -e "ITEMS_PER_FEED=$(jq -r .params.itemsPerFeed "$MANIFEST")")
   E_ARGS+=(-e "REPORTS=$(jq -r .params.reports "$MANIFEST")" -e "ITEMS_PER_REPORT=$(jq -r .params.itemsPerReport "$MANIFEST")")
   ```
   and add, next to the existing optional ones:
   ```bash
   [ -n "$PEAK_RATE" ] && E_ARGS+=(-e "PEAK_RATE=$PEAK_RATE")
   [ -n "$NORMAL_RATE" ] && E_ARGS+=(-e "NORMAL_RATE=$NORMAL_RATE")
   [ -n "$NOISY_RATE" ] && E_ARGS+=(-e "NOISY_RATE=$NOISY_RATE")
   ```
5. **Which profiles:** replace the `if [ -n "$RATE" ] … TESTS=(discovery) … fi` block with
   `TESTS=(discovery constant spike noisy-neighbour)`, keeping `[ -z "$ONLY" ] || TESTS=("$ONLY")`.
6. **Printing:** never print `E_ARGS` whole — it holds the keys. The `--dry-run` line and the
   `--run` `info` line print `${E_ARGS[*]}`; replace both with a masked copy:
   `MASKED=$(printf '%s ' "${E_ARGS[@]}" | sed -E 's/(API_KEY_[A-Z0-9_]+=)[^ ]+/\1***/g')`
   (computed once after `E_ARGS` is complete). The metadata.json read-back `env` line gets the
   same mask: `(.env | to_entries | map(.key + "=" + (if (.key | startswith("API_KEY_")) then "***" else .value end)) | join(", "))`.
   The final `handoff` prints the rate values only, never keys.
7. **Staleness check (`check_stored`):** after the `BASE_URL` drift check, add the same check for
   the load key: the archive's `.env.API_KEY_LOAD` against `jq -r '.load // empty' <<<"$KEYS_JSON"`
   (resolve `LIVE_KEY_LOAD` best-effort next to `LIVE_BASE_URL`), warning "'$name' carries an API
   key from an older environment — re-upload" without printing either key.
8. **Run message:** "load comes from Grafana Cloud, Frankfurt" stays (it is now true for this
   project too). The E2004 note stays.

- [ ] **Step 3: Verify (no upload)**

```bash
bash -n lambda-concurrency-limit/scripts/upload-k6.sh
command -v shellcheck >/dev/null && shellcheck -x lambda-concurrency-limit/scripts/upload-k6.sh
lambda-concurrency-limit/scripts/upload-k6.sh --only bogus; echo "exit $?"
lambda-concurrency-limit/scripts/upload-k6.sh --rate abc; echo "exit $?"
lambda-concurrency-limit/scripts/upload-k6.sh --dry-run; echo "exit $?"
grep -n 'E_ARGS\[\*\]' lambda-concurrency-limit/scripts/upload-k6.sh
```
Expected: the two bad flags `die` with exit 1 and a message naming the flag; `--dry-run` stops at
`blocked … no k6_project_id output` (nothing is applied yet) with exit 1 — correct, the environment
does not exist; the last `grep` prints nothing (no unmasked printing left).

- [ ] **Step 4: Commit**

```bash
/usr/bin/git add lambda-concurrency-limit/scripts/upload-k6.sh
/usr/bin/git commit -m "feat(lambda-concurrency-limit/k6): add upload script with keys and seed shape"
```

---

### Task 9: `loadtest.md` and `results.md`

**Files:**
- Create: `lambda-concurrency-limit/loadtest.md`
- Create: `lambda-concurrency-limit/results.md`

**Interfaces:**
- Consumes: the results columns of the spec ("`results.md`"); the profile `-e` names; the metric
  names and dimensions in `infra/grafana/dashboard.tf`.

- [ ] **Step 1: Read the contract**

Read `.claude/skills/loadtest/SKILL.md`, section "The project contract", and
`ecs-rds-postgres-pool/loadtest.md` as the model. Four sections, in order: `## Results table`,
`## Before the run`, `## Load-generator sizing`, `## Server-side metrics (after the run)`.

- [ ] **Step 2: Write `loadtest.md`**

1. **Results table** — this header (the spine, then this project's columns; `EL lag p99` dropped:
   a Lambda has no event loop that outlives a request; `service attainment` dropped: there is no
   service-side SLI, spec decision 5):

   ```markdown
   | date | profile | infra change | seed | λ target | RPS | predicted A / B / RCU | k6 attainment (lat / avail) | throttle % | 429 % normal / noisy | p95 fast/std/heavy | p99 fast/std/heavy | Duration avg / export avg | cold starts | consumed RCU | ddb throttles | reserved / provisioned | otel | k6 run |
   ```

   Completeness column: `throttle %`. Derive its field number with
   `head -1 results.md | awk -F'|' '{for(i=1;i<=NF;i++) print i": "$i}'` and write the number in.
   Rule: a knob row with a blank `throttle %`, `k6 attainment` or `infra change` is incomplete.
   A judged user with `rate_limited > 0` makes a `noisy-neighbour` row invalid (design failure,
   spec "SLO, profiles and the per-user limit").
2. **Before the run** — the run gate: `ReadThrottleEvents` = 0 in the last 10 minutes; the alias
   is current (`./scripts/deploy-service.sh --check` says so); provisioned concurrency READY when
   on; for a PROVISIONED-table exploration row, 300 s of unused capacity in the burst bucket (wait
   5 minutes idle). Pre-run readings: `terraform output -json knobs`, `seed-manifest.json`, the
   predicted values from `npm run capacity -- …` (copy the exact command from
   `service/scripts/capacity.js`'s usage line).
3. **Load-generator sizing** — `vus(rate, cap)`: `n = min(cap, max(5, ceil(2 × rate ×
   MEAN_SECONDS)))`, `MEAN_SECONDS` = mix-weighted class threshold (0.36 s with the provisional
   thresholds); caps: 100 per sequential scenario, spike 20 + 80, noisy-neighbour 4 × 12 + 52; at
   the cap a run needs mean latency ≤ cap ÷ (2 × rate), else `dropped_iterations` fails it; the
   `-e` names and which `upload-k6.sh` flag sets each.
4. **Server-side metrics** — one `aws cloudwatch get-metric-statistics` command per column over
   `RUN_START`..`RUN_END` (ISO 8601 UTC), `--region eu-central-1`, `--period 60`, dimensions as in
   `infra/grafana/dashboard.tf`: `Throttles` Sum and `Invocations` Sum (throttle % = Throttles ÷
   (Throttles + Invocations); throttled requests are in neither `Invocations` nor `Errors`),
   `Duration` and `PostRuntimeExtensionsDuration` Average on `Resource=<function>:live`,
   `ColdStarts` Sum in namespace `lambda-concurrency-limit`, `ConsumedReadCapacityUnits` Sum,
   `ReadThrottleEvents` Sum. JMESPath functions lowercase (`sum(Datapoints[].Sum)`). Then a
   `column | source | rule` table; for each metric what an empty result means (`Throttles`,
   `ReadThrottleEvents`, `ColdStarts`: empty = 0, these publish nothing in a quiet minute;
   `Duration`: empty = wrong window or wrong `Resource`, never 0). Mark the section
   **"Not yet run against a live environment; plan 3, phase 0 verifies each command and dates it."**

- [ ] **Step 3: Write `results.md`**

```markdown
# lambda-concurrency-limit — results

Each row is one `/loadtest` run: the profile, the one infra change that distinguishes it from the
previous row, the prediction from `npm run capacity`, and what the run measured. A row is
comparable only with rows on the same seed (the `seed` column). How each column is read:
`loadtest.md`.

<the header line from loadtest.md, then the separator line>
```

No rows: nothing has run.

- [ ] **Step 4: Verify and commit**

`grep -c '|' lambda-concurrency-limit/results.md` ≥ 2; the header in `results.md` is byte-identical
to the one in `loadtest.md` (`diff <(grep '^| date' lambda-concurrency-limit/loadtest.md) <(grep '^| date' lambda-concurrency-limit/results.md)` prints nothing).

```bash
/usr/bin/git add lambda-concurrency-limit/loadtest.md lambda-concurrency-limit/results.md
/usr/bin/git commit -m "docs(lambda-concurrency-limit): add load-test contract and results ledger"
```

---

### Task 10: README, root README and CLAUDE.md

**Files:**
- Create: `lambda-concurrency-limit/README.md`
- Modify: `README.md` (root, the projects table)
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write the project README**

Read `.claude/skills/readme/SKILL.md` and follow its structure and ground rules exactly. What is
specific to this project:

- Opening: "Nothing is deployed." State the region (`eu-central-1`) and the shared-account
  constraint (limit 400, 352 unreserved, ceiling 252 for this function).
- `## Where to look`: the Grafana dashboard (`terraform output -json grafana_dashboard_url`), the
  CloudWatch dashboard (`cloudwatch_dashboard_url`), the alert rules folder, Tempo with a saved
  TraceQL query `{resource.service.name="lambda-concurrency-limit"}`, the k6 project. URLs from
  `terraform output`, never typed.
- `## 2. Are we meeting the SLO?`: k6 is the only SLI; Grafana shows the 5xx fraction and
  per-route p95 as evidence; no server-side latency burn and why.
- `## 3. What is the bottleneck?`: `ConcurrentExecutions` against reserved and `Throttles`, read
  next to `ReadThrottleEvents` — a DynamoDB throttle first shows as a longer `Duration`, which
  raises concurrency, so check the table before blaming concurrency.
- `## Reading a trace`: the OTel layers, the DynamoDB span, the export after the response.
- `## The knob sequence`: phases 0–4 from the spec's "Measurement sequence", each with its one
  `dev.tfvars` line and whether it needs `deploy-service.sh --config-only` after the apply.
- `## Configuration notes that bite`: alias versions freeze settings (`--config-only`, `--check`);
  the 100-VU cap and `vus(rate, cap)`; usage-plan throttling is best-effort; provisioned
  concurrency is billed per hour (set it back to 0 right after phase 4); DynamoDB
  provisioned → on-demand at most 4 times in 24 h and decreases are rationed; API keys are baked
  into the k6 archives; the CloudWatch dashboard is not tagged (teardown checks it by name); a
  re-apply changes the URL and the keys, so re-upload.
- `## Run it locally`: there is no local loop for the function behind API Gateway; `npm test`
  covers the handler with a mocked client.
- `## Phase 0 — Setup`: platform apply (once, approval gate), `terraform init`, `apply` (approval
  gate), `./scripts/deploy-service.sh`, seed:
  `(cd service && TABLE_NAME=$(terraform -chdir=../infra/main output -json | jq -r .table_name.value) direnv exec ../.. npm run seed)`
  — and what a re-run of the seed does (additive; a smaller seed is refused), then
  `./scripts/upload-k6.sh`.
- `## Phase 1 — Is it alive?`: one `curl -H "x-api-key: <load key>" <base_url>/items/feed-0000/item-0000`
  with the key from `terraform output -json api_keys | jq -r .load`; expect 200 (503 = placeholder:
  deploy did not run; 403 = missing key).
- Phases 2–9 per the skill, with the knob order of the spec. Phase 9, teardown: `terraform
  destroy` (approval gate), the tag sweep, and `aws cloudwatch list-dashboards --dashboard-name-prefix lambda-concurrency-limit` must be empty.
- `## Cost`: from the spec's "Lifecycle, cost": API Gateway REST about $3.50 per million; Lambda
  and DynamoDB on-demand cents; method-level metrics cents per session; provisioned concurrency
  about $0.75 per hour for 100 × 0.5 GB (x86 price; arm64 not verified); idle cost ≈ 0 (no VPC, no
  NAT, nothing always-on).
- `## Known gaps`: no server-side latency SLI; the per-user view is in the k6 app only; Query RCU
  rounding not verified; thinning gives CV 0.87, not 1.
- `## Measured results`: empty.

- [ ] **Step 2: Root `README.md` and `CLAUDE.md`**

Root `README.md`, the projects table row for `lambda-concurrency-limit/`:
`| lambda-concurrency-limit/ | Lambda + API Gateway + DynamoDB, reserved concurrency as the limit; per-user rate limit, reserved and provisioned concurrency as knobs | built (plans 1–2), not deployed |`

`CLAUDE.md`:
1. "Planned projects", the `lambda-concurrency-limit` bullet: "Lambda behind an API Gateway REST
   API, reading DynamoDB; reserved concurrency is the limit. Knobs: per-user rate limit, reserved
   concurrency 20 → 100, provisioned concurrency. Spec:
   `docs/superpowers/specs/2026-11-09-lambda-concurrency-limit-design.md`."
2. The deployment paragraph ("Lambda will publish a version"): "Lambda: a script publishes a
   version and moves the alias; Terraform ignores both. A setting frozen into a version
   (environment, memory, layers) needs `deploy-service.sh --config-only` after the apply."
3. The layout block, the `heartbeat/` line: append "— a Lambda project has none".
4. "Load-testing conventions": add "A Lambda project sends random arrivals by thinning a
   `constant-arrival-rate` executor (4 × the rate, each iteration sends with p = 0.25), so
   throttles match Erlang B; even arrivals understate them."

- [ ] **Step 3: Verify and commit**

Read the README against the skill's ground rules: no number without a source, no `§`-only
references, every apply/destroy marked `approval gate`.

```bash
/usr/bin/git add lambda-concurrency-limit/README.md README.md CLAUDE.md
/usr/bin/git commit -m "docs(lambda-concurrency-limit): add readme and repo-wide project notes"
```

---

### Task 11: Platform workspace, then a reviewed `terraform plan`

**Files:**
- Modify: `platform/tfc.tf` (`local.projects`)
- Modify: `docs/superpowers/plans/2026-11-09-lambda-concurrency-limit-infra.md` (Status)

- [ ] **Step 1: Add the workspace line and commit it alone**

In `platform/tfc.tf`, `local.projects`:

```hcl
    "lambda-concurrency-limit" = { working_directory = "infra/main" }
```

```bash
terraform fmt -check platform
/usr/bin/git add platform/tfc.tf
/usr/bin/git commit -m "feat(platform): add lambda-concurrency-limit workspace"
```

- [ ] **Step 2: Plan the platform change**

Run: `direnv exec . terraform -chdir=platform plan`
Expected: `2 to add` — `tfe_workspace.project["lambda-concurrency-limit"]` and
`tfe_workspace_settings.project["lambda-concurrency-limit"]` — `0 to change, 0 to destroy`.
Anything else: stop and report.

- [ ] **Step 3: STOP — approval gate**

Show the user the platform plan summary. Apply only after explicit approval:
`direnv exec . terraform -chdir=platform apply`. It creates a Terraform Cloud workspace; nothing in
AWS, nothing billable.

- [ ] **Step 4: Init against the real workspace**

```bash
./scripts/04-verify-setup.sh lambda-concurrency-limit
direnv exec . terraform -chdir=lambda-concurrency-limit/infra/main init
```
Expected: init connects to workspace `lambda-concurrency-limit` in remote mode.

- [ ] **Step 5: The reviewed plan**

Run: `direnv exec . terraform -chdir=lambda-concurrency-limit/infra/main plan -var-file=dev.tfvars`

Review checklist (each must hold; any miss is a finding, fixed in the task that owns the file):
- No error; both preconditions pass (account, `eu-central-1`).
- Creates, among others: 1 `aws_lambda_function` (reserved 20, arm64, nodejs22.x, 2 layers,
  `publish = true`), 1 `aws_lambda_alias`, **no** `aws_lambda_provisioned_concurrency_config`,
  1 `aws_dynamodb_table` (`PAY_PER_REQUEST`), 1 log group (retention 7), 1 metric filter,
  1 REST API with 7 resources, 3 methods (`api_key_required = true`), 3 `AWS_PROXY` integrations on
  the alias invoke ARN, 1 deployment, stage `dev`, method settings, 6 API keys, 2 usage plans
  (`users` without `throttle_settings`), 6 usage plan keys, 1 Lambda permission, 1 CloudWatch
  dashboard, the Grafana folder, dashboard and one rule group with 5 rules (2 burn, throttles,
  shared pool, DynamoDB; no "left on" rule while `provisioned_concurrency = 0`), the k6 project and
  its limits.
- 0 to change, 0 to destroy. No resource has a per-resource `Project` tag.
- `GRAFANA_OTLP_AUTH` shows as sensitive, never in clear.

- [ ] **Step 6: Pin the two refusals (Review Focus 2)**

```bash
direnv exec . terraform -chdir=lambda-concurrency-limit/infra/main plan -var-file=dev.tfvars -var reserved_concurrency=253
direnv exec . terraform -chdir=lambda-concurrency-limit/infra/main plan -var-file=dev.tfvars -var provisioned_concurrency=30
```
Expected: both fail on variable validation (`reserved_concurrency must be a whole number in
1..252`; `provisioned_concurrency must be a whole number in 0..reserved_concurrency`), before any
resource is planned. If remote runs refuse `-var`, use a throwaway `-var-file` in `/tmp` with the
one line.

- [ ] **Step 7: Record and commit**

Set this plan's Status to `complete` with the date, the plan's add count and any finding. Commit:

```bash
/usr/bin/git add docs/superpowers/plans/2026-11-09-lambda-concurrency-limit-infra.md
/usr/bin/git commit -m "docs(lambda-concurrency-limit): record plan 2 result and reviewed plan"
```

---

## Carried to plan 3

- Check the Grafana Cloud k6 VU-hour allowance before phase 1 (with VUs now ≤ 100 per run).
- A judged user with `rate_limited > 0` makes a `noisy-neighbour` run invalid.
- The API Gateway status for a Lambda throttle (docs: 500) — phase 1.
- The alias-level metric dimension `Resource = lambda-concurrency-limit:live` — phase 0, the
  CloudWatch widget and the Grafana row 4 show data.
- The three collector behaviours (`${env:…}` expansion, `decouple` present, `/v1/traces` appended)
  — the first deploy: a trace in Tempo, no config error in the logs.
- Run each `loadtest.md` server-side command once and date it.
