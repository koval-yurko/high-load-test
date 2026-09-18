# ecs-dynamodb-rps — provisioned capacity is set by hand, and the model advises

- **Date:** 2026-09-18
- **Status:** **approved** (2026-09-18, by the user) and **executed the same day** — the change is
  four files and needed no plan; see §6 for what was run.
- **Project directory:** `ecs-dynamodb-rps/`
- **Amends:** reverses the arrangement in which `read_capacity` / `write_capacity` were *generated*
  into `infra/main/capacity.auto.tfvars` from the `capacity:` block of `slo.yaml` and byte-checked by
  `npm run slo:check`. That arrangement was introduced by the 2026-08-29 ceiling design (its `/slo`
  skill definition, "Generated output 3") and reaffirmed on 2026-09-15 when the spike-response work
  deleted the two lines from `dev.tfvars` so the generated file would apply on its own
  (`docs/superpowers/specs/2026-09-15-ecs-dynamodb-rps-spike-response-design.md` §9, and Task 2 of
  its plan). Those documents carry forward-pointers here.

## 1. What changed, in one line

`ecs-dynamodb-rps/infra/main/dev.tfvars` now sets `read_capacity = 1025` and `write_capacity = 200`
itself; `capacity.auto.tfvars` is deleted; the capacity model still computes, and now only reports.

## 2. Why the old arrangement failed

The user's objection is the whole argument: provisioned capacity is the **largest line on the bill**
— $0.3212/hr for 1,025 RCU + 200 WCU, ~$234/month, billed identically idle or loaded — and it was
the one knob that could not be set where every other sizing knob is set. Opening `dev.tfvars` to see
what the environment costs showed five lines of commentary explaining that the number was somewhere
else.

Three things made the split worse than it looked:

1. **It never actually held.** A CLI `-var-file` outranks an auto-loaded `*.auto.tfvars`, so a value
   in `dev.tfvars` won anyway. The generated file did not prevent overriding; it only made an
   override *silent*, which is exactly how the table sat at 25/25 while the committed model said
   1025/200 (`.superpowers/sdd/2026-08-30-…/progress.md`, P1).
2. **The prohibition had to be restated everywhere**, because it was not enforced by the
   mechanism — in `dev.tfvars`, in the README, in two plans, in the skill. Five copies of "do not
   re-add these lines" is the shape of a rule fighting its substrate.
3. **Byte-checking made a deliberate deviation impossible to express.** Wanting 3,000 RCU for one run
   — to move the binding constraint off the table and measure the service instead — meant editing
   `slo.yaml`'s `target_rps`, which is an SLO document, to describe a temporary experiment.

## 3. Decision

| id | decision | choice |
|---|---|---|
| D1 | Where capacity is set | `infra/main/dev.tfvars`, by hand, beside `task_cpu` / `desired_count` |
| D2 | What `slo.yaml`'s `capacity:` block does now | Computes and **reports**; it is advisory |
| D3 | What a difference between the two means | A choice, annotated with its reason — **not** drift, and not a failure |
| D4 | What is still a hard failure | Capacity going **missing** — the variables have no default |
| D5 | `capacity.auto.tfvars` | Deleted, with its `.gitignore` negation |

**D2 is the reason this is not simply "delete the model".** Dropping the `capacity:` block was
considered and rejected: the arithmetic linking a target rps to a dollar figure
(0.55×0.5 + 0.25×2.5 + 0.05×2.5 = 1.025 RCU per request) is the only thing that says whether a number
someone typed is defensible. Keeping it as an advisory keeps the derivation without pretending it
outranks the operator.

**D4 matters because nothing supplies these variables any more.** `variables.tf` gives
`read_capacity` / `write_capacity` no default — deliberately, so capacity is never *guessed* — and
with the generated file gone a `dev.tfvars` that omits them stops the plan (or prompts, in an
interactive run). A service test asserts both are set.

## 4. What this does **not** change

- **TFC workspace variables and variable-set entries still outrank `dev.tfvars`.** That precedence is
  Terraform's, not this repo's, and it is what made a 2026-09-02 remote run return `No changes`
  while the files said 1025/200. Verified clean on 2026-09-18: workspace `ws-pPiZ7mfesjrzZ8sx` has
  **no** workspace variables, and the shared `high-load-test` variable set (Terraform-managed by
  `platform/`) defines none named for capacity. A capacity pin re-added there in the UI would
  silently win again, and would be invisible to `npm run slo:check`, which reads files.
- **Everything else `/slo` generates stays generated and byte-checked**: the k6 thresholds
  (`infra/k6/tests/lib/slo.js`), the class map, the Grafana alert rules, locals and queries. Nothing
  about the SLO-to-alert path is relaxed here — only capacity, and only because capacity is a
  purchasing decision rather than a definition.
- **A run at capacity that does not match the model is still reportable**, provided the difference is
  stated. What is not reportable is an RPS ceiling measured while the table was the binding
  constraint — the 25/25 warning in the README stands unchanged.

## 5. The advisory, as it prints

```
capacity (advisory -- dev.tfvars is authoritative):
  RCU dev.tfvars  3000  |  model  1025  (0.55*0.5 + 0.25*2.5 + 0.05*2.5 = 1.025/rps x 1000 rps)  <- differs
  WCU dev.tfvars   200  |  model   200  (0.15*1.0 + 0.05*1.0 = 0.200/rps x 1000 rps)
```

Printed by both `npm run slo:generate` and `npm run slo:check`, and printed **before** the drift
exit so a run failing on some other output still says what capacity is set to. It never contributes
to the exit code.

## 6. Verified

Run in this session, 2026-09-18:

- `npm run slo:check` — exits 0, prints the advisory with both units in agreement (1025/200 set,
  1025/200 modelled).
- `npm test` (service) — 130 pass, 0 fail, including the two new capacity tests.
- `terraform -chdir=infra/main fmt -check` — clean; `terraform -chdir=infra/main validate` — valid.
- TFC API read of `ws-pPiZ7mfesjrzZ8sx` — `{"data":[]}` for workspace variables; the one attached
  variable set is `high-load-test`.

Not run: `terraform plan`. The environment is down, and the values are byte-identical to what the
deleted generated file supplied, so no plan diff is expected from this change alone.
