# Read a feed

`GET /feeds/{pk}` returns every item of one partition as `{"items":[...]}`. It returns 404 when the partition is empty.

## Sub-features

- `feeds-full` returns the 20 seeded items of a feed.
- `feeds-empty` returns 404 for a partition with no items.

## How to get to it (user POV)

- A test user with an API key, or the `standard` share of the k6 load profiles, calls `GET /feeds/<pk>`.

## Driving it with verify.sh

Preconditions:

- The baseline preconditions are met. `feed-0000` holds `item-0000`..`item-0019`.

- **Full feed.** Run `$V req feeds-full GET /feeds/feed-0000`. Status `200`. Then check the count: `sed -n '/^{/p' "$VERIFY_RUN/evidence/feeds-full.txt" | jq '.items | length'` prints `20`.
- **Empty feed.** Run `$V req feeds-empty GET /feeds/feed-9999`. Status `404`, and the body is `{"error":"not found"}`.

## Gotchas

- Unlike the ECS projects, an empty feed is a 404 here, not a 200 with `count 0`.
- The count follows `ITEMS_PER_FEED` of the last seed. A seed that is larger than the defaults gives more than 20 items.
