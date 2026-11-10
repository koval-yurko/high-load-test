# lambda-concurrency-limit — results

Each row is one `/loadtest` run: the profile, the one infra change that distinguishes it from the
previous row and what the run measured. A row is
comparable only with rows on the same seed (the `seed` column). How each column is read:
`loadtest.md`.

| date | profile | infra change | seed | λ target | RPS | k6 attainment (lat / avail) | throttle % | rate-limited % normal / noisy / anonymous | p95 fast/std/heavy | p99 fast/std/heavy | Duration avg / export avg | cold starts | consumed RCU | ddb throttles | reserved / provisioned | otel | k6 run |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-09 | discovery (aborted at 30 RPS step, availability < 99%) | SMOKE, not capacity: rate_source=default. First run; reserved 20, provisioned 0, 512 MB | 6000 items, seeded 2026-11-09T16:46:38Z | n/a (default 10→120 step 10) | 14.2 avg (about 26 in last minute) | 97.8% / 98.1% (availability gate 99% breached) | 2.20 (126 / (126+5602)) | n/a / n/a | 58 all classes (per class not read) | 120 all classes (per class not read) | n/a (alias dimension returned no data) / n/a | 20 | 8923 | 0 | 20 / 0 | on | [8982330](https://k0valchuk.grafana.net/a/k6-app/runs/8982330) |
| 2026-11-09 | discovery (all 12 steps to 120 RPS, passed) | reserved concurrency 20 → 100 (provisioned 0, 512 MB). SMOKE, not capacity: rate_source=default | 6000 items, seeded 2026-11-09T16:46:38Z | n/a (default 10→120 step 10) | 62.0 avg (about 120 at the last step) | n/a (not run) | 0.00 (0 / (0+93828)) | n/a / n/a | 44 all classes (per class not read) | 100 all classes (per class not read) | n/a (alias dimension returned no data) / n/a | 94 | 150308 | 0 | 100 / 0 | on | [8982600](https://k0valchuk.grafana.net/a/k6-app/runs/8982600) |

Settings at 2026-11-09, after this row (not a run): `user_rate_limit_rps = 0` (per-user limit off, the knob 1
baseline) and `reserved_concurrency = 100` in `infra/main/dev.tfvars`, while the row above ran at reserved 20.
The last `terraform apply` reported no changes, so 100 is probably live. Read `terraform output -json knobs`
before the next run and put the real value in the `reserved / provisioned` column.

Column change, 2026-11-10: `429 % normal / noisy` became `rate-limited % normal / noisy / anonymous` (the partner tier was dropped the same day).
A rate-limited request is a 429 that carries the header `x-throttle` (`apigw` or `waf`); any other 429 is a
failure. The first row keeps its value in the first two slots and `n/a` in the others.
