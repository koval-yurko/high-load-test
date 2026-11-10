# lambda-concurrency-limit — Tiered Rate Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

- **Status:** **complete** (2026-11-10). **Amended 2026-11-10 after completion:** the `partner` tier (Tasks 1 to 4 parts: keys, usage plan, `PARTNER_RATE`) was removed in a later commit; read every `partner` line below as historical. The spec's decision 4 says so., executed natively on branch `feat/lambda-tiered-rate-limits`.
  **Done:** all 8 tasks (Task 8 applied and switched off 2026-11-10; the WAF is gone). Tasks 1–7 (Task 7 applied 2026-11-10: alias `live` on version 3, `x-throttle: apigw` seen), Tasks 1–6 with one commit each (`e83ce2d`, `f1aff99`, `8fedcc4`, `658d42a`, `de6a4df`, `0149400`);
  `npm test` 67 of 67 pass; `terraform validate` and the plans match the task text (Task 4's count was
  corrected). **Left over:** the k6 cloud run of `tiers.js` gave no summary, so the lag was measured with curl; the WAF price is unverified. Both are in the spec, section 8.

**Goal:** `lambda-concurrency-limit` gets three rate-limit tiers (`normal`, `partner`, `anonymous`), a
rate-limit 429 that is recognisable on the wire and never a failed request, and a `tiers.js` k6 profile
that drives all three.

**Architecture:** Pure helpers in a new `lib/tier.js` (unit-tested in Node) decide what a rate-limit
429 is, which IP a caller has, and how the 100 VUs split. `lib/request.js` uses them. Terraform adds a
`partner` usage plan with 10 keys and a `THROTTLED` gateway response that sets `x-throttle: apigw`;
behind `anonymous_enabled` it adds `/public/*` routes and a WAF rate-based rule (per
`X-Forwarded-For`) that blocks with 429 and `x-throttle: waf`. The handler strips the `/public` prefix.

**Tech Stack:** Terraform 1.14 with `hashicorp/aws ~> 6.0` and `grafana/grafana ~> 3.0`; k6 2.3.0; Node 22
(`node --test`); bash with the root `scripts/lib.sh` helpers.

**Spec:** `docs/superpowers/specs/2026-11-10-lambda-concurrency-limit-tiered-rate-limits-design.md`
(amends `docs/superpowers/specs/2026-11-09-lambda-concurrency-limit-design.md`, decisions 2 and 6 and
section 6.4).

## Global Constraints

- The project directory and the `Project` tag value are `lambda-concurrency-limit`. WAF resources get the tag from the AWS provider's `default_tags`.
- Commit scope is `lambda-concurrency-limit` or `lambda-concurrency-limit/<layer>` (`terraform`, `k6`, `grafana`). Conventional Commits 1.0.0.
- No script may run `terraform apply`. The only applies are in Task 7 and Task 8, and each stops for the user's approval.
- A rate-limit 429 is a 429 **with** the header `x-throttle` (`apigw` or `waf`). A 429 without it, and every 5xx, is a failure. A Lambda or DynamoDB capacity problem is a 500, never a 429.
- Burst is 2 × rate on every usage plan. `0` on a limit variable means no throttle on that plan.
- `anonymous_rate_limit` ≥ 10 and `anonymous_window_seconds` ∈ {60, 120, 300, 600} (WAF rate-based rule limits).
- `anonymous_ip_source = "forwarded"` is a test setting. Its variable description says a client controls that address.
- The VU cap is 100 across all scenarios of one profile (`VU_CAP` in `infra/k6/tests/lib/arrivals.js`).
- Partner callers: 10 (`partner-1` … `partner-10`). Anonymous callers: 20. Normal callers: `normal-1` … `normal-4` plus `noisy`.
- Existing resource names (`aws_api_gateway_usage_plan.users`, `aws_api_gateway_api_key.user`) do not change, so nothing is replaced.
- Measure with the profile, never edit thresholds to pass: `slo.yaml` is not touched by this plan.

## Review Focus

