# Create a post

`POST /posts` inserts one post into a random seeded feed with a single `INSERT ... RETURNING`. It returns 201 with the new `id` and its `feedId`.

## Sub-features

- `create-post-insert` returns 201 with `id` and `feedId`.
- `create-post-stored` makes the new post readable through `GET /posts/:id`.

## How to get to it (user POV)

- A client, or the write share of the k6 load profiles, calls `POST /posts`. The request body is ignored.

## Driving it with verify.sh

Preconditions:

- The baseline preconditions are met.

- **Insert.** Run `$V req create-post-insert POST /posts`. Status `201`. The body has a numeric `id` and a `feedId` between `1` and `16`.
- **Read back.** Run `ID=$(sed -n '/^{/p' "$VERIFY_RUN/evidence/create-post-insert.txt" | jq -r .id); $V req create-post-stored GET "/posts/$ID"`. Status `200`. The body has the same `id` and `feedId`.

## Gotchas

- The feed is random. Do not expect a given `feedId`. Compare the read-back with the insert response.
- Every insert raises the post count that `results.md` records. Insert once per verification, not in a loop.
