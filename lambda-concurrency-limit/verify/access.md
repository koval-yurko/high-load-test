# Access and limits

The keyed routes need an `x-api-key` from the users usage plan. A per-key rate limit (knob 1) answers `429` with `x-throttle: apigw`. The optional anonymous tier serves the same routes under `/public` without a key, and a WAF rule per caller address limits it with `429` and `x-throttle: waf`.

## Sub-features

- `access-key` serves a request that has a valid key.
- `access-no-key` refuses a keyed route without a key, with 403.
- `access-user-limit` throttles one key above `user_rate_limit_requests` per window.
- `access-public` serves `/public/...` without a key when `anonymous_enabled = true`.
- `access-public-limit` throttles one address above `anonymous_rate_limit` per window.

## How to get to it (user POV)

- A test user sends its key, from `terraform output api_keys`, in `x-api-key`.
- An anonymous caller calls `/public/items/...`, `/public/feeds/...` or `/public/reports/...`.

## Driving it with verify.sh

Preconditions:

- The baseline preconditions are met.
- For the limit steps, `infra/main/dev.tfvars` has the knob on. The default `user_rate_limit_requests = 0` means that the user limit is off. The default `anonymous_enabled = false` means that `/public` does not exist. With the default values, report those steps as not run, and give that precondition as the reason.

- **With key.** Run `$V req access-key GET /items/feed-0000/item-0000`. Status `200`.
- **Without key.** Run `VERIFY_NO_AUTH=1 $V req access-no-key GET /items/feed-0000/item-0000`. Status `403`, and the body is `{"message":"Forbidden"}`.
- **User limit.** Run `L=$(terraform -chdir=lambda-concurrency-limit/infra/main output -json knobs | jq .user_rate_limit_requests)`. Then run `for i in $(seq 1 $((2*L+5))); do $V req access-user-limit-$i GET /items/feed-0000/item-0000 >/dev/null; done; grep -l 'status: 429' "$VERIFY_RUN"/evidence/access-user-limit-*.txt | head -1 | xargs grep -i x-throttle`. At least one call is `429` with `x-throttle: apigw`.
- **Public read.** Run `VERIFY_NO_AUTH=1 VERIFY_HEADER='X-Forwarded-For: 203.0.113.7' $V req access-public GET /public/items/feed-0000/item-0000`. Status `200`.
- **Public limit.** Repeat the public read `anonymous_rate_limit + 5` times from the same address. At least one call is `429` with `x-throttle: waf`.

## Gotchas

- A key identifies a test user only. It is not authentication (see `api_keys` in `infra/main/outputs.tf`).
- The user limit is a token bucket, not a fixed window. A key can send up to about twice the limit before the first 429.
- A 429 **without** `x-throttle` is a failure, not a working limit.
- The WAF counts over a window of `anonymous_window_seconds` and reacts after a delay. Wait up to that window for the first 429 before you report a failure.
- With `anonymous_ip_source = "forwarded"`, the client chooses the counted address through `X-Forwarded-For`. Use a different address for each run, or an earlier run can block the first request.
- The WAF bills while it exists. Set `anonymous_enabled` back to `false` after the check (`/env up` applies it).