1. A 429 with no `x-throttle` header must count as a failed request (not hidden as a rate limit). Pinned in Task 1.
2. k6 may hand headers back in any case (`X-Throttle`, `x-throttle`). The helper must match both. Pinned in Task 1.
3. Two different caller indexes must never map to the same address, and index 1 must be `10.0.0.1`. Pinned in Task 1.
4. `/public` stripping must not touch a route that only starts with the same letters (`/publicity/…`) and must not make an unknown route answer 200. Pinned in Task 2.
5. `anonymous_enabled = false` must create no WAF, no `/public` route and no association; the plan must show 0 resources for them. Pinned in Task 5.
6. An `anonymous_rate_limit` below 10 or a window outside the allowed set must be rejected at plan time. Pinned in Task 5.
7. The per-tier VU caps must add up to no more than 100, or Grafana Cloud k6 refuses the upload (error E2004). Pinned in Task 1.

---

## File Structure

| file | responsibility |
|---|---|
| `infra/k6/tests/lib/tier.js` (new) | Pure helpers, no k6 imports: `rateLimitedBy`, `isAvailable`, `anonymousIp`, `TIER_VU_CAP`, `ANON_CALLERS`, `PARTNER_CALLERS` |
| `infra/k6/tests/lib/request.js` | Uses the helpers; sends anonymous calls to `/public` with the spoofed header |
| `infra/k6/tests/lib/env.js` | Reads the ten partner keys |
| `infra/k6/tests/lib/slo.js` | Not edited by hand: generated. `gate()` already reports `rate_limited` |
| `infra/k6/tests/tiers.js` (new) | The profile |
| `service/src/handler.js` | Strips the `/public` prefix from `event.resource` |
| `service/test/tier.test.js` (new) | Tests for `tier.js` |
| `service/test/handler.test.js` | Tests for the prefix |
| `infra/main/variables.tf`, `outputs.tf` | New switches; knobs output |
| `infra/main/api.tf` | Partner keys and plan, gateway response, public routes |
| `infra/main/waf.tf` (new) | Web ACL, rule, association (all `count = anonymous_enabled`) |
| `infra/main/grafana.tf`, `infra/grafana/*` | The rate-limiting dashboard row |
| `scripts/upload-k6.sh` | Flags `--partner-rate`, `--anon-rate`, `--tiers`; uploads `tiers.js` |
| `loadtest.md`, `results.md`, `README.md` | Columns, flags, traps, teardown |

---

### Task 1: Tier helpers (pure logic, tested)

**Files:**
- Create: `lambda-concurrency-limit/infra/k6/tests/lib/tier.js`
- Create: `lambda-concurrency-limit/service/test/tier.test.js`

**Interfaces:**
- Produces (all exported from `lib/tier.js`, plain ES module, no `k6/*` imports):
  - `rateLimitedBy(status: number, headers: object) -> 'apigw' | 'waf' | null` — non-null only for status 429 with `x-throttle` equal to `apigw` or `waf` (header name matched case-insensitively).
  - `isAvailable(status: number) -> boolean` — true for 1..499 **except 429**; false for 0, 429 and ≥ 500. The caller skips rate-limited requests before calling it.
  - `anonymousIp(index: number) -> string` — index ≥ 1; `10.0.${Math.floor((index - 1) / 254)}.${((index - 1) % 254) + 1}`.
  - `PARTNER_CALLERS = 10`, `ANON_CALLERS = 20`.
  - `TIER_VU_CAP = { normal: 20, noisy: 20, partner: 30, anonymous: 30 }`.

