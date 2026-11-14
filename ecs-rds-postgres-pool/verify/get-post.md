# Read a post

`GET /posts/:id` returns one post as JSON. It returns 404 when the id does not exist and 400 when the id is not a positive integer.

## Sub-features

- `get-post-hit` returns 200 with the post.
- `get-post-miss` returns 404 `{"error":"not found"}`.
- `get-post-bad-id` returns 400 `{"error":"id must be a positive integer"}`.

## How to get to it (user POV)

- A client, or the `fast` class of the k6 load profiles, calls `GET /posts/<id>`.

## Driving it with verify.sh

Preconditions:

- The baseline preconditions are met. Post `1` exists.

- **Hit.** Run `$V req get-post-hit GET /posts/1`. Status `200`. The body has `"id":1` and a `feedId` between `1` and `16`.
- **Miss.** Run `$V req get-post-miss GET /posts/2000000000`. Status `404`, and the body is `{"error":"not found"}`.
- **Bad id.** Run `$V req get-post-bad-id GET /posts/abc`. Status `400`, and the body is `{"error":"id must be a positive integer"}`.

## Gotchas

- The bad-id check runs before the pool is used, so a 400 proves nothing about the database.
- Ids are a PostgreSQL `Int`. A value above `2147483647` is out of range, so keep the miss id below it.
