# ecs-dynamodb-rps

A Node.js service on ECS Fargate over a provisioned-capacity DynamoDB table, in `eu-central-1`. It
exists to answer two questions with evidence: **at what request rate does the latency SLO break, and
was DynamoDB refusing requests when it did?** Nothing computes a verdict — you read the two side by
side.

The method: find the breaking point, release **one** constraint (service capacity first, then
database capacity), re-measure. Never both at once, or the comparison is worthless.

**Idle cost: ~$0.055/hour.** See [Cost](#cost).

## Where to look

| open | then |
|---|---|
| `https://k0valchuk.grafana.net/dashboards` | folder `high-load-test / ecs-dynamodb-rps` → dashboard **ecs-dynamodb-rps — attribution**. Seven numbered rows; references below name the row and panel. |
| `https://k0valchuk.grafana.net/alerting/list` | folder `high-load-test / ecs-dynamodb-rps` → this project's nine rules (the 13 under folder `grafana-slo` are the SLO app's recording rules, not alerts) |
| `https://k0valchuk.grafana.net/a/grafana-slo-app/slos` | the SLO **ecs-dynamodb-rps latency classes** — error budget and 7-day attainment |
| `https://k0valchuk.grafana.net/a/k6-app/projects` | the project named **ecs-dynamodb-rps** → its k6 tests and the runs since the last `/env up` (the project is destroyed with the environment) |

**The dashboard has no permanent URL by design** — its JSON pins no `uid`, so Grafana mints a new one
every time the folder is recreated and any `/d/<uid>/…` link written here dies at the next teardown.
Open it by name, or print the current one:

```bash
curl -s -H "Authorization: Bearer $GRAFANA_AUTH" \
  "$GRAFANA_URL/api/search?type=dash-db&query=attribution" | jq -r '.[] | .url'
```

It opens at the last 1 hour. Set the range to the run's window when reading a load test.

**The k6 project's id is not written down here either**, and not in `.env`: `infra/k6` creates the
project and `/env down` destroys it, so the id is new after every rebuild. Pick the project by name,
or jump straight to it:

```bash
open "$GRAFANA_URL/a/k6-app/projects/$(terraform -chdir=infra/main output -json | jq -r '.k6_project_id.value // empty')"
```

`-json` + `jq`, not `-raw`: against empty state — the normal condition between `/env down` and the
next `/env up` — `-raw` prints a warning to stdout and exits 0, and `open` would be handed the warning.

---

## 1. Is the service up?

| check | where |
|---|---|
| Is the ECS task running? | [dashboard][dash] → row 4 *Service (ECS)* → **ECS LiveTaskCount** |
| Is the load balancer routing to it? | [dashboard][dash] → row 5 *Edge (ALB)* → **ALB HealthyHostCount** |
| Is traffic arriving, and answered? | [dashboard][dash] → row 5 → **ALB RequestCount**, **HTTP status codes** |

**Good:** `HealthyHostCount` equals the task count (1, or 4 if autoscaling scaled out), almost all
2XX. Stray 4XX are internet scanners.

