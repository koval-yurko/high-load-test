# lambda-concurrency-limit

A Node.js Lambda (arm64, Node 22) behind an API Gateway REST API, reading DynamoDB, built so that
**the function's reserved concurrency is the binding constraint**, then released one knob at a time.

**The question it answers:** when a Lambda hits its concurrency limit, what do the three fixes — a
per-user rate limit, more reserved concurrency, provisioned concurrency — each do to SLO attainment,
and for whom? Each knob is a separate apply and a separate row in `results.md`, measured with the
identical k6 profile. A Lambda throttle reaches the client as API Gateway's 500, so throttling shows up
as lost availability.

Full design: `docs/superpowers/specs/2026-11-09-lambda-concurrency-limit-design.md`. Infrastructure
plan: `docs/superpowers/plans/2026-11-09-lambda-concurrency-limit-infra.md`.

**Nothing is deployed.** Region `eu-central-1`. The AWS account is shared: its concurrency limit is
400 and 352 of that is unreserved (read 2026-11-09). AWS keeps 100 unreserved, so this function can
reserve at most 352 − 100 = **252**; `variables.tf` enforces it. Other apps run from the same pool, so
the function always reserves its own slice and a load test cannot drain the pool. Idle cost is about
zero: no VPC, no NAT, nothing always-on.

## Where to look

URLs come from `terraform output`, never from this file.