- [ ] **Step 1: Write the failing tests** in `service/test/tier.test.js`, loading the module as `k6-lib.test.js` does (`import(path.join(__dirname, '..', '..', 'infra', 'k6', 'tests', 'lib', 'tier.js'))`). Test names and assertions:
  - `a 429 with x-throttle: apigw is rate limited by apigw`, and the same for `waf`.
  - `the header name matches in any case`: `{ 'X-Throttle': 'waf' }` and `{ 'x-throttle': 'waf' }` both return `'waf'`.
  - `a 429 without x-throttle is not rate limited` → `null`; and `isAvailable(429) === false`.
  - `x-throttle on a non-429 status is ignored` → `rateLimitedBy(500, { 'x-throttle': 'apigw' }) === null`.
  - `isAvailable`: `200 → true`, `404 → true`, `500 → false`, `0 → false`.
  - `anonymousIp(1) === '10.0.0.1'`, `anonymousIp(255) === '10.0.1.1'`.
  - `anonymousIp gives 20 distinct addresses for 1..20` (a `Set` of size 20) and also for 1..600.
  - `the per-tier VU caps add up to at most the 100-VU cap`: sum of `TIER_VU_CAP` values ≤ `VU_CAP` imported from `arrivals.js`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd lambda-concurrency-limit/service && node --test test/tier.test.js`
Expected: FAIL, `Cannot find module` for `tier.js`.

- [ ] **Step 3: Implement `tier.js`** with the signatures above. Header lookup: find the key whose lowercase equals `x-throttle`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd lambda-concurrency-limit/service && node --test test/tier.test.js`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lambda-concurrency-limit/infra/k6/tests/lib/tier.js lambda-concurrency-limit/service/test/tier.test.js
git commit -m "feat(lambda-concurrency-limit/k6): add tier helpers for rate-limit recognition"
```

---

### Task 2: Use the helpers in the request path, and strip `/public` in the handler

**Files:**
- Modify: `lambda-concurrency-limit/infra/k6/tests/lib/request.js`
- Modify: `lambda-concurrency-limit/infra/k6/tests/lib/env.js`
- Modify: `lambda-concurrency-limit/service/src/handler.js` (the line `const route = routes[...]` and the log line)
- Test: `lambda-concurrency-limit/service/test/handler.test.js`

**Interfaces:**
- Consumes: Task 1 (`rateLimitedBy`, `isAvailable`, `anonymousIp`).
- Produces: `doRequest({ user, judged, tags, anonymousIndex })` in `request.js`. When `anonymousIndex` is a number, the request goes to `/public` + the route, carries no `x-api-key`, carries `X-Forwarded-For: anonymousIp(anonymousIndex)`, and the `user` tag is `anon-<anonymousIndex>`. `KEYS` in `env.js` gains `partner-1` … `partner-10` from `API_KEY_PARTNER_1` … `API_KEY_PARTNER_10`.

- [ ] **Step 1: Write the failing handler tests** in `handler.test.js`:
  - `public prefix routes like the keyed route`: `ev('/public/items/{pk}/{sk}', …)` returns 200 with the item.
  - `a resource that only starts with public is not stripped`: `ev('/publicity/{pk}', …)` returns 404.
  - `an unknown public route is 404`: `ev('/public/nothing', {})` returns 404.

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd lambda-concurrency-limit/service && node --test test/handler.test.js`
Expected: the first new test FAILS with status 404.

- [ ] **Step 3: Implement the strip in `handler.js`:** `const resource = event.resource.replace(/^\/public(?=\/)/, '')`, then route on `resource`. The error log keeps the original `event.resource`.

- [ ] **Step 4: Run the handler tests and the whole suite**

Run: `cd lambda-concurrency-limit/service && npm test`
Expected: all PASS.

- [ ] **Step 5: Edit `request.js`:** replace the `res.status === 429` logic. `rateLimited.add(rateLimitedBy(res.status, res.headers) !== null, t)`; a judged request that is rate limited adds nothing to `slo_available` or `slo_met`; otherwise `sloAvailable.add(isAvailable(res.status), t)` and `sloMet` as before. Add the `anonymousIndex` behaviour from Interfaces. Add the `tier` tag: `anonymous` when `anonymousIndex` is set, else the tier the caller passes in `tags`. Edit `env.js` for the ten partner keys.

- [ ] **Step 6: Check that k6 still parses every profile**

Run: `cd lambda-concurrency-limit && for t in discovery constant spike noisy-neighbour; do k6 inspect infra/k6/tests/$t.js >/dev/null && echo "ok $t"; done`
Expected: four `ok` lines.

- [ ] **Step 7: Commit**

```bash
git add lambda-concurrency-limit/service/src/handler.js lambda-concurrency-limit/service/test/handler.test.js lambda-concurrency-limit/infra/k6/tests/lib/request.js lambda-concurrency-limit/infra/k6/tests/lib/env.js
git commit -m "feat(lambda-concurrency-limit): route the public prefix; count only marked 429s as rate limited"
```

---

### Task 3: The `tiers.js` profile and the upload flags

**Files:**
- Create: `lambda-concurrency-limit/infra/k6/tests/tiers.js`
- Modify: `lambda-concurrency-limit/scripts/upload-k6.sh` (flag parsing near line 86, the `TESTS` list near line 288, the `-e` block near line 305, the usage text, the `--only` check near line 96, and the `ok "6 API keys"` line near line 285)
- Modify: `lambda-concurrency-limit/loadtest.md` (profile list, flag table, VU caps table)

