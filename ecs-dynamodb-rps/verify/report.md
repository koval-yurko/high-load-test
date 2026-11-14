# Run a report

`POST /reports` reads a feed page and burns CPU on a PBKDF2 digest (`PBKDF2_ITERATIONS`, set by the task definition). Then it writes one new record. It returns `pk`, `count`, `digest` and `recordId`.

## Sub-features

- `report-default` uses `feed-00` when the body has no `pk`.
- `report-pk` reports on the `pk` in the body.
- `report-write` stores one new record whose `sk` is `recordId`.

## How to get to it (user POV)

- A client, or the CPU-heavy share of the k6 load profiles, calls `POST /reports` with a JSON body `{"pk":"feed-NN"}`.

## Driving it with verify.sh

Preconditions:

- The baseline preconditions are met.

- **Report on a feed.** Run `$V req report-pk POST /reports '{"pk":"feed-03"}'`. Status `200`. The body has `"pk":"feed-03"`, `"count":20`, a `digest` string and a `recordId`.
- **Default feed.** Run `$V req report-default POST /reports '{}'`. Status `200` and `"pk":"feed-00"`.
- **Bad JSON.** Run `$V req report-badjson POST /reports '{'`. Status `500` and `{"error":"invalid json"}`.
- **Record written.** Run `RID=$(sed -n '/^{/p' "$VERIFY_RUN/evidence/report-pk.txt" | jq -r .recordId); . "$VERIFY_RUN/state.env"; aws dynamodb scan --table-name "$TABLE_NAME" --filter-expression 'sk = :s' --expression-attribute-values "{\":s\":{\"S\":\"$RID\"}}" --output json | tee "$VERIFY_RUN/evidence/report-write.txt"`. The output has `Count` 1, and its `pk` starts with `w#`.

## Gotchas

- The response does not include the `pk` of the written record. Only a scan on `sk` finds it. `ddb-get` cannot find it.
- The scan reads the whole table and uses its provisioned read capacity. Never run it during a load test: it can cause the throttles that the test measures.
- Malformed JSON returns 500, not 400. That is the current behavior, so record it and do not report it as a failure of this run.
