# Research — k6 project ownership and teardown

Status: complete — all five decisions answered 2026-09-14 and carried into
`docs/superpowers/specs/2026-09-14-ecs-dynamodb-rps-k6-project-ownership-design.md`
Created: 2026-09-14 · Decided: 2026-09-14 on the review page
Next step: `superpowers:brainstorming`, then a spec that **amends** the restructure design's k6
decision (`docs/superpowers/specs/2026-09-02-ecs-dynamodb-rps-restructure-design.md`, section 7.2),
with a forward-pointer written at that decision itself

No code has been changed. This document is research only.

## Decisions made on review, 2026-09-14

Recorded on the review page <https://claude.ai/code/artifact/7bd700f1-df4e-4651-8f4c-fc0185808f68>.
Everything below is written to match them; the "Decisions" section near the end carries what each
one commits the spec to.

| # | question | answer |
|---|---|---|
| K1 | browsable cloud run history | **Accept the loss** — the ledger row is enough; no summary-JSON snapshot |
| K1a | the per-cycle re-upload | **Accept** — `./scripts/upload-k6.sh` by hand after every `/env up` |
| K2 | the live project `8476029` | **Let it go** — delete with `platform/`, mint a fresh id on the next `/env up` |
| K3 | `grafana_k6_project_limits` | **Move it**, all four values explicit |
| K4 | the teardown sweep | **Add a k6 check to it**, with the note *"with /env down I also want to remove relevant k6 project"* |

**The direction is therefore option A, taken literally** — the full move, no history-preservation
step, no state surgery. The one place the answers pull against the research is K3, noted at that
decision below.

---

## The ask

> "There will not be a shared `K6_CLOUD_PROJECT_ID`, each project — own id. And the k6 project lives
> in the project folder. After destroy — k6 should be destroyed as well."

Three claims, and they are not equally contentious. Two of them are already the repo's own stated
principle applied consistently; one of them reverses a decision made on 2026-09-03 and is a real
trade with a real cost. This document separates them.

## The short answer

**The strongest argument for the move is that section 7.2's main reason was never about the k6
project — it was about a copy of its id kept in a file nobody updates.**

Section 7.2 gave two reasons for putting `grafana_k6_project` in `platform/`. The first was that the
id becomes stable, so `K6_CLOUD_PROJECT_ID` in the root `.env` and the
`.../a/k6-app/projects/<id>` links in the README "stop rotting". That is not a property of the k6
project. It is a property of caching a Terraform-owned value in `.env` and in prose. Delete the
cache and the reason disappears — and the repo already says so about the sibling value: the root
`README.md` env table (line 120) explains there is deliberately **no `BASE_URL` key**, because "the
endpoint is per-project and Terraform owns it, so everything reads
`terraform -chdir=<project>/infra/main output` instead of a copy here." The k6 project id is the
same shape of value and got the opposite treatment.

The second reason — run history survives `/env down` — is real, and it is the only thing actually
being traded away. Its weight is lower than it looks, for two reasons established below: `--compare`
does not read the cloud, and CLAUDE.md forbids citing a number from an earlier session anyway.

Independently, the shared env var has to go regardless of where the resource lives: a second project
is already being designed, and one `K6_CLOUD_PROJECT_ID` cannot serve two k6 projects. The research
note for the Postgres scenario reached this conclusion on its own
(`docs/research/ecs-rds-postgres-pool.md`, "What changes outside this project", item 2), and
recommended the same fix — every reader goes through
`terraform -chdir=infra/main output -raw k6_project_id`.

## Where the resource lives today

| thing | file | what it does |
|---|---|---|
| the project | `platform/k6.tf:13` | `grafana_k6_project` per entry in `local.projects` (`platform/tfc.tf:28`), named after the repo project directory |
| its limits | `platform/k6.tf:40` | `grafana_k6_project_limits`, four values from `platform/variables.tf:101-123` |
| the lookup | `ecs-dynamodb-rps/infra/k6/main.tf:37` | `data "grafana_k6_projects" { name = var.project }` — the only by-name lookup the provider offers |
| the id out | `ecs-dynamodb-rps/infra/main/outputs.tf:6` | `k6_project_id`, forwarded from the module |
| the cached copy | `.env:51` | `K6_CLOUD_PROJECT_ID=8476029` |

