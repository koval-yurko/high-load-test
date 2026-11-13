# lambda-concurrency-limit — results

One row per `/loadtest` run (columns in `loadtest.md`). Rows compare only on the same seed.

| date | profile | infra change | seed | λ target | RPS | k6 attainment (lat / avail) | throttle % | rate-limited % normal / noisy / anonymous | p95 fast/std/heavy | p99 fast/std/heavy | Duration avg / export avg | cold starts | consumed RCU | ddb throttles | reserved / provisioned | otel | k6 run |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-10 | discovery 480→600 | reserved 20 (baseline) | 6000 items, 2026-11-10 | n/a | 583 max | held (exit 0) | 0.00 † | n/a | n/a | n/a | 5.7 ms / n/a | 10 | 231,952 | 0 | 20 / 0 | off | [8991831](https://k0valchuk.grafana.net/a/k6-app/runs/8991831) |
| 2026-11-11 | discovery 200→440 | reserved 20 → 10 | 6000 items, 2026-11-10 | n/a | 417 max | avail broke at rps_400 | 0.60 † | n/a | n/a | n/a | 6.1 ms / n/a | 10 | 223,249 | 0 | 10 / 0 | off | [8998821](https://k0valchuk.grafana.net/a/k6-app/runs/8998821) |
| 2026-11-11 | constant 360 (baseline) | none (reserved 10, otel off) | 6000 items, 2026-11-10 | 360 | 360 | held (exit 0) | 0.37 † | n/a | n/a | n/a | 14.4 ms / n/a | 10 | 379,132 | 0 | 10 / 0 | off | [8998961](https://k0valchuk.grafana.net/a/k6-app/runs/8998961) |
| 2026-11-12 | constant 360 | otel off → on | 6000 items, 2026-11-10 | 360 | 23 served of 360 | failed (exit 99) | 92.9 † | n/a | n/a | n/a | 417 ms / 405 ms | 11 | 27,095 | 0 | 10 / 0 | on | [8999084](https://k0valchuk.grafana.net/a/k6-app/runs/8999084) |
| 2026-11-12 | noisy-neighbour (4 normal × 10 RPS + noisy 400 RPS) | user limit 0 → 1200 per 60 s (20 RPS per key, burst 1200); otel off; reserved 10 | 6000 items, 2026-11-10 | 440 offered | 440 delivered (26,400 req/min) | failed (exit 99): noisy hit the 52-VU cap (generator warning) | 0.14 (411 ÷ 290,313 requests) | n/a (not read) / ~95 (inferred) / n/a | n/a | n/a | 5.4 ms / n/a | 10 | 64,639 | 0 | 10 / 0 | off | [9003351](https://k0valchuk.grafana.net/a/k6-app/runs/9003351) |
| 2026-11-12 | noisy-neighbour (4 normal × 10 RPS + noisy 400 RPS) | user limit 1200 per 60 s → 0 (off); otel off; reserved 10 | 6000 items, 2026-11-10 | 440 offered | 440 delivered (26,400 req/min) | failed (exit 99): thresholds breached, which one not read | 1.41 (4,078 ÷ 289,942 requests) | n/a (not read) / 0 (no limit) / n/a | n/a | n/a | 5.1 ms / n/a | 11 | 457,256 | 0 | 10 / 0 | off | [9004294](https://k0valchuk.grafana.net/a/k6-app/runs/9004294) |
| 2026-11-12 | tiers, anonymous only (1 address × 2 RPS) | anonymous_enabled false → true, limit 60 per 60 s (1 RPS per address); user limit 0; reserved 10; otel off | 6000 items, 2026-11-10 | 2 offered | 2.0 (1,325 requests in 11 min) | passed (exit 0); the profile's only threshold on this tier is `rate>=0` | 0.00 (0 ÷ 1,325 requests) | n/a / n/a / 93.7 (1,241 WAF blocks ÷ 1,325, CloudWatch; k6 value not read) | n/a | n/a | 11.4 ms / n/a | 1 | 100 | 0 | 10 / 0 | off | [9006449](https://k0valchuk.grafana.net/a/k6-app/runs/9006449) |
| 2026-11-12 | tiers (4 normal × 10 + noisy 60 + 20 anonymous addresses × 0.5 RPS) | none vs run 9006449: anonymous limit 60 per 60 s on; user limit 0; reserved 10; otel off | 6000 items, 2026-11-10 | 110 offered | 110 (72,359 requests in 12 min) | passed (exit 0); the tier thresholds are `rate>=0` | 0.08 (60 ÷ 72,359 requests) | n/a / n/a / 0 (WAF blocked 0 of 72,359; k6 value not read) | n/a | n/a | 5.5 ms / n/a | 10 | 116,438 | 0 | 10 / 0 | off | [9006699](https://k0valchuk.grafana.net/a/k6-app/runs/9006699) |
| 2026-11-13 | discovery 100→300 (step 40), exploration | max_read_request_units null → 300 (on-demand cap, exploration); anonymous off; user limit 0; reserved 10 | 6000 items, 2026-11-10 | n/a | 300 max (18,033 requests in the last full minute) | held (exit 0) | 0.02 (26 ÷ 146,106 requests) | n/a | n/a | n/a | 8.0 ms / n/a | 10 | 233,278 | 0 | 10 / 0 | off | [9010694](https://k0valchuk.grafana.net/a/k6-app/runs/9010694) |
| 2026-11-13 | discovery 10→50 (step 10), exploration, ended early | max_read_request_units 300 → 10 (on-demand cap, exploration); anonymous off; user limit 0; reserved 10 | 6000 items, 2026-11-10 | n/a | 20 held, run ended in the 30 RPS step (step from the schedule, not read from k6) | failed (exit 99); availability abort, per-step `slo_met` not read | 5.45 (228 ÷ 4,186 requests) | n/a | n/a | n/a | 4.7 ms before throttling / 275 ms in the throttled minute | 10 | 5,832 | 640 | 10 / 0 | off | [9011726](https://k0valchuk.grafana.net/a/k6-app/runs/9011726) |

| term | meaning | source |
|---|---|---|
| throttle % | Lambda throttles ÷ all requests the clients sent, whole run (rows marked † used throttles ÷ (throttles + invocations)) | CloudWatch `Throttles`, API Gateway `Count` |
| consumed RCU | DynamoDB read units used in the run window (1 read of up to 4 KB = 0.5 unit) | `ConsumedReadCapacityUnits` Sum |
| minutes 2-11 | a run without its warm-up minute | CloudWatch, per minute |

## 1 · Reserved concurrency 10: where it breaks

**Reserved 20 held 583 RPS with no throttle; reserved 10 breaks availability at 400 RPS.** Throttled share per RPS step (1 block = 0.1%; the budget is 1%)

```
200 RPS ▏                0%
240 RPS ▏                0.03%
280 RPS █                0.11%
320 RPS ██               0.25%
360 RPS ██████           0.58%
400 RPS ████████████     1.25%  <- availability broke (k6)
440 RPS █████████████████1.7%
```

## 2 · OTel on vs off

**OTel export keeps each slot busy for 405 ms, so capacity falls about 15 times.** Constant 360 RPS, reserved 10; invocations served per minute (1 block = 720)

```
off  ██████████████████████████████ 21,600 / min   Duration 14 ms
on   ██                              1,400 / min   Duration 417 ms (405 ms extension flush)
```

**Fix to test next: send metrics with CloudWatch EMF and traces with X-Ray active tracing, with no OTel layer.**

| signal | way | delay inside the invocation | change |
|---|---|---|---|
| metrics | CloudWatch EMF (JSON line to stdout) | none | small code change |
| traces | X-Ray active tracing (`tracing_config`) | none (the Lambda service sends the segments) | one Terraform setting |
| both, if OTLP to Grafana is required | OTel layer, `trace_sample_ratio` 0.05, `decouple` processor | smaller, not zero (inferred) | config; the export can arrive late or be lost |

Not measured: EMF, X-Ray and the sampled OTel layer have not been run; `decouple` support in layer `0_24_0` was not checked.

## 3 · Per-key limit on vs off (noisy-neighbour)

**The limit sheds the noisy key at API Gateway: the Lambda and DynamoDB see 1/7 of the load, 5xx falls from 1.25% to 0.02%.** 4 normal keys × 10 RPS + noisy key × 400 RPS = 440 RPS; minutes 2-11, average per minute; 1 block = 2.5% of requests

```
limit 1200 per 60 s  served █████ 13.6%
                     429    ███████████████████████████████████ 86.4%   <- shed at API Gateway, the Lambda never sees them
                     5xx    ▏ 0.02%   <- Lambda throttle
limit 0              served ████████████████████████████████████████ 98.8%
                     429    ▏ 0.0%
                     5xx    ▏ 1.25%   <- Lambda throttle, the 99.0% objective allows 1%
```

Whole run, same load (runs 9003351 and 9004294):

```
                          limit 1200        limit 0
Lambda invocations        40,562            285,864        7.0 times more without the limit
DynamoDB read units       64,639            457,256        7.1 times more without the limit
Lambda throttles          411               4,078          9.9 times more without the limit
```

Not measured: 5xx per normal key (needs `rate_limited` and `slo_met` per user from the two k6 run pages); both runs exit 99 and the failed threshold was not read.

## 4 · Anonymous tier: one address above the WAF limit

**One address at 2 RPS against a limit of 60 per 60 s: 84 of 1,325 requests allowed, then every request blocked.** Run 9006449; WAF per minute, 1 block = 5 requests

```
minute (UTC)  allowed by WAF           blocked by WAF
21:56         ████████████   59     ▏ 0
21:57         █████          25     ███████████████████ 96
21:58         ▏               0     ███████████████████ 97
21:59         ▏               0     ███████████████████████ 113
22:00         ▏               0     ████████████████████████ 121
22:01         ▏               0     ████████████████████████ 120
22:02         ▏               0     █████████████████████████ 124
22:03         ▏               0     ███████████████████████ 117
22:04         ▏               0     ████████████████████████ 119
22:05         ▏               0     █████████████████████████ 127
22:06         ▏               0     ████████████████████████████ 139
22:07         ▏               0     ██████████████ 68
```

| | requests | share |
|---|---|---|
| allowed (all reached the Lambda, 0 throttles, 0 5xx) | 84 | 6.3% |
| blocked by WAF (= API Gateway 4xx) | 1,241 | 93.7% |

Not measured: k6 `rate_limited{tier:anonymous}` and `x-throttle` counts; WAF release after a pause.

## 4b · Anonymous tier: 20 addresses below the limit

**20 addresses at 0.5 RPS each (half the limit): the WAF blocked 0 of 72,359 requests.** Run 9006699 beside run 9006449; share of the sender's requests blocked by the WAF (1 block = 2.5%)

```
sender rate per address       limit = 1 RPS (60 per 60 s)
0.5 RPS  (20 addresses)  ▏ 0%       0 blocked   (the WAF counts all 72,359 requests of the ACL, anonymous share about 6,600, inferred)
2 RPS    (1 address)     ████████████████████████████████████████ 93.7%   1,241 of 1,325 blocked
```

| run 9006699 | value |
|---|---|
| requests reaching API Gateway | 72,359 (about 110 RPS) |
| WAF blocked / API Gateway 4xx | 0 / 0 |
| Lambda throttles | 60, all in minute 1 (warm-up), 0.08% |
| keyed tiers (normal, noisy) | no 429 and no 5xx beyond those 60 |

Not measured: k6 `rate_limited` per tier (the exit 0 does not prove it); a sender at exactly 1 RPS.

## 4c · DynamoDB read cap 300: no throttle seen

**Read use passed the cap of 300 units per second from 13:06 (about 350 per second) and reached 473, but DynamoDB threw 0 `ReadThrottleEvents`.** Run 9010694, discovery 100 to 300 RPS; average units per second per minute (1 block = 12.5; `|` marks the cap)

```
UTC    offered   units per second (consumed read units ÷ 60)         units/s
13:00    71 RPS  █████████████          |                 161
13:01   100 RPS  █████████████          |                 164
13:02   110 RPS  █████████████████      |                 218
13:03   139 RPS  ██████████████████     |                 226
13:04   152 RPS  ███████████████████████|                 291
13:05   180 RPS  ███████████████████████|                 289
13:06   190 RPS  ███████████████████████|████             350
13:07   217 RPS  ███████████████████████|████             348
13:08   230 RPS  ███████████████████████|█████████        414
13:09   254 RPS  ███████████████████████|█████████        417
13:10   269 RPS  ███████████████████████|██████████████   473
13:11   301 RPS  ███████████████████████|████████████     444
```

| run 9010694 | value |
|---|---|
| cap set / read back from DynamoDB | 300 / `MaxReadRequestUnits: 300` |
| units per request | 1.6 (233,278 ÷ 146,106) |
| DynamoDB throttle events | 0 (no throttle metric of any kind has data) |
| Lambda throttles = API Gateway 5xx | 26 (0.02%), from 13:07, at 220 to 300 RPS |

Not measured: the per-second peak (CloudWatch gives per-minute sums); k6 per-step `slo_met`. A cap of 10 did bite: see 4d.

## 4d · DynamoDB read cap 10: it throttles, after a delay

**The cap works: after 3 minutes above it (the last 2 at 2.5 to 3 times), DynamoDB threw 639 throttles in one minute, Lambda duration rose from 4.7 to 275 ms, and concurrency hit 10.** Run 9011726, discovery 10 to 50 RPS, ended early; `|` marks the cap of 10 units per second (1 block = 2)

```
UTC    consumed units/s     units/s  ReadThrottleEvents  Lambda Duration avg
16:29  █   |              1.7      0       8.9 ms
16:30  ████|█            12.3      0       5.8 ms
16:31  ████|██           14.8      0       5.4 ms
16:32  ████|████████     25.0      0       4.7 ms
16:33  ████|██████████   30.2      1       4.7 ms
16:34  ████|██           13.3    639     274.8 ms
```

| read cap | consumed vs cap | throttle events |
|---|---|---|
| 300 (run 9010694) | 1.2 to 1.6 times for 6 minutes (350 to 473 units/s) | 0 |
| 10 (run 9011726) | 2.5 to 3 times for 2 minutes (25 to 30 units/s) | 640, all in the following 2 minutes |

Lambda throttles 228 in the same minute as the DynamoDB throttles (concurrency 10): the cause is inferred, not shown.

Not measured: the exact point where the cap starts to throttle (per-second peaks); the split of the 418 API Gateway 5xx between Lambda throttles and DynamoDB errors; k6 per-step `slo_met`.

## 5 · API Gateway limit vs WAF limit

**A usage plan is a speed limit; the WAF rule is a ban that lifts only when the address slows down.**

| | API Gateway usage plan (keyed users) | WAF rate rule (anonymous addresses) |
|---|---|---|
| Model | token bucket: refill 20 per second, burst 1200 | requests in the last 60 s |
| Does a blocked request count? | **no** | **yes** |
| Sender above the limit gets | about the refill rate | nothing, until its own rate is at or under the limit |
| Client sees | 429 + `x-throttle: apigw` | 429 + `x-throttle: waf` |

```
token bucket (API Gateway)         trailing window (WAF)
 sender > refill  -> some pass      blocked requests still count
 each request that finds a token    -> count stays above 60
 passes                             -> every request is blocked
 allowed per minute ~ the refill    allowed per minute -> 0
```

Reaching the Lambda per minute from one sender over its limit (different runs and loads: compare shapes, not numbers):

```
API Gateway, noisy key at 400 RPS, limit 1200 per 60 s (run 9003351)
requests of the noisy key that reached the Lambda per minute (1 block = 40)
min  2   ██████████████████████████       1053
min  3   ███████████████████████████      1073
min  4   ███████████████████████████████████ 1390
min  5   ████████████████████████████     1120
min  6   ██████████████████████████████   1207
min  7   ██████████████████████████████████ 1353
min  8   ███████████████████████████████  1223
min  9   ██████████████████████████       1025
min 10   █████████████████████████████    1165
min 11   ███████████████████████████████  1238
```

```
WAF, one address at 2 RPS, limit 60 per 60 s (run 9006449)
requests of the address that reached the Lambda per minute (1 block = 10)
min 21:56  ██████ 59     <- the first 60 before the count crosses the limit
min 21:57  ███ 25
min 21:58  ▏ 0
... every minute to 22:07: 0
```

Not measured: the API Gateway chart is Lambda `Invocations` minus the 2,400 per minute of the 4 normal keys (inferred); WAF behaviour tested only at 2 RPS.
