# lambda-concurrency-limit verification map

This directory is the maintained source for verifying the user-facing behavior of the deployed lambda-concurrency-limit API: an API Gateway REST API with API keys, a Lambda with reserved concurrency, and a DynamoDB table. An optional `/public` tier has a WAF limit. The `/verify` skill (`.claude/skills/verify/SKILL.md`) drives it. Read this index first, then use the matching feature file as the recipe.

## Baseline preconditions

- The environment is up: `/env up lambda-concurrency-limit`, then `./scripts/deploy-service.sh`. Until the first deploy, the function is a placeholder that answers 503.
- The table holds the seed from `service/scripts/seed.js`: `feed-0000`..`feed-0199` with `item-0000`..`item-0019` each, and `report-000`..`report-019` with `row-0000`..`row-0099` each (the defaults).
- Attach with `eval "$($V attach lambda-concurrency-limit)"; export VERIFY_RUN`, where `V=.claude/skills/verify/scripts/verify.sh`, from the repo root. `attach` reads the `x-api-key` of user `normal-1` from `terraform output api_keys`. Set `VERIFY_USER=noisy` (or `normal-2`..`normal-4`) before `attach` to act as another user.
- `$V doctor` prints only `ok` lines. Its probe is `GET /items/feed-0000/item-0000` with the key, and it checks that the table is `ACTIVE`.
- No load test is running. A verification request during a `/loadtest` run changes the measured numbers.

## Driving conventions

- Start every recipe from the baseline state.
- Use API Gateway resource paths as handles. They come from `infra/main/api.tf` and the `routes` map in `service/src/handler.js`.
- Make every HTTP call through `$V req <label> ...`, so it is recorded. `req` sends the key. Set `VERIFY_NO_AUTH=1` for a call without it.
- Every route is a read, so there is nothing to restore.

## Proof and skip reporting

- HTTP proof is the evidence file: method, URL, status, headers and response. The key itself is not written, only `x-api-key sent`.
- A read is also checked against the store with `$V ddb-get` where the recipe says so.
- Record the feature ID with every artifact (the label prefix).
- Report an unreachable path with the attempted command and the unmet precondition, for example a knob that is off in `infra/main/dev.tfvars`.

## Feature entry contract

Each feature file has an H1 title and a paragraph. Then it has exactly these H2 sections, in this order:
1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it with verify.sh`
4. `Gotchas`

## Features

- [Read an item](./items.md) covers `GET /items/{pk}/{sk}`, the `fast` class.
- [Read a feed](./feeds.md) covers `GET /feeds/{pk}`, the `standard` class.
- [Run a report](./reports.md) covers `GET /reports/{pk}`, the `heavy` class.
- [Access and limits](./access.md) covers the API key, the per-user rate limit and the anonymous `/public` tier.