**Interfaces:**
- Consumes: Task 1 and Task 2.
- Produces: `tiers.js` reads `NORMAL_RATE` (per caller, default 10), `NOISY_RATE` (default 60), `PARTNER_RATE` (per caller, default 20), `ANON_RATE` (per caller, default 1), `TIERS` (comma list of `normal`, `noisy`, `partner`, `anonymous`; default all four), `WARMUP_SECONDS`, `DURATION_SECONDS`. Four scenarios named after the tiers; each iteration picks a caller index at random (`1 + Math.floor(Math.random() * N)`) and passes it to `doRequest`. Scenario rates: `normal` = 4 × `NORMAL_RATE`, `noisy` = `NOISY_RATE`, `partner` = `PARTNER_CALLERS` × `PARTNER_RATE`, `anonymous` = `ANON_CALLERS` × `ANON_RATE`. VU caps come from `TIER_VU_CAP`. `judged` is true for `normal`, `partner` and `anonymous`; `noisy` is not judged (as in `noisy-neighbour.js`). Thresholds: `gate('window:measured')` plus `rate_limited{tier:<t>,window:measured}` reported for each selected tier. Upload flags: `--partner-rate`, `--anon-rate`, `--tiers`, mapped to `PARTNER_RATE`, `ANON_RATE`, `TIERS`.

- [ ] **Step 1: Write the failing check.** A shell-level check is the honest test here: `k6 inspect infra/k6/tests/tiers.js` must exit 0 and list four scenarios. Run it now.

Run: `cd lambda-concurrency-limit && k6 inspect infra/k6/tests/tiers.js`
Expected: FAIL, file not found.

- [ ] **Step 2: Write `tiers.js`** following `noisy-neighbour.js` (same `options` shape, cloud name `lambda-concurrency-limit tiers`, `USER_AGENT`, `RATE_SOURCE`). The `window` tag works as in `noisy-neighbour.js`. `RATE_SOURCE` in `env.js` must also count `PARTNER_RATE` and `ANON_RATE` as explicit: add them to the list there.

- [ ] **Step 3: Check it parses, with each tier alone and with all**

Run: `cd lambda-concurrency-limit && k6 inspect infra/k6/tests/tiers.js && k6 inspect -e TIERS=anonymous infra/k6/tests/tiers.js`
Expected: exit 0 both times; the second lists one scenario.

- [ ] **Step 4: Edit `upload-k6.sh`:** add the three flags and their validation (whole numbers, as the existing `pair` loop does; `--tiers` must be a comma list of the four names), add `tiers` to the allowed `--only` values and to `TESTS`, pass the `-e` values like the existing ones, and replace the hardcoded `6 API keys` with the count from `jq length <<<"$KEYS_JSON"`.

- [ ] **Step 5: Verify the script without touching the cloud**

Run: `cd lambda-concurrency-limit && ./scripts/upload-k6.sh --only tiers --partner-rate 20 --anon-rate 1 --tiers partner,anonymous --dry-run`
Expected: a line `dry run: … tests/tiers.js` with `PARTNER_RATE=20`, `ANON_RATE=1`, `TIERS=partner,anonymous`, and the keys masked as `***`. Exit 0.

- [ ] **Step 6: Update `loadtest.md`:** add `tiers` to the profile list; add the three flags to the flag table; add a VU caps row (`tiers`: 20 normal + 20 noisy + 30 partner + 30 anonymous).

- [ ] **Step 7: Commit**

```bash
git add lambda-concurrency-limit/infra/k6/tests/tiers.js lambda-concurrency-limit/infra/k6/tests/lib/env.js lambda-concurrency-limit/scripts/upload-k6.sh lambda-concurrency-limit/loadtest.md
git commit -m "feat(lambda-concurrency-limit/k6): add the tiers profile and its upload flags"
```

---

### Task 4: Terraform — partner plan, partner keys, marked API Gateway 429