This is the third position the decision has held. Commit `901b97d` had the project created in the
project's own state — "created, never imported, new id on every apply". Section 7.2 reversed that on
2026-09-03. The proposal here returns to roughly where `901b97d` was, but with the piece that made
`901b97d` painful removed rather than preserved.

## What actually changed since 2026-09-03

Three things, and they are why re-opening this is not simply churn:

1. **A second and third scenario now exist on paper.** `docs/research/ecs-rds-postgres-pool.md` and
   `docs/research/lambda-concurrency-sqs.md` are written. One `K6_CLOUD_PROJECT_ID` in a shared
   `.env` cannot address two k6 projects; the variable must either become per-project (a key per
   scenario, each hand-maintained and each able to go stale independently) or stop existing.
2. **`upload-k6.sh` now exists**, and it already reads `base_url` from Terraform output. Its one
   remaining hardcoded lookup is `PROJECT_ID=$(d printenv K6_CLOUD_PROJECT_ID …)` at line 81 —
   inconsistent with the pattern the same script follows for every other Terraform-owned value.
3. **The teardown expectation was written down and then contradicted by experience.** The leftover
   k6 project after a `terraform destroy` is what prompted this; a resource that survives teardown
   is exactly what CLAUDE.md's "every environment must be cheap to destroy and recreate" section
   trains a reader to treat as a bug, even when — as here — it is not billable.

## The costs

### Cost 1 — the load profiles must be re-uploaded after every `/env up`

This is the one the ask does not mention and it is probably the bigger of the two, because it is
paid on every cycle rather than once.

The three profiles in `infra/k6/tests/` are **not** Terraform resources — `grafana_k6_load_test`
takes a single script string and all three import from `tests/lib/`, so managing them as code needs
a bundler first (the reasoning is in `ecs-dynamodb-rps/infra/k6/main.tf`, the paragraph beginning
"The three load profiles in tests/ are NOT managed here"). They are pushed by
`scripts/upload-k6.sh`, which bakes `BASE_URL` and `RATE` into each archive with `k6 archive -e`.

Today those uploads live in a project that outlives the environment, so uploading is a once-per-
project step. Destroy the project and they go with it: every `/env up` is followed by a re-upload
before any cloud run can start. Two knock-on effects:

- **`upload-k6.sh --check` stops working while the environment is down.** It exists precisely to
  answer "are the uploaded archives stale?", and its answer becomes "there is nothing up there"
  for the whole window between teardown and the next apply.
- **The project README already lists silent-skip as a known gap** — "Uploading the k6 profiles is
  manual, and silent when skipped" — and this change makes that gap fire far more often.

`ecs-dynamodb-rps/README.md` currently states the opposite as settled expectation: the k6 project
"survives, with its uploaded tests, settings and run history". That sentence is the teardown
contract this proposal breaks, and it is the one a reader is most likely to have internalised.

### Cost 2 — run history

Destroying the k6 project destroys every cloud run result under it. That is the other half of what
section 7.2 bought. Two facts reduce its value:

- **`--compare` does not read the cloud.** The `/loadtest` skill's `--compare` section
  (`.claude/skills/loadtest/SKILL.md`, the `## --compare` section) says it reads *the previous row
  for the same profile* — from the project's `results.md` ledger — and presents a before/after
  table from it. The comparison that the repo's whole measure/improve/re-measure loop depends on
  therefore survives a k6 project deletion untouched, because the numbers live in the ledger.
- **CLAUDE.md forbids citing an old run anyway.** The verification rule is that an SLO or RPS
  number may not be reported without the k6 output or Grafana query that produced it, *from a run
  in that same session*. A cloud run from three teardowns ago is, by the repo's own rule, not
  citable evidence. It is browsable context, not a record.

What is genuinely lost is the ability to open the k6 app and look at a waterfall, a percentile
curve or a per-endpoint breakdown from an older run — detail the ledger row does not carry. Whether
that matters is the open decision below.

## A cost that is often assumed and is not real

**The k6 project is not billable.** Grafana Cloud k6 meters virtual-user-hours, consumed per run,
not per project. An empty project left behind costs nothing, which is why the teardown sweep in
`/env down` — which hunts NAT gateways, EIPs, snapshots and log groups — has no reason to look for
it. The case for destroying it is tidiness and consistency, not money. That is a legitimate case;
it is just worth not overstating, because "it bills forever" is the reflex and it is wrong here.

