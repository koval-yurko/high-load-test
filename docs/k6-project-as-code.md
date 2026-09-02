# The Grafana Cloud k6 project under Terraform

**Status:** `in progress` — the HCL landed on 2026-09-02, immediately after the teardown that
destroyed `ecs-dynamodb-rps-ceiling`. It has **not been applied**; it takes effect on the next
`/env up`, which will create a k6 project with a **new id**. Three follow-ups are outstanding, all
listed under "After the first apply" below, and one of them is deleting the old project by hand.

**Scope: the project resource only.** The three load tests stay uploaded by hand, as they were
before. See "Why the tests stay manual" — this is a decision, not an omission. The project is
always **created**, never imported, so its id changes on every apply.

## Why this note exists

`CLAUDE.md` states the hard constraint plainly: *"Terraform is the only way infrastructure exists.
No click-ops. If something was created by hand, it is a bug — import it or delete it."* The k6
project is a standing violation of that rule, and this note is the fix, held until the one moment
it is cheap.

## What it was before

The Grafana Cloud k6 project **`high-load-test`, id `8474786`** was created by hand in the k6 UI
before any of this Terraform existed. Terraform never owned it — it owned exactly one object
*inside* it, `grafana_k6_project_limits.this`, adopted with `terraform import` on 2026-09-01.

That import is why the four limit values in `grafana/k6.tf` can be trusted: `vu_max_per_test =
25000`, `duration_max_per_test = 18000`, `vu_browser_max_per_test = 1000`, `vuh_max_per_month =
50000`. The k6 Cloud REST API exposes no endpoint that reads limits back, so importing the live
project was the only way to learn them — and any attribute left unset is sent as `null` and wipes
the live value. **They cannot be re-derived.** Keep all four set explicitly, forever.

The id reached that resource through four files — `terraform/dev.tfvars` held
`k6_project_id = "8474786"`, `terraform/variables.tf` declared it, `terraform/grafana.tf` passed it
into the module, `grafana/k6.tf` consumed it. All four are now cleaned up.

The credentials that reach the project are unchanged: `GRAFANA_K6_ACCESS_TOKEN` and
`GRAFANA_STACK_ID`, both **HCP Terraform workspace environment variables** — the run executes
remotely, so a local `.env` never gets there.

## The change (landed)

The provider already pinned in this project — `grafana/grafana ~> 3.0`, resolved to **3.25.9** —
ships `grafana_k6_project`. Nothing needed upgrading.

In `ecs-dynamodb-rps-ceiling/grafana/k6.tf`:

```hcl
resource "grafana_k6_project" "this" {
  name = "high-load-test"
}
```

The limits resource now takes its id from that resource instead of a variable:

```hcl
resource "grafana_k6_project_limits" "this" {
  project_id = grafana_k6_project.this.id
  # ...the four limit attributes stay exactly as they are; all four must remain
  # set explicitly, because an unset optional attribute is sent as null and
  # resets the live value.
}
```

`k6_project_id` is gone from all four files that carried it: `terraform/dev.tfvars` (the
`k6_project_id = "8474786"` line and its comment), `terraform/variables.tf`, the module call in
`terraform/grafana.tf`, and `grafana/variables.tf`. `grafana/outputs.tf` is new and exposes the id;
`terraform/outputs.tf` re-exports it beside `base_url`.

`terraform validate` passes and `terraform plan -var-file=dev.tfvars` on the empty environment
reads **53 to add, 0 to change, 0 to destroy**, with `k6_project_id = (known after apply)`.

### The project id is different after every apply

There is no import and no stable id. `terraform destroy` deletes the project, the next apply
creates a fresh one, and Grafana Cloud assigns it a **new numeric id every time**. Treat `8474786`
as dead the moment this lands.

The id is therefore exposed as an output rather than hardcoded — `grafana/outputs.tf` (new) emits
`grafana_k6_project.this.id`, and `terraform/outputs.tf` re-exports it as `k6_project_id` beside
`base_url`.

## After the first apply

Three manual steps, none of which anything warns about. Read the id once:

```bash
terraform -chdir=terraform output -raw k6_project_id
```

**1. Delete the old project `8474786` by hand.** It was never in Terraform state, so the teardown
did not touch it and the apply does not adopt it — it simply keeps existing, with the three
uploaded tests and the old run history, alongside the new one. Two projects named `high-load-test`
in the k6 app is a trap for exactly the person who does not know this file exists. Grafana Cloud →
**Performance Testing (k6) → Projects** → delete it. Do this *after* confirming the new project
works, since deletion takes the old run results with it.

**2. Re-point everything that names the id.** `K6_CLOUD_PROJECT_ID` in the root `.env`, or
`k6 cloud run` uploads into the deleted project and fails; and the three
`https://k0valchuk.grafana.net/a/k6-app/projects/<id>` links in
`ecs-dynamodb-rps-ceiling/README.md` — in "Where everything lives", in Phase 2 where the run is
started, and in Phase 3's result table.

**3. Re-create what Terraform does not manage** in the new, empty project: upload
`k6/discovery.js`, `k6/constant.js` and `k6/stress.js`, then set `BASE_URL` (from
`terraform output -raw base_url`) and `RATE` on the settings page. A run with `BASE_URL` unset
fails immediately; one with `RATE` unset does **not** — it quietly uses 50 rps and tags itself
`rate_source=default`.

## The trade this accepts

**`/env down` now deletes the k6 project, and with it the three uploaded tests and every run
result.** `grafana/` is a module of the same root module, sharing one state, so a single
`terraform destroy` takes the project down with the AWS resources.

Concretely, every teardown from here on means the next `/env up` hands you an **empty project with
a new id**, and the three steps under "After the first apply" are not one-time — they repeat on
every cycle.

That is the price of the constraint, and it is accepted: the durable record of results is the
table in `ecs-dynamodb-rps-ceiling/README.md`, not the k6 UI, and the UI's run history is a
convenience that does not survive teardown. The only alternative would be
`lifecycle { prevent_destroy = true }` on the project — which makes `/env down` *fail* until the
project is moved into a separate, long-lived Terraform state. Not doing that.

## Why the tests stay manual

`grafana_k6_load_test` exists in the same provider and would take `name`, `project_id` and `script`.
It is deliberately not used, because `script` is a single string and the entry points are not
self-contained:

```
k6/discovery.js  ─┐
k6/constant.js   ─┼─→ ./lib/slo.js  ./lib/request.js  ./lib/env.js  (and lib/mix.js)
k6/stress.js     ─┘
```

`script = file("${path.module}/../k6/discovery.js")` uploads the entry point alone; the relative
imports do not resolve in the cloud and the test fails at parse time. Making it work needs a
bundling step — esbuild or webpack, one flat file per entry point into a build directory that
`file()` reads — which is its own change with its own plan. Uploading three scripts by hand is
cheaper than owning a build pipeline for them.

## What this does *not* fix

The k6 test **settings page** — the `BASE_URL` and `RATE` environment variables a UI-started run
needs — stays click-ops. No provider resource covers it and the k6 Cloud API is read-only for that
object. Missing `BASE_URL` fails the run loudly; missing `RATE` fails **silently**, falling back to
50 rps and marking the run only with the `rate_source=default` tag. That gap survives this change,
and grows slightly: after a teardown it must be redone on a fresh project.
