# Read a feed

`GET /feeds/:id/posts` reads one page of a feed (`FEED_PAGE_SIZE` rows). It returns a summary: `count`, total body `bytes`, the `top` post id by score, and the `feed` name.

## Sub-features

- `feed-page` returns the summary of a seeded feed.
- `feed-empty` returns `count 0` for a feed id with no posts.
- `feed-bad-id` returns 400 for an id that is not a positive integer.

## How to get to it (user POV)

- A client, or the `standard` class of the k6 load profiles, calls `GET /feeds/<id>/posts`.

## Driving it with verify.sh

Preconditions:

- The baseline preconditions are met. Feed `1` has seeded posts.

- **Seeded feed.** Run `$V req feed-page GET /feeds/1/posts`. Status `200`. The body has `count` greater than 0, `bytes` greater than 0, a numeric `top` and `"feed":"feed-01"`.
- **Empty feed.** Run `$V req feed-empty GET /feeds/999/posts`. Status `200`, and the body is `{"count":0,"bytes":0,"top":null,"feed":null}`.
- **Bad id.** Run `$V req feed-bad-id GET /feeds/abc/posts`. Status `400`.

## Gotchas

- The path ends in `/posts`. `GET /feeds/1` is an unmatched route and returns 404.
- An absent feed is a 200 with `count 0`, not a 404.
