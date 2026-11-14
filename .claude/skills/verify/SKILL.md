---
name: verify
description: Prove the behavior of a project's DEPLOYED environment in this repo (ecs-dynamodb-rps, ecs-rds-postgres-pool, lambda-concurrency-limit) by driving its real HTTP API with curl and recording request, response and stored-state evidence, from the project's verify/ feature map. Use after /env up and deploy-service.sh, to check a change end to end before a /loadtest, or when asked to "verify" a project. It never starts or stops infrastructure.
---

# /verify <project>

This skill drives the **deployed** environment only. There is no local mode, by the user's decision on 2026-11-14. It reads `terraform output` and never runs `apply` or `destroy`: `/env up|down` owns the environment and its approval gate.

The skill is shared, and each project owns its contract, as `/loadtest` does with `loadtest.md`:

| file | owner | holds |
|---|---|---|
| `.claude/skills/verify/scripts/verify.sh` | shared | attach, doctor, req, ddb-get, cleanup |
| `<project>/verify/target.sh` | project | `PROBE_PATH`, and `TABLE_NAME` / `AUTH_HEADER` if it has them, read from `$TF_OUT` |
| `<project>/verify/README.md` | project | baseline preconditions and the feature index |
| `<project>/verify/<feature>.md` | project | one recipe per user-facing feature |

Projects that have a map now: `ecs-dynamodb-rps`, `ecs-rds-postgres-pool` and `lambda-concurrency-limit`. A new project adds its own `verify/` directory. Do not add a branch for it in `verify.sh`.

Run everything from the repo root. `$V` below means `.claude/skills/verify/scripts/verify.sh`.

## Launch

There is nothing to launch. Do these steps:

1. Confirm that the environment is up with `/env status <project>`. If it is down, stop. Tell the user that `/env up <project>` and `./scripts/deploy-service.sh` are needed. Do not run them unasked: they create billable resources.
2. Attach:

```bash
V=.claude/skills/verify/scripts/verify.sh
eval "$($V attach <project>)"; export VERIFY_RUN
```

`attach` does these steps:
- It runs `terraform init` once if `infra/main/.terraform` is missing.
- It reads `terraform output -json` and takes `base_url` from it.
- It sources `<project>/verify/target.sh`.
- It writes `$VERIFY_RUN/state.env` (mode 600), in a new run directory under `${TMPDIR}/verify/<project>-<time>-<pid>/`.

If there is no `base_url`, it refuses with "the environment is down". The `.env` secrets must be loaded. The SessionStart hook does that.

## Doctor

```bash
$V doctor
```

This check is read-only. It requires `GET <PROBE_PATH>` to return 200. The probe is a seeded record, so it proves the data path and not only `/healthz`. When the project has a DynamoDB table, the table must also be `ACTIVE`. Run doctor first, and again when a result looks wrong. If any line is `FAIL`, do not drive the environment. Check `/env status` and the project's deploy step.

## Drive

```bash
$V req <label> <METHOD> <path> [json-body]   # one call → evidence/<label>.txt, also printed
$V ddb-get <label> <pk> <sk>                 # consistent read from the project's table → evidence/<label>.txt
```

- `req` sends the project's `AUTH_HEADER` (the Lambda `x-api-key`). `VERIFY_NO_AUTH=1` leaves it out. `VERIFY_HEADER='Name: value'` adds one header.
- Read `<project>/verify/README.md` first. Then follow the feature file step by step, with the exact commands and expected results that it gives.
- Run nothing while a `/loadtest` runs on the same project. Verification traffic changes the measured numbers.

## Evidence

Everything goes to `$VERIFY_RUN/evidence/`. Each `req` file has the method, URL, request body, whether a key was sent (never the key itself), status, UTC time, response headers and response body.

Proof standards:
- Use the real public routes only, through the ALB or API Gateway. Do not invoke the Lambda directly and do not call internal endpoints.
- Capture the action and the result. For a write, also capture a second view of the stored state, with `ddb-get` or with the read-back that the feature file names.
- A step whose precondition is not met (a knob off in `dev.tfvars`, for example) is reported as **not run**, with the precondition. It is never reported as passed through another path.
- An SLO, latency or RPS number does not come from this skill. Use `/loadtest`.

## Cleanup

```bash
$V cleanup
```

This run started no process and no resource, so cleanup only writes `cleanup.log` and keeps the whole run directory, including `evidence/`. Writes stay in the disposable environment until `/env down <project>`. To remove old evidence, delete the run directories under `${TMPDIR}/verify/` by hand.

## Helpers

`scripts/verify.sh` (executable, bash). It needs `terraform`, `jq`, `curl` and `aws` CLI v2, with the root `.env` credentials. `VERIFY_ROOT` overrides the parent directory of the run directories. The default is `${TMPDIR:-/tmp}/verify`.

`target.sh` contract: it is sourced by `attach`, and `$TF_OUT` holds the `terraform output -json` text. It must set `PROBE_PATH`. It may set `TABLE_NAME` and `AUTH_HEADER`. It may `exit 1` with a message when an output it needs is missing.

`$V lint <project>` checks the shape of `<project>/verify/` offline: `target.sh` parses and sets
`PROBE_PATH`, `README.md` has `## Features` and links every feature file, and each feature file has
the 4 H2s in order and a `Preconditions:` line. The git pre-commit hook runs it on every directory
with `infra/main`, so a new project cannot be committed without a valid map. It does not prove that
a recipe is true; only a run against the live environment does.

To keep the maps current as the services change, use `/pstack:maintain-verification-skill`, pointed at `<project>/verify/`.