## The credential question, which turns out to be already solved

The obvious objection to creating k6 resources from a project workspace is authentication: the
project's `infra/main` runs in **remote** execution on Terraform Cloud, so a developer's shell never
reaches the run, while `platform/` runs locally and reads `GRAFANA_K6_ACCESS_TOKEN` and
`GRAFANA_STACK_ID` straight from `.env`.

This is already handled. The variable set `platform/` manages (`platform/tfc.tf`, the `env_vars`
local) puts `GRAFANA_K6_ACCESS_TOKEN` and `GRAFANA_STACK_ID` on every project workspace, alongside
`GRAFANA_URL` and `GRAFANA_AUTH`. A `grafana_k6_project` resource in `ecs-dynamodb-rps/infra/k6/`
would authenticate with credentials that are already present. **No new plumbing is needed** — this
was the thing most likely to sink the proposal, and it does not.

## Migration of the existing project `8476029`

Two ways, and they differ in whether the current run history and the current id survive the change
itself:

- **Destroy and recreate.** `platform/` stops declaring it; applying `platform/` deletes `8476029`;
  the next `/env up` creates a fresh project with a new id. Simple, one-way, loses the history now
  rather than at the next teardown. Consistent with a decision that has already accepted losing
  history at every teardown.
- **Move the state.** `terraform -chdir=platform state rm` the two resources, then `terraform import`
  them into the `ecs-dynamodb-rps` workspace. Import is known to work for these resource types in
  this repo: the four limit values now in `platform/variables.tf` were obtained by importing the
  hand-made project (`docs/superpowers/plans/2026-09-03-ecs-dynamodb-rps-restructure.md`, the
  comment at the k6 limits block: "the LIVE values read by importing the hand-made project"). Keeps
  `8476029` and its history until the first teardown, at the cost of a two-state surgery against a
  remote workspace.

The second is only worth its complexity if the answer to the open decision below is that history is
worth preserving — and if it is, then destroying it at every teardown is the thing to revisit, not
the migration step.

## What to do about the limits resource

`grafana_k6_project_limits` carries a warning worth re-reading before it is copied into a project
module (`platform/k6.tf`, the comment above the resource): all four attributes must be set
explicitly, because an unset optional attribute is sent as `null` and **resets the live value**, and
the k6 Cloud REST API exposes no endpoint that reads limits back — so a wrong value cannot be
re-derived from a live project. The current values are `vu_max_per_test = 25000`,
`vu_browser_max_per_test = 1000`, `vuh_max_per_month = 50000`, `duration_max_per_test = 18000`.

The same comment records that this resource is **not** the cap that matters: uploading `stress.js`
fails with `(400/E2004) … exceeds the maximum allowed for your project (100 VUs)` while the
project's own `vu_max_per_test` is 25000, so the 100 is enforced by an organization or subscription
cap somewhere else. The resource is therefore managing four numbers, none of which has been
observed to change anything.

**There is a recorded incident of exactly this going wrong, in the project workspace, for exactly
this reason.** The post-mortem at the top of
`docs/superpowers/plans/2026-09-01-ecs-dynamodb-rps-ceiling-datasource-fidelity.md` records that a
task destroyed a resource that was not in its plan: `grafana_k6_project_limits` had
`vuh_max_per_month` go `50000 -> null`, because the HCP workspace was shared between the main
checkout and a worktree while `grafana/k6.tf` was untracked, so the config Terraform saw did not
contain the resource. Moving the limits back into the project workspace re-opens that failure mode
— and it is silent, because the values cannot be read back through the API to notice.

That makes a third option available that the ask did not mention: **move the project and drop the
limits resource entirely.** A project Terraform creates would simply take whatever defaults the
organization gives it. The risk is not the null-reset behaviour (a resource that does not exist
sends nothing); it is that the defaults on a freshly created project are unknown and, per the same
comment, unreadable through the API. This wants one check against a scratch project before it is
chosen — listed under verification below.

## What must change

A full reference sweep found the blast radius to be wide but shallow: about a dozen lines of HCL and
two script blocks, against roughly fifty prose statements that become false. The prose is the larger
job.

