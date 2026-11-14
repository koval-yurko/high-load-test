# Health check

The service answers `GET /healthz` with `{"ok":true}`, and it touches no database. The ALB target group uses this route. A path that matches no route returns 404.

## Sub-features

- `health-ok` returns 200 `{"ok":true}`.
- `health-unmatched` returns 404 for an unknown path or a wrong method.

## How to get to it (user POV)

- The ALB health check or a person calls `GET /healthz`.
- A scanner or a client calls a path that does not exist.

## Driving it with verify.sh

Preconditions:

- The baseline preconditions are met, and `$V doctor` passes.

- **Health.** Run `$V req health-ok GET /healthz`. Status `200`, and the body is `{"ok":true}`.
- **Unknown path.** Run `$V req health-unmatched GET /nope`. Status `404`.
- **Wrong method.** Run `$V req health-method POST /healthz`. Status `404`, because the routes match on method too.

## Gotchas

- `/healthz` passes even when the pool cannot reach PostgreSQL. Do not use it as proof that the data path works. Use `get-post.md`.
- A `502` or `503` comes from the ALB, not from the service. It means that no healthy task is registered, for example because a task exits at boot when the migrations or TLS fail. Check `/env status ecs-rds-postgres-pool`.
