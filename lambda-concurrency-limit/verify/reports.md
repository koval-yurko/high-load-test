# Run a report

`GET /reports/{pk}` reads every row of one report partition and burns CPU (`heavy_cpu_iterations`). It returns `{"count":N,"digest":"..."}`, or 404 when the partition is empty.

## Sub-features

- `reports-hit` returns the row count and a digest.
- `reports-miss` returns 404 for an empty partition.

## How to get to it (user POV)

- A test user with an API key, or the `heavy` share of the k6 load profiles, calls `GET /reports/<pk>`.

## Driving it with verify.sh

Preconditions:

- The baseline preconditions are met. `report-000` holds `row-0000`..`row-0099`.

- **Report.** Run `$V req reports-hit GET /reports/report-000`. Status `200`. The body has `"count":100` and a `digest` string.
- **Miss.** Run `$V req reports-miss GET /reports/report-999`. Status `404`, and the body is `{"error":"not found"}`.

## Gotchas

- The route is a GET, not a POST as in the ECS projects, and it writes nothing.
- With `heavy_cpu_iterations = 0` (the `dev.tfvars` value), the digest costs almost no CPU. The latency then shows only the read of 100 rows.
- One report reads 100 items of about 1 KB. With `max_read_request_units = 10`, a few reports in a row can be throttled by DynamoDB. That shows as a slow response or a 500.
