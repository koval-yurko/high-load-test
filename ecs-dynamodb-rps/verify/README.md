# ecs-dynamodb-rps verification map

This directory is the maintained source for verifying the user-facing behavior of the deployed ecs-dynamodb-rps service: Node.js on ECS behind an ALB, with a DynamoDB table. The `/verify` skill (`.claude/skills/verify/SKILL.md`) drives it. Read this index first, then use the matching feature file as the recipe.

## Baseline preconditions

- The environment is up: `/env up ecs-dynamodb-rps`, then `./scripts/deploy-service.sh`, which builds, rolls, seeds and checks health.
- The table holds the seed: `feed-00`..`feed-49`, each with `item-00`..`item-19`.
- Attach with `eval "$($V attach ecs-dynamodb-rps)"; export VERIFY_RUN`, where `V=.claude/skills/verify/scripts/verify.sh`, from the repo root.
- `$V doctor` prints only `ok` lines. Its probe is `GET /items/feed-00/item-00`, and it checks that the table is `ACTIVE`.
- No load test is running. A verification request during a `/loadtest` run changes the measured numbers.

## Driving conventions

- Start every recipe from the baseline state.
- Use route paths as handles. They come from `ROUTES` in `service/src/handlers.js`.
- Make every HTTP call through `$V req <label> ...`, so it is recorded. Use a label of the form `<feature-id>-<step>`.
- Read stored state through `$V ddb-get`. Never trust a write response alone.
- Writes add items with a 1-hour TTL. They do not change seeded items, so you do not need to restore anything.

## Proof and skip reporting

- HTTP proof is the evidence file: method, URL, body, status, headers and response.
- Mutation proof adds a read-only second view of the stored item.
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
- [Read an item](./get-item.md) covers `GET /items/:pk/:sk` for a hit and a miss.
- [Write an item](./put-item.md) covers `POST /items` and its stored side effect.
- [Read a feed](./feed.md) covers `GET /feeds/:pk` summaries for full and empty partitions.
- [Run a report](./report.md) covers `POST /reports`: read, CPU digest and the record it writes.
