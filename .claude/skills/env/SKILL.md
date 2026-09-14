---
name: env
description: Bring a project environment up or down with Terraform, with an approval gate before apply/destroy and a billable-resource sweep after teardown. Use whenever provisioning, tearing down, or checking what is currently running in AWS for a project in this repo.
---

# Environment lifecycle

Usage: `/env up <project>` · `/env down <project>` · `/env status [project]`

`<project>` is a top-level directory named for its scenario (e.g. `ecs-document-db`,
`lambda-concurrency-limit`) — never a bare platform name. The root module lives in
`<project>/infra/main`, and it calls `<project>/infra/grafana` and `<project>/infra/k6` as modules.
If the directory does not exist, stop and say so — do not scaffold one here; that belongs in a plan.

`<project>/infra/k6` **creates the project's Grafana Cloud k6 project**, so `up` creates it with a
new id and `down` destroys it — together with the load tests uploaded into it and its run history.
After every `up`, the profiles have to be uploaded again before a cloud run can start
(`<project>/scripts/upload-k6.sh`). This has been the case since 2026-09-14; before that the k6
project lived in `platform/` and survived teardown.

`platform/` is **not** a project and is not part of `/env up|down`. It is a long-lived root module
that owns the Terraform Cloud project, the per-project workspaces, the shared variable set and the
Grafana folder `high-load-test` — the things a project workspace needs to exist *before* `/env up`
can run. Bring it up by hand, once:

```bash
terraform -chdir=platform apply
```

Every root module names its own Terraform Cloud workspace in its `cloud { workspaces { name = … } }`
block, so nothing needs to be set or unset in the shell first. (Before 2026-09-09 the root `.env`
exported one repo-wide `TF_WORKSPACE` and this command needed `env -u TF_WORKSPACE` to escape it.)
See `platform/README.md`.

## `up`

1. **Preflight — assert the account before anything else.**

```bash
[ -n "$AWS_ACCESS_KEY_ID" ] || { echo "no AWS creds loaded — source .env / direnv allow"; exit 1; }
ACTUAL=$(aws sts get-caller-identity --query Account --output text)
[ "$ACTUAL" = "$AWS_ACCOUNT_ID" ] || { echo "WRONG ACCOUNT: $ACTUAL != $AWS_ACCOUNT_ID"; exit 1; }
echo "account $ACTUAL confirmed"
```

   This machine has ~/.aws profiles including a `[default]`, so a shell without `.env` loaded does not
   fail — it silently authenticates as a different account. Never skip this check, and never substitute
   remembering that you checked earlier in the session. Also confirm the Terraform Cloud workspace.

2. `terraform -chdir=<project>/infra/main fmt -check` then `validate`. Fix failures before continuing.
3. `terraform -chdir=<project>/infra/main plan -var-file=<env>.tfvars -out=tfplan`
4. **Summarize the plan in chat**: counts of add/change/destroy, and name every resource that costs
   money while idle — NAT gateways, RDS/DocumentDB instances, ALBs, provisioned DynamoDB capacity.
5. **STOP. Get explicit approval.** Apply creates billable resources; per CLAUDE.md this is a hard
   gate that a running plan does not get to skip.
6. `terraform -chdir=<project>/infra/main apply tfplan`
7. Report the outputs the load test needs (base URL, DB endpoint) and note the time the environment
   came up, so idle cost is visible later.

## `down`

1. `terraform -chdir=<project>/infra/main destroy -var-file=<env>.tfvars` — **stop for approval first**;
   this deletes data.
2. **Then sweep.** `terraform destroy` reporting success is not evidence the account is clean:
   resources created outside the state, or with `prevent_destroy`/retain semantics, survive it.

### The sweep

Primary check — every resource in this repo must carry a `Project` tag (see CLAUDE.md), so one call
finds anything left behind:

```bash
aws resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=<project> \
  --query 'ResourceTagMappingList[].ResourceARN' --output table
```

Then the known survivors, which are frequently untagged because AWS creates them implicitly:

```bash
aws ec2 describe-nat-gateways --filter Name=state,Values=available \
  --query 'NatGateways[].[NatGatewayId,VpcId]' --output table   # ~$32/mo each
aws ec2 describe-addresses --query 'Addresses[?AssociationId==null].[PublicIp,AllocationId]' \
  --output table                                                 # unattached EIPs still bill
aws rds describe-db-snapshots --snapshot-type manual \
  --query 'DBSnapshots[].DBSnapshotIdentifier' --output table
aws rds describe-db-cluster-snapshots --snapshot-type manual \
  --query 'DBClusterSnapshots[].DBClusterSnapshotIdentifier' --output table   # DocumentDB too
aws logs describe-log-groups --query 'logGroups[].logGroupName' --output table
aws ecr describe-repositories --query 'repositories[].repositoryName' --output table
```

Then Grafana Cloud k6. The destroy deletes the project's k6 project, and the tag query above cannot see
Grafana Cloud at all, so a k6 project that survived would be invisible without this. A leftover one
does not bill — k6 meters virtual-user-hours per run — but it is an orphan outside Terraform, which is
exactly what the sweep exists to find. Credentials come from the root `.env` (the sweep runs locally):

```bash
curl -sS -H "Authorization: Bearer $K6_CLOUD_TOKEN" -H "X-Stack-Id: $GRAFANA_STACK_ID" \
  "https://api.k6.io/cloud/v6/projects" \
  | jq -r --arg p "<project>" '.value[] | select(.name == $p) | "\(.id)  \(.name)  created \(.created)"'
```

Empty output is the pass. A curl error or a `jq` parse error means `K6_CLOUD_TOKEN` or
`GRAFANA_STACK_ID` is not loaded — that is a failure of **the sweep**, not of the destroy; report it
as "k6 not checked", never as clean.

Report findings as a list with the reason each one costs money (or, for a k6 project, that it is an
untracked orphan). Do **not** delete anything found in the sweep without asking — a survivor may
belong to another project in this account.

## `status`

Run the tag query, the NAT/EIP/RDS checks and the k6 project query without touching Terraform. Use
this to answer "is anything still running?" — and answer it with command output, never from memory
of an earlier teardown. While an environment is up, its k6 project existing is expected; after a
`down`, it is not.