**Files:**
- Modify: `lambda-concurrency-limit/infra/main/variables.tf` (new `partner_rate_limit_rps`, after `user_rate_limit_rps`)
- Modify: `lambda-concurrency-limit/infra/main/api.tf` (locals, key `for_each`, usage plan, plan keys, gateway response, deployment triggers)
- Modify: `lambda-concurrency-limit/infra/main/outputs.tf` (`knobs`)
- Modify: `lambda-concurrency-limit/infra/main/dev.tfvars` (a line `partner_rate_limit_rps = 0`)

**Interfaces:**
- Produces: variable `partner_rate_limit_rps` (number, default 0, whole number ≥ 0, same validation shape as `user_rate_limit_rps`); `local.partners = [for i in range(1, 11) : "partner-${i}"]`; `aws_api_gateway_usage_plan.partner` with `dynamic "throttle_settings"` (rate = the variable, burst = 2 ×); `aws_api_gateway_usage_plan_key.partner` (`for_each = toset(local.partners)`); `aws_api_gateway_gateway_response.throttled` (`response_type = "THROTTLED"`, `status_code = "429"`, `response_parameters = { "gatewayresponse.header.x-throttle" = "'apigw'" }`); the `knobs` output gains `partner_rate_limit_rps`. `aws_api_gateway_api_key.user` takes `toset(concat(local.users, local.partners, ["load"]))`, so `api_keys` gains the ten keys. The deployment `triggers` also hash the gateway response id.

- [ ] **Step 1: Write the expectation first (the measurement analogue).** The plan after this task must show exactly: 10 API keys, 10 plan keys, 1 usage plan, 1 gateway response to add; 1 deployment and the `knobs` output to change; 0 to destroy.

- [ ] **Step 2: Implement the changes listed above.**

- [ ] **Step 3: Format and validate**

Run: `cd lambda-concurrency-limit/infra/main && terraform fmt -check -recursive .. && terraform validate`
Expected: no output from `fmt -check`; `Success! The configuration is valid`.

- [ ] **Step 4: Review the plan**

Run: `cd lambda-concurrency-limit && direnv exec .. terraform -chdir=infra/main plan -var-file=dev.tfvars -no-color | tail -5`
Expected: `Plan: 23 to add, 1 to change, 1 to destroy.` (10 keys + 10 plan keys + 1 plan + 1 gateway response + the replaced deployment = 23; the stage changes in place; the one destroy is the old deployment, replaced by design because its `triggers` hash changed.) Corrected 2026-11-10 while executing: the first text said 22 / 0 and missed the deployment. Any other destroy is a bug: stop and fix.

- [ ] **Step 5: Commit**

```bash
git add lambda-concurrency-limit/infra/main/variables.tf lambda-concurrency-limit/infra/main/api.tf lambda-concurrency-limit/infra/main/outputs.tf lambda-concurrency-limit/infra/main/dev.tfvars
git commit -m "feat(lambda-concurrency-limit/terraform): add the partner usage plan and mark API Gateway 429s"
```

---

### Task 5: Terraform — the anonymous tier (public routes and WAF)

**Files:**
- Create: `lambda-concurrency-limit/infra/main/waf.tf`
- Modify: `lambda-concurrency-limit/infra/main/api.tf` (public resources, methods, integrations, deployment triggers)
- Modify: `lambda-concurrency-limit/infra/main/variables.tf`, `outputs.tf`, `dev.tfvars`

**Interfaces:**
- Produces: variables `anonymous_enabled` (bool, default false), `anonymous_rate_limit` (number, default 100, validation `>= 10` and whole), `anonymous_window_seconds` (number, default 60, validation `contains([60, 120, 300, 600], …)`), `anonymous_ip_source` (string, default `"forwarded"`, validation `contains(["forwarded", "source"], …)`, description says the forwarded setting is for tests only because a client controls that address). With `anonymous_enabled = true`: resources `public`, `public_items`, `public_items_pk`, `public_items_sk`, `public_feeds`, `public_feeds_pk`, `public_reports`, `public_reports_pk` (`aws_api_gateway_resource`, `count`), methods and integrations for the three leaves (`api_key_required = false`, same alias integration), `aws_wafv2_web_acl.anonymous`, `aws_wafv2_web_acl_association.anonymous` (`resource_arn = aws_api_gateway_stage.dev.arn`). Rule: `rate_based_statement` with `limit = var.anonymous_rate_limit`, `evaluation_window_sec = var.anonymous_window_seconds`, `aggregate_key_type` `FORWARDED_IP` (with `forwarded_ip_config { header_name = "X-Forwarded-For", fallback_behavior = "MATCH" }`) or `IP` by `anonymous_ip_source`, a `scope_down_statement` byte match on `uri_path` `STARTS_WITH` `/public/`; action `block` with `custom_response { response_code = 429 }` and a `response_header { name = "x-throttle", value = "waf" }` (the custom response body setting follows the provider schema). The `knobs` output gains the four `anonymous_*` values. The deployment triggers hash the public methods and integrations.

