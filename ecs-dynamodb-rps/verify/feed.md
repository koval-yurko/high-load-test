# Read a feed

`GET /feeds/:pk` queries one partition, a page of up to `FEED_PAGE_SIZE` items (default 20). It returns a summary: `count`, total payload `bytes`, and the `first` and `last` sort keys in descending order.

## Sub-features

- `feed-full` returns the summary of a seeded partition.
- `feed-empty` returns a zero summary for a partition with no items.

## How to get to it (user POV)

- A client, or the read-heavy part of the k6 load profiles, calls `GET /feeds/<pk>`.

## Driving it with verify.sh

Preconditions:

- The baseline preconditions are met. `feed-00` holds `item-00`..`item-19`.

- **Full feed.** Run `$V req feed-full GET /feeds/feed-00`. Status `200`. The body has `"count":20`, `"first":"item-19"`, `"last":"item-00"` and `bytes` greater than 0.
- **Empty feed.** Run `$V req feed-empty GET /feeds/feed-99`. Status `200`, and the body is `{"count":0,"bytes":0,"first":null,"last":null}`.

## Gotchas

- An absent partition is a 200 with `count 0`, not a 404. Do not treat it as a failure.
- `count` is capped at `FEED_PAGE_SIZE`. A partition with more items still shows 20.