### Code (small)

| area | change |
|---|---|
| `platform/k6.tf` | deleted in full — the resource and limits move to `ecs-dynamodb-rps/infra/k6/` |
| `platform/outputs.tf` | `k6_project_ids` output deleted (its resource is gone) |
| `platform/variables.tf` | the four k6 limit variables move with the resource |
| `platform/tfc.tf` | `local.projects` stays but drives only the two `tfe_*` resource sets; the workspace `description` string names the k6 projects and is state-tracked, so correcting it is an apply-visible diff |
| `ecs-dynamodb-rps/infra/k6/` | `data "grafana_k6_projects"` becomes `resource "grafana_k6_project"`; the output's value changes from `one(data…).id` to `.id` |
| `upload-k6.sh` | one line (81) for the id, plus two `blocked` remedies that currently say "apply `platform/`" |
| `.env`, `.env.example`, `scripts/02-create-env.sh` | the key and its `DEFERRED` handling go |
| `.claude/skills/loadtest/SKILL.md` | the API recipe's `source .env` + `$K6_CLOUD_PROJECT_ID` no longer resolves |

Two traps in that small set:

- **Do not read the id with `output -raw`.** The `/loadtest` skill already warns that against empty
  state `-raw` prints a multi-line warning **to stdout** and exits 0, so the caller silently gets
  garbage instead of a failure; the safe form is `output -json | jq -r '.k6_project_id.value //
  empty'`. This matters far more after the change, because "empty state" stops being an error case
  and becomes the normal condition between `/env down` and the next `/env up`. Note that
  `ecs-dynamodb-rps/README.md`'s "open the k6 project" one-liner already uses `-raw`, and the
  Postgres research note recommends `-raw` too — both want fixing at the same time.
- **`upload-k6.sh` gains an ordering dependency it does not have today.** It currently works against
  a torn-down environment; afterwards it requires `infra/main` to have been applied. Reading a
  Terraform *output* from a project script is allowed — CLAUDE.md forbids a project script from
  running `apply`, not from reading state — so the change is legal, but the script's failure
  messages need to say "apply the environment first" rather than "apply `platform/`".

### Prose (large)

Statements that become actively false, by document: `CLAUDE.md` (3), root `README.md` (4),
`ecs-dynamodb-rps/README.md` (6), `platform/README.md` (4), `.env.example` (1),
`.claude/skills/env/SKILL.md` (1), `.claude/skills/loadtest/SKILL.md` (1), the restructure design
spec (11), its plan (7), and the Postgres research note (2).

Three of those deserve individual mention:

- **The `/env` teardown sweep acquires a blind spot.** The sweep is entirely AWS —
  `resourcegroupstaggingapi`, then NAT gateways, EIPs, snapshots, log groups, ECR. Today a
  surviving k6 project is *correct* and rightly invisible to it. After the change a surviving k6
  project is an **orphan**, and nothing looks for it. Either the sweep gains a k6 check
  (`GET https://api.k6.io/cloud/v6/projects` with the `X-Stack-Id` header — the shape
  `upload-k6.sh` already uses) or the skill states explicitly that Grafana Cloud is out of scope.
  Leaving it unsaid is the worst of the three.
- **One open spec becomes wrong rather than merely outdated.** The SLO-relaxation design
  (`docs/superpowers/specs/2026-09-09-ecs-dynamodb-rps-slo-relaxation-design.md`) carries a
  `Status:` block asserting that the change is **not applied**, so Grafana Cloud and the k6 project
  "still carry the 99% / 99.9% configuration". That sentence depends on the k6 project persisting
  with its stale uploaded tests. An intervening `/env down` would wipe it, and the status line would
  then be describing a project that no longer exists. Every other affected doc is history; this one
  is live.
- **Renaming a project now orphans a k6 project too.** CLAUDE.md's naming section justifies name
  stability by the `Project` tag and the commit scope. The k6 project is named `var.project`, so the
  rename hazard grows a second limb that the tag sweep cannot see.

### The one thing with no path at all

**Nothing in the repo would adopt the existing project `8476029`.** There is no `import` block and
no `removed` block anywhere. A first apply of the moved configuration mints a new id and leaves
`8476029` behind as an untracked orphan — carrying the uploaded tests and the run history, and
invisible to the sweep, per the blind spot above. Whichever migration is chosen in K2 has to be an
explicit step, because the default behaviour is the bad one.