- [ ] **Step 1: Write the expectations first.**
  - With `anonymous_enabled = false`: the plan has **0** WAF resources, **0** `public*` resources, **0** associations.
  - With `anonymous_enabled = true`: 8 resources + 3 methods + 3 integrations + 1 web ACL + 1 association (16), plus 1 deployment change.
  - `-var=anonymous_rate_limit=5` fails validation. `-var=anonymous_window_seconds=30` fails validation.

- [ ] **Step 2: Implement.** Gate each new resource with `count = var.anonymous_enabled ? 1 : 0`; refer to counted resources with `[0]`. `local.public_routes` is `{}` when disabled, so the `for_each` on methods and integrations stays empty.

- [ ] **Step 3: Format and validate**

Run: `cd lambda-concurrency-limit/infra/main && terraform fmt -check -recursive .. && terraform validate`
Expected: `Success! The configuration is valid`.

- [ ] **Step 4: Check the disabled plan**

Run: `cd lambda-concurrency-limit && direnv exec .. terraform -chdir=infra/main plan -var-file=dev.tfvars -no-color | grep -ciE 'wafv2|public'`
Expected: `0`.

- [ ] **Step 5: Check the enabled plan**

Run: `cd lambda-concurrency-limit && direnv exec .. terraform -chdir=infra/main plan -var-file=dev.tfvars -var=anonymous_enabled=true -no-color | tail -5`
Expected: 16 more to add than Step 4's plan, 0 to destroy. Count the WAF resources with `grep -c wafv2` (expect 2 blocks: the ACL and the association).

- [ ] **Step 6: Check the validations**

Run: `cd lambda-concurrency-limit && direnv exec .. terraform -chdir=infra/main plan -var-file=dev.tfvars -var=anonymous_rate_limit=5 -no-color 2>&1 | grep -i 'must be'`
Expected: one validation error line. Repeat with `-var=anonymous_window_seconds=30`.

- [ ] **Step 7: Commit**

```bash
git add lambda-concurrency-limit/infra/main/waf.tf lambda-concurrency-limit/infra/main/api.tf lambda-concurrency-limit/infra/main/variables.tf lambda-concurrency-limit/infra/main/outputs.tf lambda-concurrency-limit/infra/main/dev.tfvars
git commit -m "feat(lambda-concurrency-limit/terraform): add the anonymous tier behind anonymous_enabled"
```

---

### Task 6: Dashboard row, results columns and docs

**Files:**
- Modify: `lambda-concurrency-limit/infra/grafana/variables.tf` (new `anonymous_enabled`, `web_acl_name`), `infra/grafana/dashboard.tf` (a new last section), `infra/main/grafana.tf` (pass them)
- Modify: `lambda-concurrency-limit/results.md`, `loadtest.md` (column)
- Modify: `lambda-concurrency-limit/README.md` ("Configuration notes that bite", Phase 9 sweep, the knob sequence)

**Interfaces:**
- Produces: a section `7 · Rate limiting` appended **last** in `local.sections`, so panel id 2 (`4xx and 5xx`) is unchanged and `__panelId__` in `alerts.tf` stays valid. It has one panel, `7 · WAF blocked requests`, namespace `AWS/WAFV2`, metric `BlockedRequests`, stat `Sum`, dimensions `WebACL = <web_acl_name>`, `Rule = anonymous-per-ip`, `Region = <region>`. The section exists only when `var.anonymous_enabled` (use `concat` with an empty list). The results column `429 % normal / noisy` becomes `rate-limited % normal / noisy / partner / anonymous`; the one existing row keeps its value in the first two slots with `n/a` in the others, and a one-line note under the table records the change on 2026-11-10.

