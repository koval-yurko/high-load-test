# lambda-concurrency-limit — tiered rate limits (normal, partner, anonymous)

- **Date:** 2026-11-10
- **Amended 2026-11-10:** the `partner` tier is removed (decisions 4 and 6 and the tier table say so).
  Two tiers remain: authorised (`normal`, `noisy`) and anonymous. Sections below that mention partners
  are historical.
- **Status:** **approved** (2026-11-10, by the user, after reviewing the written spec). The user chose
  the direction the same day (three tiers, per-IP WAF limit for anonymous callers, k6 spoofing
  `X-Forwarded-For`) and answered the sizing and switch questions (decisions 6 to 9). Plan:
  `docs/superpowers/plans/2026-11-10-lambda-concurrency-limit-tiered-rate-limits.md`.
- **Project directory:** `lambda-concurrency-limit/`
- **Amends** `docs/superpowers/specs/2026-11-09-lambda-concurrency-limit-design.md`, in three places.
  Each has a forward-pointer written at the decision itself:
  - **Decision 2** ("one API key and one usage plan per test user"): there are now two keyed usage plans
    (`normal`, `partner`) and one keyless tier (`anonymous`). Why it changes: the first design had no
    answer for a caller without a key, and the user wants such callers to reach the endpoints with a
    lower limit.
  - **Decision 6** ("a per-user 429 is not a miss"): the same rule now covers every tier, and a rate-limit
    429 must be recognisable on the wire. Why it changes: with three limiters, the first design's
    "429 = limit working" is no longer enough to tell a limit from a fault.
  - **Section 6.4** (the per-user limit, knob 1): knob 1 becomes three limits, and the sizing rule
    adds up all tiers.
- **Builds on:** the same spec, sections 3.2 (what Terraform owns), 6.2 (random arrivals) and 6.3 (profiles).

---

## 1. Problem

Today every route needs an API key (`api_key_required`), and one usage plan holds the five test users.
Three gaps follow:

1. A caller with no key gets 403 at once. The project cannot show what an anonymous caller costs, or how
   a small limit protects the Lambda for the others.
2. All keyed users share one limit. There is no higher tier for trusted callers.
3. A 429 means "the limit worked", but nothing on the response says which limiter sent it. Lambda and
   DynamoDB capacity problems do not return 429 (section 3), so the confusion is smaller than it looks,
   but API Gateway uses 429 for two different limits.

## 2. Decisions (from the user, 2026-11-10)

| # | question | answer |
|---|---|---|
| 1 | Do anonymous callers reach the endpoints? | **Yes**, as a separate tier with a lower limit per caller |
| 2 | Limit anonymous callers per caller or all together? | **Per caller (per IP)**, with an AWS WAF rate-based rule |
| 3 | How does k6 test per-IP limits? | **Spoof `X-Forwarded-For`**, one address per VU; the rule aggregates on that header |
| 4 | Authorised tiers | ~~Two: `normal` and a higher `partner`~~ **Reversed 2026-11-10: one, `normal`.** The `partner` plan, its 10 keys and `partner_rate_limit_rps` were removed for simplicity. The test needs only authorised and non-authorised callers |
| 5 | Is a rate-limit 429 a failed request? | **No**, for every tier. It is counted on its own |
| 6 | How many partner callers? | ~~10~~ **Removed 2026-11-10** with the partner tier |
| 7 | Is the WAF behind a switch? | **Yes**, `anonymous_enabled`, default off. No switch for partners: their limit variable is the knob |
| 8 | WAF evaluation window | **A variable**, `anonymous_window_seconds`, default 60 |
| 9 | Which tiers send in a run? | A k6 setting (`TIERS`), not infrastructure, so one run changes one infrastructure thing |

Rejected (so it is not re-proposed):

- **A shared bucket for all anonymous callers** (a method throttle on a public route). It costs nothing,
  but it is one limit for everyone, so one noisy anonymous caller blocks the rest.