## Options

**A — full move, id read from Terraform everywhere.** `grafana_k6_project` and
`grafana_k6_project_limits` move into `<project>/infra/k6/`; the `data "grafana_k6_projects"` lookup
and its "apply `platform/` first" failure mode disappear; `K6_CLOUD_PROJECT_ID` is deleted from
`.env`, `.env.example` and `scripts/02-create-env.sh`; `upload-k6.sh` and the `/loadtest` skill read
the id from `terraform -chdir=infra/main output -json` (not `-raw` — see the trap above);
`platform/` keeps the TFC project,
workspaces, variable set and Grafana folder. `/env down` destroys the k6 project with everything
else. This is the ask, taken literally.

**B — A, plus the run summary is kept in the repo.** Same as A, with `/loadtest` (or `/env down`)
writing the run's summary JSON under the project before teardown, so the detail the ledger row does
not carry is not lost with the project. Costs one step and a directory of JSON; buys back most of
what section 7.2 was protecting.

**C — fix only the env var, leave ownership in `platform/`.** Delete `K6_CLOUD_PROJECT_ID`; every
reader goes through Terraform output. Solves the stale-copy problem and the two-projects problem;
does **not** solve the leftover after destroy, which is what prompted this. Listed because it is the
minimal change and because it is what the Postgres research note already assumed would happen.

**Option A was chosen**, taken literally: the full move, with neither B's snapshot step nor C's
retreat to `platform/`.

## Decisions

All five were answered on the review page on 2026-09-14. Each is recorded here with what it commits
the spec to.

**K1 — browsable cloud run history: accept the loss.** No summary-JSON snapshot step, no directory
of archived runs. `results.md` is the record; the cloud project is a working surface that comes and
goes with the environment. This is consistent with the two facts that made the question answerable:
`--compare` reads the previous ledger row rather than the cloud, and CLAUDE.md's verification rule
already bars quoting a number from an earlier session. The spec should say this plainly in the
amendment, because the original decision treated surviving history as a benefit worth designing
for, and the reversal is not "we forgot about it" but "it was never load-bearing".

**K1a — the per-cycle re-upload: accepted.** `./scripts/upload-k6.sh` after every `/env up`, by
hand, as now — the bundler and `grafana_k6_load_test` resources stay off the table, consistent with
the restructure design's load-tests decision ("keep uploading by hand"). Two documentation
consequences follow and are not optional, because this is the cost that is paid repeatedly:
`ecs-dynamodb-rps/README.md`'s known-gaps entry ("Uploading the k6 profiles is manual, and silent
when skipped") must say that the upload is now destroyed with the environment, and the
`upload-k6.sh --check` description must say it cannot answer while the environment is down.

**K2 — the live project `8476029`: let it go.** `platform/` stops declaring it, the apply deletes
it, and the next `/env up` mints a fresh id. No `state rm`, no `import`, no `removed` block. This
follows from K1 — there is no history worth the state surgery — and it makes the migration a single
ordered pair of applies rather than a manual operation against a remote workspace. The spec must
still make it an **explicit step**, because the failure mode if it is merely omitted is the opposite
outcome: the project survives untracked and the sweep cannot see it.

**K3 — `grafana_k6_project_limits`: move it, all four values explicit.** This is the one answer that
runs against the research above, which argued for dropping the resource on the grounds that its four
values have never been observed to change anything while its failure mode is a silent reset. Since
it is being kept, the spec inherits two obligations rather than one:

- **The warning comment travels with the resource, verbatim.** All four attributes stay set; an
  unset optional attribute is sent as `null` and resets the live value, and the k6 API exposes no
  endpoint that reads limits back, so a wrong value cannot be re-derived from a live project.
- **The recorded null-out has a cause worth naming in the new home.** `vuh_max_per_month` went
  `50000 -> null` because the HCP workspace was shared between the main checkout and a worktree in
  which `k6.tf` was *untracked* — so the config Terraform saw did not contain the resource at all.
  The mitigation is therefore not vigilance but the file being committed before any apply from a
  worktree, which is worth one sentence next to the resource rather than left in a plan's
  post-mortem where nobody editing this file will find it.