| open | then |
|---|---|
| `terraform -chdir=infra/main output -json grafana_dashboard_url` | the dashboard **lambda-concurrency-limit** in folder `high-load-test / lambda-concurrency-limit`. Rows 1 requests, 2 SLI evidence, 3 concurrency, 4 Duration and cold starts, 5 provisioned concurrency, 6 DynamoDB |
| `terraform -chdir=infra/main output -json cloudwatch_dashboard_url` | the AWS-side view of where the Lambda time goes |
| [alert rules][alerts] | folder `high-load-test / lambda-concurrency-limit` → group **lambda-concurrency-limit / concurrency and capacity** — see [4. Is it about to break?](#4-is-it-about-to-break) |
| [Tempo][traces] | saved TraceQL query `{resource.service.name="lambda-concurrency-limit"}` — see [Reading a trace](#reading-a-trace) |
| [k6][k6] | the project **lambda-concurrency-limit** → its tests and runs since the last `/env up` (the project is destroyed with the environment) |

---

## 1. Is the service up?

| check | where |
|---|---|
| Is traffic arriving? | Grafana dashboard → row 1 → **Requests** |
| What is answered, and how? | Grafana dashboard → row 1 → **4xx and 5xx** |

**Good:** almost all 2xx. A 429 with the header `x-throttle` is a rate limit working (knob 1); it is never a miss. A 429 without it is a failure.

**Bad:** a run of 5xx. Check [3. What is the bottleneck?](#3-what-is-the-bottleneck) first: a
throttled Lambda answers 500 for a capacity reason, not a code bug.

## 2. Are we meeting the SLO?

**k6 is the only SLI.** `slo.yaml` sets two objectives: 95% of judged requests under their class
threshold (fast, standard, heavy), and 99% availability (status < 500). The run's own k6 summary is the
authoritative attainment, over the run's window.

Grafana shows evidence, not a verdict: row 2 draws the 5xx fraction against the availability budget
and each route's p95 against its class threshold (API Gateway `Latency` p95). The availability burn
alerts run on the 5xx fraction. There is **no server-side latency burn alert**: API Gateway gives no
per-class latency distribution, and one threshold on a blended p95 would hide the mix. So the results
have one attainment column (k6), not two. The class thresholds are **provisional** (`frozen: false` in
`slo.yaml`) until phase 0 freezes them; changing one invalidates every earlier result.

## 3. What is the bottleneck?

Read two things side by side:

| question | where |
|---|---|
| Is the function at its reserved limit? | Grafana dashboard → row 3 → **ConcurrentExecutions vs reserved**, and **Throttles** |
| Is the table throttling? | Grafana dashboard → row 6 → **DynamoDB ReadThrottleEvents** |

`Throttles` is in neither `Invocations` nor `Errors`, so the throttle share is
`Throttles ÷ (Throttles + Invocations)`.

**The trap:** a DynamoDB throttle first shows as a longer `Duration` (the SDK retries), and a longer
`Duration` raises concurrency. So concurrency can hit the limit *because* the table throttled. Check
`ReadThrottleEvents` before blaming concurrency; a knob run made while it is above zero is invalid.

## Reading a trace

The function runs with two layers: the OTel Node.js layer (instruments the handler and the AWS SDK) and
the OTel collector extension (receives spans, batches them, exports to Grafana Cloud over OTLP/HTTP).
Both are switched by `otel_enabled`; the sampling ratio is `trace_sample_ratio`.

1. Open [Tempo][traces]. The time range is the last hour; set it to the run's window.
2. Run `{resource.service.name="lambda-concurrency-limit"}`.
3. Sort by duration, open the slowest row, and click the DynamoDB span: it carries the table name in
   `aws.dynamodb.table_names`.

The collector's `decouple` processor lets the response return **before** the export, so the export is
not in the latency the client sees. It still runs inside the execution environment, so it is billed and
holds the concurrency slot: it is in CloudWatch `Duration` and in `PostRuntimeExtensionsDuration`.
Span names for DynamoDB are **not yet verified**; plan 3 copies them from a real trace. Auto
instrumentation does not cover the handler's CPU loop on the heavy route. Keep `trace_sample_ratio`
identical across runs being compared: tracing runs inside the function under test.

## 4. Is it about to break?

Group **lambda-concurrency-limit / concurrency and capacity**:

| rule | fires when |
|---|---|
| Availability fast burn | 5xx fraction over 1 h is above 14.4 × the 1% budget |
| Availability slow burn | 5xx fraction over 6 h is above 6 × the 1% budget |
| Lambda throttles | `Throttles` > 0 for 2 minutes. Expected in knob runs past the Erlang B rate; anywhere else it is a finding |
| Shared pool in danger | the account's `UnreservedConcurrentExecutions` is above 176, 50% of 352 (account-wide, so another app can cause it) |
| DynamoDB read throttles | `ReadThrottleEvents` > 0: the database binds, so a knob run made now is invalid |
| Provisioned concurrency left on | only exists while `provisioned_concurrency > 0`; see below |

The last rule **cannot see idle provisioned concurrency**: with no traffic the metric is not published,
so an environment left idle with the knob on raises no alert. The phase 9 teardown is the backstop.

---

# Runbook

## Where everything lives

| what | how to get it |
|---|---|
| API URL | `terraform -chdir=infra/main output -json base_url` (new on every rebuild) |
| API keys | `terraform -chdir=infra/main output -json api_keys` — `load`, `normal-1..4`, `noisy` |
| Function, alias, table | outputs `function_name`, `alias_name` (`live`), `table_name` |
| Knobs as applied | `terraform -chdir=infra/main output -json knobs` |
| k6 project id | `terraform -chdir=infra/main output -json k6_project_id` |
| State | Terraform Cloud workspace `lambda-concurrency-limit` |

Handler routes: `GET /items/{pk}/{sk}` (fast), `GET /feeds/{pk}` (standard), `GET /reports/{pk}` (heavy).

## The knob sequence

One `dev.tfvars` line per knob, one apply, then the **identical** k6 profile re-run. Never change the
profile to chase a passing run.

| phase | change | `dev.tfvars` line | `deploy-service.sh --config-only` after the apply? | profile |
|---|---|---|---|---|
| 0. Calibrate | two edits: `otel_enabled = false`, apply, `--config-only`, run; then `true`, apply, `--config-only`, run. Then freeze thresholds and rates | `otel_enabled = false`, then `true` | **yes**, after each apply | `constant`, low rate, once per edit |
| 1. Baseline | none; reserved 20, no per-user limit | — | no | `discovery`, `constant`, `noisy-neighbour` |
| 2. Knob 1 | rate limits per tier | `user_rate_limit_rps = <requests per second per key>`, `anonymous_enabled = true` with `anonymous_rate_limit = <requests per address per window>` | no | `noisy-neighbour`, `tiers` |
| 3. Knob 2 | reserved concurrency | `reserved_concurrency = 100` | no | `constant` at about 300 RPS (not C = 100's 404 RPS capacity), then `discovery` |
| 4. Knob 3 | provisioned concurrency | `provisioned_concurrency = <warm instances>` | no | `spike` |
| 5. Knob 4 | DynamoDB read capacity | `max_read_request_units = <reads per second>` (on-demand cap), or `billing_mode = "PROVISIONED"` with `read_capacity = <reads per second>` | no | `discovery`: the RPS where `ddb throttles` first rises |

The rate limits and the warm-instance count come from measured runs, not from guessing. Run
`discovery` and take the highest RPS where the SLO still holds; set the limits below it. The warm-instance count is the number of requests in flight at the spike peak, and at most
`reserved_concurrency`.
**Knob 3 barely moves attainment.** It buys the cold-start tail (p99 and max), not the average, and the
spike is not a scaling-rate test: the AWS-documented scaling rate of 1,000 environments per 10 seconds
(AWS "Lambda scaling behavior", from the spec's sources; not measured here) cannot show at a ceiling
of 252. Set `provisioned_concurrency` back to 0 right after phase 4.

**Knob 4 shows where DynamoDB, not Lambda, sets the RPS ceiling.** The ceiling is about the read cap divided
by the read units one request uses (`consumed RCU` divided by the request count of a run gives that
cost; `/reports` costs the most). Below it the cap changes nothing. Above it requests fail with 500 and
`ReadThrottleEvents` rises. Fix: raise the cap, or set `max_read_request_units = null` (on-demand, no cap).
Rows with a cap or `PROVISIONED` say `exploration` and are compared only with each other, never with
the knob 1 to 3 rows, which run on-demand with no cap. `sdk_max_attempts` stays exploration.

## What each test proves

Knobs live in `infra/main/dev.tfvars`. A 429 **with** `x-throttle` means a rate limit worked. A bare
429 and every 5xx are failures. Apply a knob first, then run the profile.

| knob | variable | what it limits | client sees |
|---|---|---|---|
| normal user limit | `user_rate_limit_rps` | requests per second per normal key | 429 + `x-throttle: apigw` |
| anonymous limit | `anonymous_enabled`, `anonymous_rate_limit`, `anonymous_window_seconds` | requests per address per window (WAF) | 429 + `x-throttle: waf` |
| Lambda concurrency | `reserved_concurrency` | parallel executions | 500; CloudWatch `Throttles` |
| DynamoDB capacity | `billing_mode`, `read_capacity`, `max_read_request_units` | reads per second | 500; CloudWatch `ReadThrottleEvents` |
| warm Lambdas | `provisioned_concurrency` | cold starts only | none, only slower |

**Authorised limit (normal keys).** Set `user_rate_limit_rps = 20`, apply, then
`./scripts/upload-k6.sh --only tiers --tiers normal,noisy --normal-rate 10 --noisy-rate 60 --run`.
Pass: `rate_limited{tier:noisy}` is high, `rate_limited{tier:normal}` is 0, the normal SLO holds. Each key has its own limit.

**Anonymous limit.** Set `anonymous_enabled = true`, `anonymous_rate_limit = 60`, window 60 (1 request
per second per address). Run `--tiers anonymous --anon-rate 2`: expect `rate_limited{tier:anonymous}`
and 429 with `waf`. Run `--anon-rate 0.5`: expect about 0. Blocking starts about 27 requests late
(measured 2026-11-10), so do not use a limit under 60 for a precise test. Set `anonymous_enabled =
false` afterwards: the WAF bills while it exists.

**DynamoDB as the bottleneck.** Set `max_read_request_units = 10` in `dev.tfvars` (a cap on on-demand
reads, not tested yet; `null` means no cap) and apply. Run `constant` above what the cap allows. Expect `ReadThrottleEvents`
above 0 and 500 responses; `/reports` reads the most. Fix: raise or remove the cap, or use
`PROVISIONED` with a higher `read_capacity`. A recordable run needs 0 DynamoDB throttles, so this is an
exploration row.

**Reserved concurrency as the bottleneck.** Set `reserved_concurrency = 20`, apply, run `constant` or
`discovery` above about 90 RPS (20 slots at about 0.22 s mean duration). Expect `Throttles` above 0 and
500 responses, not 429. Fix: set it back to 100.

**Choosing the callers.** `tiers.js` takes a rate per caller, not a VU count. Choose who sends:
- `--tiers normal,noisy,anonymous` (a comma list): authorised users are `normal` and `noisy`, keyless
  callers are `anonymous`. `--tiers anonymous` sends only keyless requests.
- `--normal-callers N` (1 to 4 keyed users) and `--anon-callers N` (keyless addresses, default 20).
  One address at a high rate (`--anon-callers 1 --anon-rate 5`) shows the WAF limit most clearly.
- `--normal-rate` (10), `--noisy-rate` (60) and `--anon-rate` (1) are per caller.
The VUs come from the rate, with caps 20, 20 and 30 (at most 100 in total).

## Configuration notes that bite

- **An alias freezes its version.** A published version freezes environment variables, memory and
  layers. After an apply that changes `otel_enabled`, `trace_sample_ratio`, `otel_layer_version`,
  `memory_size`, `timeout_seconds`, `heavy_cpu_iterations` or `sdk_max_attempts`, alias `live` still runs the old
  settings: run `./scripts/deploy-service.sh --config-only`. Symptom: the knob changed and the numbers
  did not. `./scripts/deploy-service.sh --check` says whether `live` matches `$LATEST`.
- **100 VUs is the load-generator cap.** `vus(rate, cap)` in `infra/k6/tests/lib/arrivals.js` sizes the
  VUs. A run needs rate × mean client latency (requests in flight) ≤ the scenario's VUs, or
  `dropped_iterations` fails the run and the service did not cause it. So knob 2 runs at about
  300 RPS, not C = 100's 404 RPS capacity, and the spike peak is at most about 80 RPS (each request
  in the cold-start head holds a VU for about 1 s, against the surge scenario's 80 VUs). Details in [`loadtest.md`](loadtest.md).
- **`anonymous_ip_source = "forwarded"` is a test setting.** The WAF rule then counts the first address
  in `X-Forwarded-For`, and the client controls that address: a real client can dodge the limit by
  changing the header. It stays on only so k6 can act as 20 callers. `"source"` counts the real address.
- **A WAF count is approximate.** The window is 60 s or more, the minimum limit is 10 per window, and
  blocking starts some seconds late, so a few extra requests pass. The WAF bills while it exists:
  about 6 USD per month (ACL 5 + rule 1), 0.20 USD per day, plus 0.60 USD per million requests (US East
  list price, 2026-11-10). `anonymous_enabled = false` except while measuring.
- **Usage-plan throttling is best-effort.** AWS: usage plan limits "are not hard limits". The per-user
  limit can let a few extra requests through. `noisy-neighbour` is invalid if the judged user got any
  429.
- **Provisioned concurrency bills per hour** while the resource exists. Set it to 0 and apply right
  after phase 4.
- **DynamoDB rations billing-mode changes.** Provisioned → on-demand at most 4 times in a rolling 24 h;
  provisioned capacity decreases: 4 available, +1 per hour, 27 per day, so step RCU upward.
- **API keys are baked into the k6 archives.** They identify test users, not authentication, but the
  archives hold them.
- **The CloudWatch dashboard is not tagged** (the Terraform resource has no tags argument), so the tag
  sweep cannot see it. Phase 9 checks it by name.
- **A re-apply from scratch changes the URL and the keys.** Run `./scripts/upload-k6.sh` again, or a UI
  run hits the old address.
- **`reserved_concurrency` takes effect at apply**; no deploy is needed.
- **Grafana alert rules fail at apply, not at plan.** Grafana rejects the annotation `__dashboardUid__`
  without `__panelId__` (HTTP 400: "both annotations … must be specified"). `terraform plan` does not
  call that API, so it cannot show the error. Both keys live in `local.dashboard_link` in
  `infra/grafana/alerts.tf`. Change them together.

## Run it locally

There is no local loop for the function behind API Gateway. `(cd service && npm test)` covers the
handler with a mocked DynamoDB client, and the k6 library and SLO generator.

## Phase 0 — Setup (already done once)

The scripts read credentials with `direnv exec <repo root>` from the root `.env`. That file is
git-ignored, so run everything from a checkout that has one; a fresh worktree does not.

```bash
cp .env.example .env                                             # repo root: AWS, Terraform Cloud, Grafana, k6 tokens; fill it in
direnv allow                                                     # repo root; again after every .env edit
terraform -chdir=platform apply                                  # repo root, once per account; approval gate
cd lambda-concurrency-limit
(cd service && npm ci)                                           # deploy-service.sh runs npm test in service/
terraform -chdir=infra/main init
terraform -chdir=infra/main apply -var-file=dev.tfvars           # approval gate
./scripts/deploy-service.sh                                      # test, build, publish, move alias live
(cd service && TABLE_NAME=$(direnv exec ../.. terraform -chdir=../infra/main output -json | jq -r .table_name.value) direnv exec ../.. npm run seed)
./scripts/upload-k6.sh
```

Until the first deploy, the function is a placeholder and answers 503. The seed writes the table and a
manifest item (`seed-manifest.json` locally). **A re-run is additive:** it rewrites the same keys and
only grows the data; a smaller seed than the one recorded is refused, and so is a different
`ITEM_BYTES`. To shrink it, re-create the table. Seed shape comes from `FEEDS`, `ITEMS_PER_FEED`,
`REPORTS`, `ITEMS_PER_REPORT`, `ITEM_BYTES`.

| symptom | cause |
|---|---|
| `terraform apply` fails on `reserved_concurrency` | above 252, or other apps reserved more: re-read `aws lambda get-account-settings` |
| the knob changed, the numbers did not | version-frozen setting: `deploy-service.sh --config-only` |
| seed: `cannot follow` | the seed is smaller or a different item size than the recorded one |

## Phase 1 — Is it alive?

```bash
curl -H "x-api-key: $(direnv exec .. terraform -chdir=infra/main output -json api_keys | jq -r .load)" \
  "$(direnv exec .. terraform -chdir=infra/main output -raw base_url)/items/feed-0000/item-0000"
```

Expect 200. A 503 is the placeholder: the deploy did not run. A 403 is a missing or wrong key.

## Phase 2 — Run a load test

| shape | file | what it is for |
|---|---|---|
| **discovery** | `infra/k6/tests/discovery.js` | steps the rate up; the knee is the lowest step whose threshold breached |
| **constant** | `infra/k6/tests/constant.js` | holds at the target rate: the repeatable before/after profile |
| **spike** | `infra/k6/tests/spike.js` | jumps to a peak: the cold-start shape for knob 3 |
| **noisy-neighbour** | `infra/k6/tests/noisy-neighbour.js` | one user sends far more than the others: the shape for knob 1 |

Arrivals are random, not even: each profile thins a `constant-arrival-rate` executor so throttles
match Erlang B. Even arrivals understate them.

**Upload first.** A UI run executes the archive stored in the cloud, never the file on disk:

```bash
./scripts/upload-k6.sh --check          # what is uploaded, and is it stale?
./scripts/upload-k6.sh                  # all four, at provisional default rates
./scripts/upload-k6.sh --rate <n> --peak-rate <n> --normal-rate <n> --noisy-rate <n>   # frozen rates
./scripts/upload-k6.sh --only discovery --start-rate 10 --step-rps 5 --max-rate 60 --run   # discovery, 10 to 60 RPS in steps of 5, then start it
```

Flags per profile are in [`loadtest.md`](loadtest.md).

**Run gate.** The run is not recordable unless: `ReadThrottleEvents` was 0 over the last 10 minutes;
`./scripts/deploy-service.sh --check` says the alias is current; and provisioned concurrency is READY
if on. The exact commands are in [`loadtest.md`](loadtest.md).

Start the run from [k6][k6] → the project → the test, or from a terminal:

```bash
k6 cloud run --summary-export=/tmp/summary.json infra/k6/tests/constant.js; echo "k6 exit $?"
```

Capture the exit code on the k6 line itself, not behind a pipe: 0 = every threshold held, 99 = at least
one breached, 97 = the cloud run was aborted for another reason. In `--summary-export`, a threshold's
boolean is *was it breached*: `true` = failed. `http_req_failed` uses `.value`.

## Phase 3 — Read the result

Set the dashboard time range to the run's window.

| question | where |
|---|---|
| Did the SLO hold? | [k6][k6] → the run: `slo_met` and the threshold results (k6 is the only SLI) |
| Was the function throttled? | Grafana dashboard → row 3 → **Throttles** and **ConcurrentExecutions vs reserved** |
| Was the table the constraint? | Grafana dashboard → row 6 → **DynamoDB ReadThrottleEvents** |
| Where did the time go? | Grafana dashboard → row 4 → **Duration and OTel export**, **Cold starts** |
| Which request was slow? | [Tempo][traces] → [Reading a trace](#reading-a-trace) |
| Did the alerts fire? | [alert rules][alerts] |
| Did the shared pool suffer? | Grafana dashboard → row 3 → **Account UnreservedConcurrentExecutions** |

## Phase 4 — Improve: per-user rate limit (knob 1)

Set `user_rate_limit_rps = <requests per second per key>` in `dev.tfvars`, then:

```bash
terraform -chdir=infra/main plan  -var-file=dev.tfvars
terraform -chdir=infra/main apply -var-file=dev.tfvars     # approval gate
```

No deploy is needed. Expect the normal users' SLO to pass while the noisy user takes the 429s.

## Phase 5 — Re-measure identically

Re-run `noisy-neighbour` with the same rates. Same scripts, same thresholds.

## Phase 6 — Improve: reserved, then provisioned concurrency (knobs 2 and 3)

Knob 2: `reserved_concurrency = 100`, plan, apply (approval gate). Knob 3, last:
`provisioned_concurrency = <warm instances>`, plan, apply (approval gate), `./scripts/deploy-service.sh --config-only` to
wait for READY (a full deploy rebuilds, publishes a new version and re-allocates provisioned
concurrency), then run `spike`; its peak is at most about 80 RPS (see the VU note above). Set it back to 0 and apply (approval gate) straight after.

## Phase 7 — Re-measure again

Knob 2: `constant` at about 300 RPS, then `discovery`; the "before" row is the same `constant`
profile run at C = 20. Knob 3: `spike`.

## Phase 8 — Record the results

Append one row per run to `results.md` (`/loadtest` does this). Every figure needs the run that produced
it: the k6 summary or the CloudWatch query. The columns, and the completeness rule, are in
[`loadtest.md`](loadtest.md). A result is never "N RPS": it is "N RPS at the 70/25/5 mix".

## Phase 9 — Tear down

```bash
terraform -chdir=infra/main destroy -var-file=dev.tfvars       # approval gate

aws resourcegroupstaggingapi get-resources --region eu-central-1 \
  --tag-filters Key=Project,Values=lambda-concurrency-limit \
  --query 'ResourceTagMappingList[].ResourceARN' --output table

aws cloudwatch list-dashboards --region eu-central-1 --dashboard-name-prefix lambda-concurrency-limit

aws wafv2 list-web-acls --scope REGIONAL --region eu-central-1 --query 'WebACLs[?starts_with(Name, `lambda-concurrency-limit`)].Name'   # must be empty: WAF bills while it exists
```

The dashboard list must be empty: the dashboard is untagged, so the tag query cannot see it. Then the
`/env` billable-resource sweep, and a check by name for the log group and the Grafana Cloud k6 project.

---

## Cost

Estimates only; none queried from a price list.

| item | rate | source |
|---|---|---|
| API Gateway REST | about $3.50 per million requests | estimate; illustrative: a 10-minute run at 400 RPS is 240,000 requests (400 × 600). 400 is about the C = 100 example rate from the spec (about 404 RPS at 0.2 s), not a measured rate |
| Lambda, DynamoDB on-demand | cents per session | estimate |
| API Gateway method-level metrics | cents per session | estimate |
| Provisioned concurrency | about $0.75 per hour for 100 × 0.5 GB | estimate, x86 price; arm64 not verified |
| Idle | about 0 | no VPC, no NAT, nothing always-on |

The real risk is provisioned concurrency left on: $0.75 × 730 h ≈ $550 a month at that size.

## Known gaps

- **No server-side latency SLI.** API Gateway gives no per-class latency; k6 judges latency. A run
  started without k6 has no latency verdict.
- **The per-user view lives in the k6 app only.** CloudWatch has no per-key breakdown here.
- **`Query` RCU rounding is not verified** (total or per item); phase 0 reads `ConsumedReadCapacityUnits`
  per request class.
- **Thinning gives a coefficient of variation of 0.87, not 1.** Arrivals are close to Poisson, not
  exactly; Erlang B predictions are slightly pessimistic.
- **The server-side metric commands in `loadtest.md` are not yet run against a live environment.**
- **Provisioned-concurrency alert blind spot** (see [4](#4-is-it-about-to-break)).

## Measured results

None yet. Nothing is deployed.

[alerts]: https://k0valchuk.grafana.net/alerting/list
[k6]: https://k0valchuk.grafana.net/a/k6-app/projects
[traces]: https://k0valchuk.grafana.net/explore?schemaVersion=1&orgId=1&panes=%7B%22a%22%3A%7B%22datasource%22%3A%22grafanacloud-traces%22%2C%22queries%22%3A%5B%7B%22refId%22%3A%22A%22%2C%22datasource%22%3A%7B%22type%22%3A%22tempo%22%2C%22uid%22%3A%22grafanacloud-traces%22%7D%2C%22queryType%22%3A%22traceql%22%2C%22query%22%3A%22%7B%20resource.service.name%20%3D%20%5C%22lambda-concurrency-limit%5C%22%20%7D%22%7D%5D%2C%22range%22%3A%7B%22from%22%3A%22now-1h%22%2C%22to%22%3A%22now%22%7D%7D%7D