- **A Lambda authorizer that returns a shared "anonymous" key.** Same shared bucket, plus an extra Lambda
  on every request.

## 3. Which limiter returns what

| situation | status the client sees | source | counted as |
|---|---|---|---|
| keyed caller above its usage-plan limit | 429 | API Gateway | rate limited (expected) |
| any caller above the stage or account throttle | 429 | API Gateway | rate limited (expected) |
| anonymous caller above the WAF per-IP limit | 429 | WAF | rate limited (expected) |
| Lambda refuses an invocation (reserved concurrency full) | **500** | API Gateway | **failure** |
| DynamoDB read throttled, function errors | **500** | the function | **failure** |
| route needs a key and none was sent | 403 | API Gateway | failure (a test bug) |

The first design already records that a Lambda throttle reaches the client as 500 (the alert summary
in `infra/grafana/alerts.tf` says so). So **a capacity problem is never a 429**, and no new code is
needed to keep them apart. The only ambiguity left is between the three 429 sources.

**Marking a rate-limit 429.** Every rate-limit 429 carries the header `x-throttle`:

- API Gateway: `aws_api_gateway_gateway_response` of type `THROTTLED`, with
  `response_parameters = { "gatewayresponse.header.x-throttle" = "'apigw'" }`.
- WAF: the rule's block action uses `custom_response` with status 429 and the header
  `x-throttle: waf`.

A 429 without `x-throttle`, and every 5xx, stays a failure.

## 4. Design

### 4.1 Routes: a public copy of each route

A usage plan counts a call only when the method has `api_key_required = true`. A method without it
ignores any key that is sent. So anonymous callers need their own routes.

- Keep the three keyed routes as they are.
- Add a `/public` prefix with the same three routes (`/public/items/{pk}/{sk}`, `/public/feeds/{pk}`,
  `/public/reports/{pk}`), `api_key_required = false`, the same Lambda alias.
- The service strips the prefix before routing, or the integration maps it. The plan decides which;
  stripping in the service needs one test.
- The latency classes and SLO thresholds are the same on both prefixes, so one run can compare tiers.

### 4.2 Keyed tiers: two usage plans

| plan | keys | limit variable | burst |
|---|---|---|---|
| `normal` | `normal-1` … `normal-4`, `noisy` | `user_rate_limit_rps` (exists) | 2 × rate |
| ~~`partner`~~ | removed 2026-11-10 | ~~`partner_rate_limit_rps`~~ | |

`0` on either variable means no throttle on that plan, as `user_rate_limit_rps = 0` does today. The
`load` key stays outside both plans, so the discovery profile is unaffected.

### 4.3 Anonymous tier: a WAF rate-based rule

- Created only when `anonymous_enabled = true` (`count`). When it is false, the web ACL, the `/public`
  routes and the association do not exist.
- `aws_wafv2_web_acl`, scope `REGIONAL`, associated with the REST API stage.
- One rule: `rate_based_statement`, `limit = anonymous_rate_limit`, `evaluation_window_sec = anonymous_window_seconds`, scoped down by a byte-match on the URI path starting with `/public/`, so keyed routes never
  count.
- `aggregate_key_type = "FORWARDED_IP"` with `forwarded_ip_config { header_name = "X-Forwarded-For",
  fallback_behavior = "MATCH" }` when `anonymous_ip_source = "forwarded"`; plain `"IP"` when it is
  `"source"`.
- Action `block` with `custom_response` 429 and the header `x-throttle: waf`.
- **`anonymous_ip_source = "forwarded"` is a test setting.** The rule then trusts the first address in
  `X-Forwarded-For`, and a client controls that address. With it a client can dodge the limit by
  changing the header. It stays `"forwarded"` in this lab only because k6 must act as many callers. The
  variable's description says so, and the README names it as a trap.
- A metric panel: `AWS/WAFV2` `BlockedRequests` for the rule, so the dashboard shows WAF blocks beside
  the Lambda throttles.