- [ ] **Step 1: Expectation.** With `anonymous_enabled = false` the dashboard JSON is unchanged (plan shows no change to `grafana_dashboard.main`). With `true` it gains exactly one row and one panel.

- [ ] **Step 2: Implement.**

- [ ] **Step 3: Verify both cases**

Run: `cd lambda-concurrency-limit && direnv exec .. terraform -chdir=infra/main plan -var-file=dev.tfvars -target=module.grafana.grafana_dashboard.main -no-color | tail -3`
Expected: `No changes` for the disabled case. Repeat with `-var=anonymous_enabled=true`: `1 to change`.

- [ ] **Step 4: Docs.** README: two entries under "Configuration notes that bite" (the forwarded-header trap; a WAF count is approximate, 60 s window, blocking lag), a Phase 9 line adding `AWS::WAFv2::WebACL` to the sweep, and the knob sequence text now reads "knob 1 = three limits". `loadtest.md`: the column name in the header block.

- [ ] **Step 5: Format, validate, commit**

Run: `cd lambda-concurrency-limit/infra/main && terraform fmt -check -recursive .. && terraform validate`
Expected: success.

```bash
git add lambda-concurrency-limit/infra lambda-concurrency-limit/results.md lambda-concurrency-limit/loadtest.md lambda-concurrency-limit/README.md
git commit -m "docs(lambda-concurrency-limit): add the rate-limiting row and the per-tier results column"
```

---

### Task 7: Apply the keyed tiers and the handler — **stops for approval**

**Files:** none changed.

**Interfaces:** Consumes Tasks 2 and 4. Produces a live environment with the partner plan, the marked API Gateway 429 and the handler that strips `/public`, with `anonymous_enabled = false`.

- [ ] **Step 1: Show the plan and wait.** Run `direnv exec .. terraform -chdir=infra/main plan -var-file=dev.tfvars -no-color | tail -5` and show it to the user. **Stop. Do not apply until the user approves.**

- [ ] **Step 2: Apply (after approval)**

Run: `cd lambda-concurrency-limit && direnv exec .. terraform -chdir=infra/main apply -var-file=dev.tfvars`
Expected: `Apply complete`, 23 added, 1 destroyed (the old deployment).

- [ ] **Step 3: Deploy the handler.** The alias keeps the old code until the script moves it.

Run: `cd lambda-concurrency-limit && ./scripts/deploy-service.sh && ./scripts/deploy-service.sh --check`
Expected: `--check` says alias `live` matches `$LATEST`.

- [ ] **Step 4: Settle spec items 3 (the header on a throttle).** Set `partner_rate_limit_rps = 1` in `dev.tfvars`, apply (this is part of the same approval; show the one-line plan first), then send 30 requests in a second with one partner key:

Run: `cd lambda-concurrency-limit && K=$(direnv exec .. terraform -chdir=infra/main output -json api_keys | jq -r '."partner-1"'); U=$(direnv exec .. terraform -chdir=infra/main output -raw base_url); for i in $(seq 30); do curl -s -o /dev/null -D - -H "x-api-key: $K" "$U/items/feed-0000/item-0000" | grep -iE '^(HTTP|x-throttle)'; done | sort | uniq -c`
Expected: a mix of `HTTP/2 200` and `HTTP/2 429`, with the `x-throttle: apigw` line present as often as `429`. Then set `partner_rate_limit_rps = 0` again and apply.

