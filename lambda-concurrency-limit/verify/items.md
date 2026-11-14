# Read an item

`GET /items/{pk}/{sk}` returns one item from DynamoDB. It returns 404 `{"error":"not found"}` when the key does not exist.

## Sub-features

- `items-hit` returns 200 with the item.
- `items-miss` returns 404 for an absent key.

## How to get to it (user POV)

- A test user with an API key, or the `fast` share of the k6 load profiles, calls `GET /items/<pk>/<sk>`.

## Driving it with verify.sh

Preconditions:

- The baseline preconditions are met.

- **Hit.** Run `$V req items-hit GET /items/feed-0000/item-0000`. Status `200`. The body has `"pk":"feed-0000"`, `"sk":"item-0000"` and a `body` string.
- **Same item from the store.** Run `$V ddb-get items-store feed-0000 item-0000`. The `Item` has the same `pk`, `sk` and `body`.
- **Miss.** Run `$V req items-miss GET /items/feed-0000/item-9999`. Status `404`, and the body is `{"error":"not found"}`.

## Gotchas

- A 500 `{"error":"internal"}` is a handler error, and a 500 without that body is a Lambda throttle that API Gateway passes on. At verification traffic, both are failures.
- The table may cap reads with `max_read_request_units` (10 per second in `dev.tfvars`). A few verification reads stay under it.
