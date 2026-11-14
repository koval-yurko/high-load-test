# Read an item

`GET /items/:pk/:sk` returns one stored item as JSON. It returns 404 when the key does not exist.

## Sub-features

- `get-item-hit` returns 200 with the item for an existing key.
- `get-item-miss` returns 404 `{"error":"not found"}` for an absent key.

## How to get to it (user POV)

- A client, or the k6 load profiles in `ecs-dynamodb-rps/infra/k6/tests/`, calls `GET /items/<pk>/<sk>`.

## Driving it with verify.sh

Preconditions:

- The baseline preconditions are met. The seeded item `feed-00/item-00` exists.

- **Hit.** Run `$V req get-item-hit GET /items/feed-00/item-00`. Status `200`. The body has `"pk":"feed-00"`, `"sk":"item-00"` and a `payload` string.
- **Same item from the store.** Run `$V ddb-get get-item-store feed-00 item-00`. The `Item` has the same `pk`, `sk` and `payload` as the HTTP body.
- **Miss.** Run `$V req get-item-miss GET /items/feed-00/item-99`. Status `404`, and the body is `{"error":"not found"}`.

## Gotchas

- The seed has `item-00`..`item-19` only. `item-20` and higher are misses.
- A `pk` that contains `/` cannot be addressed, because the route splits on `/`. Server-written keys (`w#<id>`) cannot be read through this route at the moment: `%23` is not decoded, and a raw `#` is a URL fragment. See `put-item.md`.