- [ ] **Step 5: Record** the result of spec item 3 in the spec's section 8 (one line, dated).

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-11-10-lambda-concurrency-limit-tiered-rate-limits-design.md lambda-concurrency-limit/infra/main/dev.tfvars
git commit -m "docs(lambda-concurrency-limit): record that API Gateway 429s carry x-throttle"
```

---

### Task 8: Apply the anonymous tier and settle the WAF questions — **stops for approval**

**Files:** none changed besides `dev.tfvars` and the spec's section 8.

**Interfaces:** Consumes Tasks 3, 5 and 7. Produces answers to spec section 8 items 1, 2, 4 and 5.

- [ ] **Step 1: Show the cost and the plan, and wait.** Say that the WAF bills while it exists. Set `anonymous_enabled = true`, `anonymous_rate_limit = 10`, `anonymous_window_seconds = 60`, `anonymous_ip_source = "forwarded"` in `dev.tfvars`. Run the plan and show it. **Stop for approval.**

- [ ] **Step 2: Apply (after approval)**, then `./scripts/deploy-service.sh --check`.

- [ ] **Step 3: Item 4 — a keyless call reaches the Lambda**

Run: `cd lambda-concurrency-limit && U=$(direnv exec .. terraform -chdir=infra/main output -raw base_url); curl -s -o /dev/null -w '%{http_code}\n' "$U/public/items/feed-0000/item-0000"`
Expected: `200`. A `403` means the route still needs a key; a `404` means the prefix is not stripped.

- [ ] **Step 4: Items 1 and 2 — the WAF counts by the spoofed address and returns the marked 429.** Send 40 requests in under a minute, all with `X-Forwarded-For: 10.0.0.1`, then 5 with `10.0.0.2`:

Run: `for i in $(seq 40); do curl -s -o /dev/null -D - -H 'X-Forwarded-For: 10.0.0.1' "$U/public/items/feed-0000/item-0000" | grep -iE '^(HTTP|x-throttle)'; done | sort | uniq -c; for i in $(seq 5); do curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Forwarded-For: 10.0.0.2' "$U/public/items/feed-0000/item-0000"; done`
Expected: some `HTTP/2 429` with `x-throttle: waf` for `10.0.0.1` once the limit of 10 per minute is crossed; all five for `10.0.0.2` are `200`. If `10.0.0.2` is also blocked, item 1 failed: the rule does not use the client's address, and the design falls back to the shared bucket (stop and report).

- [ ] **Step 5: Item 5 — blocking lag.** Upload and run `tiers.js` with only the anonymous tier at a rate above the limit:

Run: `cd lambda-concurrency-limit && ./scripts/upload-k6.sh --only tiers --tiers anonymous --anon-rate 1 --run`
Expected: a cloud run URL. In the k6 UI, `rate_limited{tier:anonymous}` is above 0 and `slo_available` is not hurt by it. Note how many seconds pass between the first request over the limit and the first 429.

- [ ] **Step 6: Record** items 1, 2, 4, 5 and the price (AWS WAF pricing page, dated) in section 8 of the spec.

- [ ] **Step 7: Switch off.** Set `anonymous_enabled = false` and apply (show the plan; it must destroy only WAF and public resources). WAF bills while it exists.

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/specs/2026-11-10-lambda-concurrency-limit-tiered-rate-limits-design.md lambda-concurrency-limit/infra/main/dev.tfvars
git commit -m "docs(lambda-concurrency-limit): record the WAF per-IP checks"
```

---

## Self-review

- **Spec coverage:** tiers and decisions 1–9 → Tasks 4, 5 (infra), 3 (profile `TIERS`); section 3 table and the header → Task 1 (helpers), Task 4 (apigw), Task 5 (waf); 4.1 routes → Tasks 2 and 5; 4.2 plans → Task 4; 4.3 WAF → Task 5; 4.4 k6 → Tasks 1–3; 4.5 keys and scripts → Task 3; section 5 → Task 6; section 6 sizing → no code, the rule stays in the spec and the calibration run follows this plan; section 7 cost and teardown → Tasks 6 and 8; section 8 unverified items 1–5 → Tasks 7 and 8, item 6 (price) → Task 8 step 6; section 9 switches → Tasks 3, 4 and 5.
- **Not in this plan, on purpose:** the calibration of `Ln`, `Lp` and `La` and the first `tiers.js` measurement. They need the discovery result and are the next plan (a measurement plan, as plan 3 was for the first project).
- **Type consistency:** `rateLimitedBy`, `isAvailable`, `anonymousIp`, `TIER_VU_CAP`, `ANON_CALLERS`, `PARTNER_CALLERS` are named the same in Tasks 1–3. `anonymous_enabled`, `anonymous_rate_limit`, `anonymous_window_seconds`, `anonymous_ip_source`, `partner_rate_limit_rps` are named the same in Tasks 4–6.
- **Known deviation from the spec, already marked in the spec:** the caller index replaces "one VU is one caller" (spec section 4.4, corrected 2026-11-10).
- **Resource counts in Task 4 and 5** (23 and 16; Task 4 corrected while executing) come from counting the resources listed; the first `plan` is the check, and a different count means the task text, not the plan output, is wrong.