Limits of a WAF rate rule (AWS documents; verify at first deploy, section 8):

- The evaluation window is chosen from 60, 120, 300 or 600 seconds, and the limit has a minimum of 10
  requests per window. The smallest per-IP rate is therefore about 10 / 60 ≈ 0.17 RPS.
- Blocking starts some seconds after the limit is crossed. A few extra requests pass.
- The count is approximate. A WAF result says "an IP above the limit is blocked and the others are
  not". It does not give the exact pass count that a usage plan gives, and no document may claim it does.

### 4.4 k6

- **Rate-limit recognition.** After each request, if the status is 429 and `x-throttle` is present, add
  to a new counter `rate_limited{tier}` and **skip** `slo_available` and `slo_met` for that request. Any
  other 429, and any 5xx, is a failure as today. The custom `slo_available` and `slo_met` rates are
  already the gated thresholds, so this needs no change to the thresholds themselves. Check whether any
  threshold reads `http_req_failed`, which counts every 429 as failed (a k6 fact in `CLAUDE.md`).
- **Anonymous callers.** A new library function builds the header
  `X-Forwarded-For: 10.0.<hi>.<lo>` from a **caller index** (1 to `A`). **Corrected 2026-11-10, while
  writing the plan:** the first draft said "one VU is one caller". That needs one scenario per caller,
  and k6 gives every scenario at least 5 VUs, so 20 anonymous and 10 partner callers would need more
  than the 100-VU cap. Instead each tier is one scenario at the summed rate; every iteration picks a
  caller index at random, and the index selects the API key (partner) or the address (anonymous).
  Each caller then still sees Poisson arrivals at its own rate.
- **Tags.** `tier` = `normal` | `partner` | `anonymous` on every request, next to the existing `user`.
- **New profile `tiers.js`.** Arrival rates per tier, random arrivals as in the first design (4 × rate,
  thinned). `TIERS` (for example `TIERS=partner,anonymous`) chooses which tiers send; the default is all.
  Proposed shape: 4 normal callers at the normal rate, 1 noisy caller at 5 × the normal rate,
  10 partner callers at a higher rate, 20 anonymous callers (20 VUs, 20 addresses) with a few of them
  sending above the anonymous limit. The rates come from calibration (section 6), not from this spec.
- The 100-VU cap in `arrivals.js` splits across tiers, as `noisy-neighbour.js` already splits it. The
  plan sets the split.

### 4.5 Keys and the scripts

`api_keys` output grows by `partner-1` … `partner-10`. `upload-k6.sh` and `lib/env.js` read the new keys
and pass them as `-e` values. New flags: `--partner-rate`, `--anon-rate`. They are listed in
`loadtest.md`.

## 5. Observability and results

- `results.md` and `loadtest.md`: the column `429 % normal / noisy` becomes `rate-limited % by tier`
  (`normal / noisy / partner / anonymous`). The first row stays as it is; a one-line note says the column
  changed on 2026-11-10.
- Dashboard: one panel of WAF blocked requests in the row "3 · Lambda concurrency", or a new row
  "Rate limiting". The plan chooses.
- No new alert rule. Rate limits that work are not an incident.

## 6. Sizing

The rule in section 6.4 of the first design becomes: the load that should pass is the sum over the
callers of what each may send, and it must stay within the requests per second that 20 reserved
slots carry at B ≤ 0.5% (the Erlang B blocking target):

```
passing load = 4 normal users × (0.8 × per-key limit) + the per-key limit (the noisy user's share)
             + anonymous callers × per-address limit  ≤  requests per second at 20 slots
```

The anonymous callers number 20 in `tiers.js`; `--anon-callers` changes it. All limits come from
calibration after `capacity.js` and the discovery run, as before. (2026-11-10: the partner term was
removed with the partner tier.) This spec does not set any number.

## 7. Cost, lifecycle and teardown

