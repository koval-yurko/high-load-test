# Health check

The service answers `GET /healthz` with `{"ok":true}`, and it touches no database. The ALB target group uses this route. A path that matches no route returns a bounded 404.

## Sub-features

- `health-ok` returns 200 `{"ok":true}`.
- `health-unmatched` returns 404 `{"error":"no route"}` for an unknown path or a wrong method.

## How to get to it (user POV)

- The ALB health check or a person calls `GET /healthz`.
- A scanner or a client calls a path that does not exist.

## Driving it with verify.sh

Preconditions:

- The baseline preconditions are met, and `$V doctor` passes.

- **Health.** Run `$V req health-ok GET /healthz`. Status `200`, and the body is `{"ok":true}`.
- **Unknown path.** Run `$V req health-unmatched GET /nope`. Status `404`, and the body is `{"error":"no route"}`.
- **Wrong method.** Run `$V req health-method POST /healthz`. Status `404`, because the routes match on method too.

## Gotchas

- `/healthz` passes even when DynamoDB is broken. Do not use it as proof that the data path works. Use a read from `get-item.md`.
- A `502` or `503` comes from the ALB, not from the service. It means that no healthy task is registered. Check `/env status ecs-dynamodb-rps`.
- The admission gate never sheds `/healthz`. Other routes can answer `429` with `Retry-After` when the event loop is overloaded (`SHED_ELU_THRESHOLD`). That cannot happen at verification traffic, so a 429 here is a failure.