Verification item 2 below (what limits a freshly created project gets) stays relevant under this
answer rather than becoming moot: K2 means a **new** project is created, so the four values are now
being asserted onto a project whose starting state is unknown.

**K4 — the teardown sweep: add a k6 check.** The note attached to the answer is
*"with /env down I also want to remove relevant k6 project"*, which settles the intent behind the
whole change: the destroy removes it, and the sweep's job is to prove that it did. Concretely, the
`/env down` sweep gains a Grafana Cloud step after the AWS queries — list the stack's k6 projects
(`GET https://api.k6.io/cloud/v6/projects` with the `X-Stack-Id` header, the shape `upload-k6.sh`
already uses) and report any project named for the project just torn down. Note the credential
consequence: the sweep runs locally from the developer's shell, where `GRAFANA_K6_ACCESS_TOKEN` and
`GRAFANA_STACK_ID` are present in the root `.env`, so this needs no new secret — but it does mean
`/env down` now fails differently when those are unset, and the skill should say which part is the
sweep rather than the destroy.

## Verification still owed before a spec

Nothing below has been tested; all of it is cheap and none of it needs the AWS environment up.

1. **Does deleting a k6 project that contains uploaded load tests succeed?** The provider docs
   describe `grafana_k6_project` and `grafana_k6_load_test` as separate resources with the test
   referencing the project; they do not state what happens to a project deleted while tests exist
   outside Terraform's knowledge — and this repo's three tests are uploaded by `upload-k6.sh`, not
   managed as resources. If the delete refuses, `/env down` fails at teardown, which is the worst
   possible place to discover it.
2. **What limits does a freshly created k6 project get?** Create a scratch project, read its limits
   (if the API allows it at all — the `platform/k6.tf` comment says it does not), destroy it. This
   is what decides K3.
3. **Does the plan still work with `platform/` never applied?** Today the `one()` lookup failing is
   a deliberate guard that says "apply `platform/` first". Under option A that guard is gone, which
   is correct — but `platform/` still owns the Grafana folder the project's dashboard nests into,
   so some ordering dependency remains and the error message for it should be checked.
4. **`upload-k6.sh` against a Terraform-sourced id.** The script resolves credentials through
   `direnv exec` from the root `.env`; a Terraform output is not in `.env`, so the resolution path
   changes shape, not just source.

## Documentation obligations (CLAUDE.md)

Whatever is decided, the repo's own rules make three writing tasks non-optional:

- A new spec must state what it amends and **why the original reasoning failed** — here: that the id
  stability argument was solving for a cached copy, not for the resource.
- Section 7.2 of the restructure design gets a forward-pointer **at the decision itself**, not only
  in a header. The same applies to its decision table row (`k6-project-home`) and to the "rejected
  alternatives" entry that lists "the k6 project staying in the project workspace (new id every
  apply)" as rejected — that line becomes actively misleading.
- CLAUDE.md's own layout section says `platform/` "owns the TFC project, the project workspaces, the
  shared variable set, the Grafana folder `high-load-test` and the k6 projects". The last clause
  changes — and so does the sentence just after it, which offers "the folder title, the k6 project's
  own name" as the two examples of things found by a fixed string rather than by reading platform
  state. The rule survives; the example list shrinks to one.

Two further points specific to this change:

- **The amendment format already exists in the document being amended.** Section 7.1 carries an
  *"Amended 2026-09-04 during execution"* note and 7.3 an *"Amended 2026-09-10"* block, both written
  inline at the decision. Matching that shape is better than inventing one.
- **This is the second reversal of the same decision, and that has to be said out loud.** Commit
  `901b97d` put the project in the project's state; section 7.2 reversed it and the spec records
  that reversal explicitly; this proposal reinstates roughly `901b97d`'s position. A reader who
  lands on the middle document without a forward-pointer would find the original position described
  as rejected, in a "Rejected alternatives" list, in the very words of what is now being adopted:
  *"The k6 project staying in the project workspace (new id every apply)."* That sentence is the
  single strongest thing to cite when writing the amendment — and the single most misleading thing
  to leave standing unannotated.
- **One live document, not just history.** The SLO-relaxation spec's `Status:` block (described
  above) asserts a fact about the current k6 project that a teardown would falsify. It needs
  updating as part of the change, not afterwards.
