# ecs-rds-postgres-pool verification map

This directory is the maintained source for verifying the user-facing behavior of the deployed ecs-rds-postgres-pool service: Node.js on ECS behind an ALB, with RDS PostgreSQL (directly, or through RDS Proxy when `database_target = proxy`). The `/verify` skill (`.claude/skills/verify/SKILL.md`) drives it. Read this index first, then use the matching feature file as the recipe.

## Baseline preconditions

- The environment is up: `/env up ecs-rds-postgres-pool`, then `./scripts/deploy-service.sh`.
- The seed has run, through `seed_on_boot` or `./scripts/seed.sh`. Feeds have ids `1`..`16` (`seed_feeds`), and post ids start at `1`.
- Attach with `eval "$($V attach ecs-rds-postgres-pool)"; export VERIFY_RUN`, where `V=.claude/skills/verify/scripts/verify.sh`, from the repo root.
- `$V doctor` prints only `ok` lines. Its probe is `GET /posts/1`, which needs the database. `/healthz` does not need it.
- No load test is running. A verification request during a `/loadtest` run changes the measured numbers.

## Driving conventions

- Start every recipe from the baseline state.
- Use route paths as handles. They come from `ROUTES` in `service/src/routes.js`.
- Make every HTTP call through `$V req <label> ...`, so it is recorded. Use a label of the form `<feature-id>-<step>`.
- Read a write back through `GET /posts/:id`. The database is in a private subnet, so there is no direct read from the laptop.
- Writes add posts. Nothing deletes them, and they raise `SELECT count(*) FROM posts`, which every `results.md` row records. So write only what the recipe needs.

## Proof and skip reporting

- HTTP proof is the evidence file: method, URL, body, status, headers and response.
- Mutation proof adds a read-back of the new post through `GET /posts/:id`.
- Record the feature ID with every artifact (the label prefix).
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a write as verified when only its response was captured.

## Feature entry contract

Each feature file has an H1 title and a paragraph. Then it has exactly these H2 sections, in this order:
1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it with verify.sh`
4. `Gotchas`

## Features

- [Health check](./health.md) covers `GET /healthz` and unmatched routes.
- [Read a post](./get-post.md) covers `GET /posts/:id` for a hit, a miss and a bad id.
- [Create a post](./create-post.md) covers `POST /posts` and its read-back.
- [Read a feed](./feed.md) covers `GET /feeds/:id/posts` summaries.
- [Run a report](./report.md) covers `POST /reports`: the scan and the post it inserts.
