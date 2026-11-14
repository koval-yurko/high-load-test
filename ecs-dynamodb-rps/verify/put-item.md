# Write an item

`POST /items` creates a new item with a server-generated key and a TTL. It returns 201 with the stored record.

## Sub-features

- `put-item-create` returns 201 with `pk` (`w#<id>`), `sk`, `payload` and `expires_at`.
- `put-item-stored` makes the same record readable from DynamoDB and through `GET /items/:pk/:sk`.

## How to get to it (user POV)

- A client, or the write share of the k6 load profiles, calls `POST /items`. The request body is ignored.

## Driving it with verify.sh

Preconditions:

- The baseline preconditions are met.

- **Create.** Run `$V req put-item-create POST /items`. Status `201`. The body has a `pk` that starts with `w#`, an `sk`, a `payload` and an `expires_at` about 3600 s from now.
- **Keep the key.** Run `R=$(sed -n '/^{/p' "$VERIFY_RUN/evidence/put-item-create.txt"); PK=$(jq -r .pk <<<"$R"); SK=$(jq -r .sk <<<"$R")`.
- **Stored, read from DynamoDB.** Run `$V ddb-get put-item-stored "$PK" "$SK"`. The `Item` exists, and its `payload` is the same as the HTTP response.
- **Stored, read through the API.** Run `$V req put-item-readback GET "/items/$(jq -rn --arg s "$PK" '$s|@uri')/$SK"`. Status `200` with the same record.

## Gotchas

- **Known failure (seen 2026-11-14 against the local service, same code in ECS):** the API read-back returns `404`. `matchRoute` in `src/handlers.js` does not URL-decode route params, so the lookup uses `w%23<id>` and not `w#<id>`. A raw `#` does not work either, because it starts a URL fragment. Report this step as failed with that reason. The `ddb-get` step is the proof that the write is stored. Do not drop this step: it passes once the params are decoded.
- The body of the POST is ignored. Sending your own `pk` does not choose the key.
- The table's TTL deletes the item some time after `expires_at`. Read it back within the hour.