- WAF adds a web ACL and a rule. List price, US East, from the AWS WAF FAQ and the AWS cost example for
  Security Automations (checked 2026-11-10, not the `eu-central-1` price): web ACL 5 USD per month, rule
  1 USD per month, 0.60 USD per million requests inspected. The fixed part is 6 USD per month, about
  0.20 USD per day, and runs while the ACL exists. The ACL is on the whole stage, so keyed requests
  count too. The 2026-11-10 test cost under 1 cent (ACL up under 1 hour, about 500 requests).
  `aws_wafv2_web_acl` accepts tags, so `default_tags` covers it.
- Destroy order: the association first, then the web ACL. Terraform does this on its own.
- The README teardown sweep adds `AWS::WAFv2::WebACL` to the check.
- The README "Configuration notes that bite" gets two entries: the forwarded-header trap, and that a
  WAF count is approximate.

## 8. Unverified, to settle on first deploy

1. **The first address in `X-Forwarded-For` is the one the rule uses**, and API Gateway appends the real
   source address to the right of what the client sent. If this is wrong, k6 cannot act as many
   callers and the design falls back to the shared bucket.
2. **WAF accepts a custom response header on a block action** in the Terraform provider version pinned
   here.
   **Verified 2026-11-10:** the block returned `429` with `x-throttle: waf`.
3. **`gatewayresponse.header.x-throttle`** appears on both usage-plan and stage throttles.
   **Verified 2026-11-10 for the usage-plan throttle:** with `partner_rate_limit_rps = 1`, 1 of 30
   sequential curl calls returned 429 with `x-throttle: apigw`. The stage throttle is not tested.
4. **A keyless call on `/public/…` reaches the Lambda with the same event shape**, so the path strip works.
   **Verified 2026-11-10:** a keyless `GET /public/items/feed-0000/item-0000` returned 200.
   **Trap found 2026-11-10:** WAF sees the path as `/<stage>/public/...`. A `STARTS_WITH "/public/"` scope-down never matched and 100+ calls were allowed. The rule uses `CONTAINS`.
   **Verified 2026-11-10 (item 1):** with `FORWARDED_IP`, `X-Forwarded-For: 10.0.0.1` was blocked while `10.0.0.2` stayed at 200. API Gateway appends the real address (`10.0.0.1, <real>`); the first one is used.
5. **WAF blocking lag** with a 60 s window, measured with `tiers.js`.
   **Measured 2026-11-10 with curl, not `tiers.js`** (the cloud run gave no summary): limit 10 per 60 s, 2.5 requests per second from a new address; the first 429 came at request 37, 25 s in. Blocking starts about 27 requests after the limit is crossed. A rule change also needs more than 60 s to take effect.
6. Current WAF prices. **Settled 2026-11-10** from the AWS FAQ and cost example (US East); the
   figures are in section 7. The AWS Pricing Calculator holds the `eu-central-1` price.

## 9. Switches

| switch | where | default | meaning |
|---|---|---|---|
| `user_rate_limit_rps` | `dev.tfvars` | 0 | `normal` plan limit; 0 = no throttle (exists) |
| `partner_rate_limit_rps` | `dev.tfvars` | 0 | `partner` plan limit; 0 = no throttle |
| `anonymous_enabled` | `dev.tfvars` | false | creates the WAF, the `/public` routes and the association |
| `anonymous_rate_limit` | `dev.tfvars` | set by calibration | requests per IP per window (minimum 10) |
| `anonymous_window_seconds` | `dev.tfvars` | 60 | 60, 120, 300 or 600 |
| `anonymous_ip_source` | `dev.tfvars` | `forwarded` | `forwarded` (test only) or `source` |
| `TIERS` | `tiers.js` env | all | which tiers send in a run |

Remaining open point: the exact split of the 100 VUs between tiers in `tiers.js`. The plan sets it
from the arrival rates and the mean latency, as `noisy-neighbour.js` does.

## 10. Out of scope

Real authentication (an API key still identifies a test user only), WAF managed rule groups, bot
control, and per-IP limits on the keyed routes.
