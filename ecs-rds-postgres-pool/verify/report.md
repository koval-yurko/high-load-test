# Run a report

`POST /reports` is the heavy route. One data-modifying statement scans `REPORT_SCAN_ROWS` rows, aggregates them and inserts a post. It returns `feedId`, `scanned`, `bytes`, `feeds` and `recordId`, the id of the inserted post.

## Sub-features

- `report-feed` reports with the `feedId` from the body.
- `report-random` uses a random seeded feed when the body has no valid `feedId`.
- `report-write` makes the inserted post readable through `GET /posts/:id`.

## How to get to it (user POV)

- A client, or the `heavy` class of the k6 load profiles, calls `POST /reports` with a JSON body `{"feedId":N}`.

## Driving it with verify.sh

Preconditions:

- The baseline preconditions are met.

- **Report on a feed.** Run `$V req report-feed POST /reports '{"feedId":3}'`. Status `200`. The body has `"feedId":3`, `scanned` greater than 0 and a numeric `recordId`.
- **Random feed.** Run `$V req report-random POST /reports '{}'`. Status `200`, and `feedId` is between `1` and `16`.
- **Record written.** Run `RID=$(sed -n '/^{/p' "$VERIFY_RUN/evidence/report-feed.txt" | jq -r .recordId); $V req report-write GET "/posts/$RID"`. Status `200`, and the body has `"id":<RID>` and `"feedId":3`.

## Gotchas

- `scanned` is at most `REPORT_SCAN_ROWS` and at most the number of seeded rows. A small seed makes the report light, but it does not make it fail.
- This route holds one pool connection for the whole scan. Run it once, not in a loop, or you load the pool that the project measures.