**Bad:** `HealthyHostCount` at 0, or a run of 5XX — but check throttling first ([§3](#3-what-is-the-bottleneck)).
Retry backoff happens *inside* the Node process, so a throttling table fails the health check for a
database-side reason.

## 2. Are we meeting the SLO?

[dashboard][dash] → row 6 *Service SLI* → **SLI ratio**: the proportion of requests meeting their
class threshold — fast < 50 ms, standard < 200 ms, heavy < 800 ms.

- A **5xx is a miss however fast it was**; a 4xx is not a miss (a client error is not charged to the
  service). k6's `slo_met` applies the same rule, so both attainment columns in `results.md` measure
  the same thing.
- The number is **server-side** — handler entry to response finish, excluding client↔ALB network
  time. It reads higher than k6's client-side view. Both are kept, as separate columns.
- **The continuous line is informational.** Between runs the only traffic is a 1/min heartbeat, so
  one slow request moves the hourly figure by a point. **Authoritative attainment is run-scoped.**

**Good during a run:** above 95%. **Good at idle:** 98–99%, and not a defect worth chasing — ~3% of
idle requests pay a fresh TLS handshake to DynamoDB after the connection is reaped, which cannot
happen under sustained load. (Measured 2026-09-01, fast class: p95 31.9 ms / 96.67% idle against p95
4.8 ms / 99.43% at 60 rps.)

**Error budget:** [SLO app][slo] → **ecs-dynamodb-rps latency classes**. At 95%, up to 5% of requests
in the window may miss. The window is **7 days**, forced — Grafana's SLO API accepts 7–32 days and
the free tier retains 14. Do not read a depressed 7-day figure as an incident; the burn-rate alerts
below are what is worth acting on.

**Why 95% and not 99%** (relaxed 2026-09-09, with the tail from 99.9% to 99% —
`docs/superpowers/specs/2026-09-09-ecs-dynamodb-rps-slo-relaxation-design.md`): at 99% the budget was
too small to watch anything burn. The idle heartbeat alone — 40,320 requests over 7 days, ~3.3% of
the fast half missing on cold sockets — spent **166%** of the week's budget with no load running, and
a clean constant run at capacity spent another 67%. Five times the budget puts those at **33%** and
**13%**, so a run's burn is legible rather than instantaneous. The class thresholds did **not** move:
they are achievable and they are what the k6 VU sizing is derived from. **The floor for the primary
objective is 93.06%** — below it the 14.4× fast-burn rule needs a miss rate over 100% and can never
fire. A test enforces that (`service/test/generate-slo.test.js`).

## 3. What is the bottleneck?

Two metrics, read side by side:

| question | where | meaning |
|---|---|---|
| How long is the endpoint taking? | [dashboard][dash] → row 6 → **SLI ratio**, latency panels in row 7 | server-side request duration |
| **Was DynamoDB rejecting us?** | [dashboard][dash] → row 1 → **DynamoDB throttle events** (live from CloudWatch, read and write plotted separately) | non-zero = DynamoDB refused requests, SDK retried with backoff |

- Latency up **and** throttles non-zero → the database was the constraint. The knob is capacity.
- Latency up **and** throttles at zero → it wasn't. Look at the service.

**Read the throttle panel first and judge nothing about the service while it is non-zero.** Measured
2026-09-01 at 250 rps against 25 RCU: the service's own database timing read 642–938 ms while
DynamoDB's own clock read 0.9–2.2 ms, event-loop utilization pinned at 1.000, CPU at 3–16%.

**The trap in the other direction:** DynamoDB's latency metric *falls* when the table throttles
(0.887 ms mid-throttle against 1.473 ms idle) — rejected requests never enter the statistic. Flat or
falling DynamoDB latency is not evidence of a healthy database.

When throttles are zero and the service still looks slow: [dashboard][dash] → row 7 → **Event-loop
delay p99 by task** (per-task, which is what makes a 1→4 scale-out decision visible), and row 3 →
**Read/Write capacity: consumed vs provisioned**.

Two reading quirks: CloudWatch publishes throttle metrics **sparsely**, so gaps in the line mean
"nothing was throttled", not "no data"; and the queueing-delay panel shows `NaN` for any route with
no traffic in the last 60 s — only traffic fixes it, not a wider time range.

## 4. Is it about to break?

[alert rules][alerts] → folder **ecs-dynamodb-rps**. Nine rules:

| rule | fires when | means |
|---|---|---|
| **Fast burn** ×3 objectives | budget burning at 14.4× over 14 min | gone in ~12 h — something just broke, hard |
| **Slow burn** ×3 objectives | 6× over 84 min | gone in ~1 day — bleeding steadily |
| **SLI absent** | no SLI sample for 10 min | the *measurement* stopped; nothing else here can be trusted |
| **DynamoDB read / write throttling** | `Read`/`WriteThrottleEvents > 0` for 2m | the database, not the service |

The three objectives are latency primary (95% meet their class threshold), latency tail (99% meet
3×), and availability (99.9% not 5xx). Their fast/slow burn thresholds are 72%/30%, 14.4%/6% and
1.44%/0.6% respectively — each rule's own `computation` annotation shows the arithmetic.

**The tail rule is the early warning, not the primary one.** A threshold is
`multiplier × (1 − objective)`, so the primary rule at 95% pages only above a 72% miss rate, which is
a service that is essentially down. The tail objective at 99% puts its fast burn at 14.4% — exactly
where the primary rule sat before 2026-09-09. If you lower the primary again, lower the tail with it
or that warning disappears.

**Why SLI-absent exists:** every burn rule treats "no data" as OK — correctly, since no traffic is
not a burn — so a dead heartbeat or a stopped collector leaves all six silent and the dashboard flat.
This rule separates *quiet* from *blind*.

**Why the throttle rules are separate from everything else:** every other rule reads the same
service-side signal, so a throttling table announces itself as latency and 5xx everywhere at once.
They are also two rules rather than one summed rule, because read-only throttling (5,588 read
events/min against 0 writes, 2026-09-01) would have silenced a combined rule exactly when it
mattered (`infra/grafana/throttles.tf`).

**Timing**, measured 2026-09-01 by overloading the service for six minutes:

| | fast burn | slow burn |
|---|---|---|
| load starts → firing | 4m 01s | ~6m |
| load stops → clear | 16m | ~84m |

Recovery is measured from the last bad sample, not the last request. A slow-burn rule keeps firing
for over an hour after a six-minute incident as its window rolls off — "still firing" is not evidence
that anything is still wrong.

## 5. What did the last load test show?

**Nothing has been measured yet** — no run against this environment, and `results.md` does not exist.
Every number must come from a k6 run or Grafana query executed in the same session that reports it.

---

# Runbook

## Where everything lives

| what | where |
|---|---|
| **Service URL** | `terraform -chdir=infra/main output -raw base_url` — **deliberately not in this repo, and not in `.env` either.** Terraform owns it; a copy elsewhere is just the stale one (which is exactly what happened on 2026-09-10) |
| **Terraform Cloud** | https://app.terraform.io/app/failwin/workspaces/ecs-dynamodb-rps |
| **Grafana Cloud k6** | https://k0valchuk.grafana.net/a/k6-app/projects → **ecs-dynamodb-rps**. Created by `infra/k6` and destroyed by `/env down`, with its uploaded tests and run history; its id comes only from `terraform -chdir=infra/main output -json` (`.k6_project_id.value`) |
| **ECS service** | https://eu-central-1.console.aws.amazon.com/ecs/v2/clusters/ecs-dynamodb-rps/services?region=eu-central-1 |
| **DynamoDB table** | https://eu-central-1.console.aws.amazon.com/dynamodbv2/home?region=eu-central-1#table?name=ecs-dynamodb-rps |
| **CloudWatch logs** | log group `/ecs/ecs-dynamodb-rps`, 1-day retention |

AWS account `042945885621`, region `eu-central-1`. The AWS and TFC links are built from fixed names,
so they resolve while the environment is applied and 404 after a teardown; the k6 projects page
simply lists no `ecs-dynamodb-rps` project.

## Service endpoints

| endpoint | work | class | threshold |
|---|---|---|---|
| `GET /healthz` | none — never touches DynamoDB | — | — |
| `GET /items/:pk/:sk` | `GetItem` | fast | < 50 ms |
| `POST /items` | `PutItem` | fast | < 50 ms |
| `GET /feeds/:pk` | `Query`, 20 items | standard | < 200 ms |
| `POST /reports` | `Query` + hash + `PutItem` | heavy | < 800 ms |

Traffic runs at a **frozen 55/15/25/5** mix (read/write/feed/report). Every figure is stated *at that
mix*; change it and every recorded number is void. The table is seeded with 1,000 items across 50
feed partitions.

## Phase 0 — Setup (already done once)

```bash
cp .env.example .env              # AWS, Terraform Cloud, Grafana, k6 tokens
direnv allow                      # from the repo root, and again after every .env edit
terraform -chdir=platform apply   # the shared stack, once, from the repo root
cd ecs-dynamodb-rps
(cd service && npm ci)            # all Node tooling lives in service/
terraform -chdir=infra/main init
```

Provision, then deploy the service into it:

```bash
terraform -chdir=infra/main apply -var-file=dev.tfvars   # approval gate; capacity.auto.tfvars loads itself
./scripts/deploy-service.sh                              # build → push → roll → seed → health
```

Re-run `./scripts/deploy-service.sh` after **every** change under `service/src/` — Terraform does not
rebuild the image, and skipping it fails silently. `--skip-seed` when the table is populated,
`--skip-build` to only roll the service. No script runs `terraform apply`: the `guard-terraform.sh`
hook matches command text, so an apply buried in a script would never reach the approval gate.

Tests, from `service/` — integration tests **skip silently** without a local DynamoDB, so a bare
`npm test` is green either way:

```bash
cd service
npm test                                    # unit
docker compose -f docker-compose.test.yml up -d
DYNAMO_ENDPOINT=http://localhost:8000 npm run test:integration
docker compose -f docker-compose.test.yml down
```

When setup breaks, it is almost always one of these:

| symptom | cause |
|---|---|
| `"organization" must be set … TF_CLOUD_ORGANIZATION` | direnv did not load — `direnv allow` at the repo root |
| plan fails on `data.grafana_folder.root` | `terraform -chdir=platform apply` was skipped; it creates the workspace, variable set and the `high-load-test` Grafana folder this project nests under |
| `upload-k6.sh`: "infra/main has no k6_project_id output" | the environment is not applied, so its k6 project does not exist — `/env up` first |
| workspace lands in the org's *default* project | `.env` is missing `TF_CLOUD_PROJECT=high-load-test` |
| Terraform aborts over the workspace name | something exports `TF_WORKSPACE`; it must not |
| `Error: No configuration files` | bare `terraform apply` at the project root — use `-chdir=infra/main` |
| `CannotPullContainerError` at task start | an arm64 image; the script builds `--platform linux/amd64` for a reason |
| healthy service, still the old code | pushed without `--force-new-deployment` |

## Phase 1 — Is it alive?

```bash
BASE=$(terraform -chdir=infra/main output -raw base_url)
curl -fsS "$BASE/healthz"                 # {"ok":true}
curl -fsS "$BASE/feeds/feed-07" | jq .    # a real feed page, 20 items
```

## Phase 2 — Run a load test

Three shapes, in this order — B and C need the number A produces:

| shape | file | what it's for |
|---|---|---|
| **A — discovery** | `infra/k6/tests/discovery.js` | 20 steps, 100 → 2000 rps in 100 rps increments, 60 s each, one scenario and one threshold per step. **The knee is the lowest step whose threshold breached.** |
| **B — constant** | `infra/k6/tests/constant.js` | Holds at the discovered rate. The repeatable baseline for before/after comparison. |
| **C — stress** | `infra/k6/tests/stress.js` | ~3× the knee. Deliberately breaches the SLO — the only way autoscaling and the alerts get tested. |

**1. Upload the profiles.** A UI run executes the **archive stored in the cloud**, never the file on
disk, and nothing warns you when it is stale: the old script runs happily and its results look like a
measurement of the code you are reading.

```bash
./scripts/upload-k6.sh --check      # what is up there, and is any of it stale?
./scripts/upload-k6.sh              # discovery only — the knee is not known yet
./scripts/upload-k6.sh --rate 700   # all three, constant/stress pinned to the measured knee
```

It takes `BASE_URL` from `terraform output` and bakes both values into the archive with `-e`, so a
UI-started run needs nothing set by hand. Without `--rate` it uploads discovery only — `constant` and
`stress` archived without a knee freeze at 50 rps and tag every sample `rate_source=default`, which
is not a capacity measurement.

**2. Raise table capacity — `infra/main/dev.tfvars`.** Two lines at the top pin the table to 25/25,
the DynamoDB free tier, where the binding constraint is the free tier and not the service (250 rps
produced 5,588 rejected reads per minute). **A run at 25/25 must not be recorded as an RPS ceiling.**
Delete those two lines so the generated `capacity.auto.tfvars` (1025 RCU / 200 WCU) takes over, then
`plan` and apply — **approval gate**, and the bill goes from ~$0.055/hr to **$0.3212/hr**.

**3. Clear the k6 app's [Settings → Environment variables](https://k0valchuk.grafana.net/a/k6-app/settings/environment-variables)
— by hand, in a browser.** This is the one step in this file that no script and no `terraform apply`
will ever do for you: the page has no API and no Terraform resource, so `upload-k6.sh` prints a
reminder after every upload but cannot touch it.

**The action is to delete `BASE_URL` and `RATE` there, not to update them.** Step 1 bakes both into
the archive, so an empty page is the correct state; a leftover `BASE_URL` from an earlier apply can
still point a run at a load balancer that no longer exists. If you keep values there, they must
equal what `upload-k6.sh` last uploaded.

**4. Wait 6 minutes before every run.** DynamoDB banks unused capacity for ~300 s, so a run starting
from a partly-drained burst bucket is not comparable to one starting full. **A run without the drain
must not be recorded.**

**5. Start the run** from the [k6 projects page][k6] → **ecs-dynamodb-rps**. When discovery finishes, open its thresholds: each
step has one named `slo_met{scenario:rps_N}`, and **k6 reports a threshold as breached, not passed —
the boolean is `true` when it was crossed.** The knee is the lowest `rps_N` that breached; `RATE` for
B and C is the step before it. If nothing breached, the ceiling is above 2000 rps — raise `MAX_RATE`
and re-run rather than reporting 2000.

**From a terminal instead** — no upload needed, `-e` wins over everything:

```bash
# direnv has already exported K6_CLOUD_TOKEN here; the endpoint comes from Terraform,
# which is the only place it exists. -json | jq, never -raw: against an empty state
# -raw prints a warning to STDOUT and exits 0, and you would send that as the hostname.
BASE_URL=$(terraform -chdir=infra/main output -json | jq -r '.base_url.value // empty')

k6 cloud run -e BASE_URL="$BASE_URL" -e RATE=<knee> infra/k6/tests/constant.js
echo "exit=$?"                     # 0 = the gates held, 99 = one breached
```

Capture that exit code on the k6 line itself — behind a pipe you get the pipe's status. Four
thresholds decide it: `slo_met` (95% meet their class threshold), `slo_met_tail` (99% meet 3×),
`http_req_failed` (< 0.1%), and `dropped_iterations` (zero — a run that ran out of VUs delivered less
than `RATE`). Per-class p99 lines are reported only. All runs go from Frankfurt, so network
round-trip is not charged against the latency budget.

## Phase 3 — Read the result

Set the dashboard time range to the run's window.

| question | where |
|---|---|
| What rate did we reach, client-side? | [k6][k6] → **ecs-dynamodb-rps** → the run |
| Did the SLO hold, server-side? | [dashboard][dash] → row 6 → **SLI ratio** |
| **Was DynamoDB rejecting us?** | [dashboard][dash] → row 1 → **DynamoDB throttle events** — read this first |
| How much capacity headroom was left? | [dashboard][dash] → row 3 → **Read/Write capacity** |
| Was the service itself the limit? | [dashboard][dash] → row 7 → **Event-loop delay p99 by task** |
| Did the burn-rate alerts fire? | [alert rules][alerts] |
| How much budget did it cost? | [SLO app][slo] |

Both traps from [§3](#3-what-is-the-bottleneck) apply: while throttles are non-zero no service-side
signal is evidence about the service, and falling DynamoDB latency is not a healthy database.

Once admission control (shedding) is live, a shedding run is expected to exit k6 with code **99**,
`slo_met` and `http_req_failed` both breached — that is k6 counting a shed 429 as a miss and as a
failed request, which is correct for k6 but disagrees with the Grafana-side SLO, which does not
charge a 4xx to the service. This is a known, accepted divergence, not a regression; see
`docs/superpowers/specs/2026-09-15-ecs-dynamodb-rps-spike-response-design.md` §7, "The 4xx
divergence — knowingly accepted." For those runs, read SLO attainment from Grafana, not from the k6
exit code.

## Phase 4 — Improve: scale the service out (1 → 4 tasks)

**One change only.** If Phase 3 showed non-zero throttles, skip to Phase 6 — scaling tasks would
change nothing, and recording why the order was swapped is itself a result.

```hcl
# infra/main/dev.tfvars
autoscaling_enabled = true
```

`terraform -chdir=infra/main plan -var-file=dev.tfvars` must show **exactly two resources added** (the
autoscaling target and its CPU policy). Anything more means more than one thing is changing. Then
apply — **approval gate.** Cooldowns are 30 s out, 120 s in: out fast, in slow.

## Phase 5 — Re-measure identically

Drain 6 minutes, re-run **B and C unchanged** — same `RATE`, same scripts, same load zone — and
re-read Phase 3. Expect throttles to become non-zero: the database is now the constraint.

## Phase 6 — Improve: raise database capacity

Only if Phase 5 left throttles non-zero. Capacity comes from the model, never a hand-typed number:
raise `target_rps` in `slo.yaml` and regenerate `capacity.auto.tfvars` with `/slo`. Confirm the plan
is an **in-place** change — if it proposes to *replace* the table, stop, the seeded data is lost.
Then apply — **approval gate.**

## Phase 7 — Re-measure again

Drain 6 minutes, re-run B and C, read Phase 3. Record the new ceiling and the new $/hour.

## Phase 8 — Record the results

Append one row per run to `results.md` (the `/loadtest` skill does this, including for UI-started
runs). Every number must come from a run in this session, quoted with the k6 output or Grafana query
that produced it. Record:

- **what distinguished this run** — the single infrastructure change
- **rate achieved**, and **SLO attainment twice**: client-side (k6) and server-side (Grafana)
- **p95 / p99 per class**, error rate, **error budget burned**, whether alerts fired
- **peak per-minute read and write throttle events** from CloudWatch over the run window — a run with
  throttling measured the database, not the service, and the row must say so
- **provisioned RCU/WCU** and **$/hour** at the time of the run

A result is never "N RPS". It is **"N RPS at the 55/15/25/5 mix"**.

## Phase 9 — Tear down

```bash
terraform -chdir=infra/main destroy -var-file=dev.tfvars     # approval gate

aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=Project,Values=ecs-dynamodb-rps \
  --query 'ResourceTagMappingList[].ResourceARN' --output table
```

**A clean destroy is not evidence of a clean account** — hence the sweep. **Do not delete what it
finds without asking**; a survivor may belong to another project. One thing it cannot find: after
autoscaling has run, Application Auto Scaling leaves two `TargetTracking-…` CloudWatch alarms
carrying no `Project` tag.

**The k6 project goes with the destroy**, together with its uploaded tests, settings page and run
history — `infra/k6` creates it. That is accepted: `results.md` is the record, and `/loadtest
--compare` reads it, not the cloud. The next `/env up` creates a new project with a new id and **no
tests in it**, so re-run `./scripts/upload-k6.sh` before any cloud run. (Until 2026-09-14 the
project lived in `platform/` and survived.) The Grafana folder `high-load-test` does survive; this
project's subfolder, with its dashboard, SLO and rules, goes with the destroy.

---

## Cost

| item | rate |
|---|---|
| Fargate 0.25 vCPU + 0.5 GB | $0.0142/hr |
| ALB base | $0.0270/hr |
| ALB LCU | $0.0080/LCU-hr |
| DynamoDB RCU / WCU | $0.0001586 / $0.0007930 per unit-hr |

- **Idle at 25/25:** ~**$0.055/hr**, ~$40/month. 25/25 is the DynamoDB free tier, so capacity is free;
  Fargate and the ALB are billed regardless.
- **At full capacity (1025/200):** **$0.3212/hr**, ~$234/month.

**The forgotten environment, not the load test, is the cost risk.** Prices live in `pricing.json`
with the query that produced them, never typed from memory.

## Known gaps

- **Terraform does not rebuild the container image.** Any change under `service/src/` needs
  `./scripts/deploy-service.sh`. Fails silently — the service looks healthy while running old code.
- **Uploading the k6 profiles is manual, silent when skipped, and needed after every `/env up`.**
  `grafana_k6_load_test` takes a single script string and these import from `tests/lib/`, so there is
  no Terraform resource for it. The k6 project itself is destroyed and recreated with the
  environment, so a fresh environment always starts with an empty project. `./scripts/upload-k6.sh
  --check` names anything stale — while the environment is up; with it down there is no project to
  check.
- **The k6 environment-variables settings page cannot be automated** — no API (every
  environment-variable path under `/cloud/v6` is a 404, checked 2026-09-09), no Terraform resource.
  `upload-k6.sh` works around it by baking the values into the archive.
- **The SLO window is 7 days and cannot be anything else** — the API refuses windows outside 7–32
  days and the free tier retains 14.

[dash]: https://k0valchuk.grafana.net/dashboards
[alerts]: https://k0valchuk.grafana.net/alerting/list
[slo]: https://k0valchuk.grafana.net/a/grafana-slo-app/slos
[k6]: https://k0valchuk.grafana.net/a/k6-app/projects
