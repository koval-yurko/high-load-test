---
name: env
description: Bring a project environment up or down with Terraform, with an approval gate before apply/destroy and a billable-resource sweep after teardown. Use whenever provisioning, tearing down, or checking what is currently running in AWS for a project in this repo.
---

# Environment lifecycle

Usage: `/env up <project>` · `/env down <project>` · `/env status [project]`

`<project>` is a top-level directory named for its scenario (e.g. `ecs-document-db`,
`lambda-concurrency-limit`) — never a bare platform name. Terraform lives in `<project>/terraform`.
If the directory does not exist, stop and say so — do not scaffold one here; that belongs in a plan.

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

2. `terraform -chdir=<project>/terraform fmt -check` then `validate`. Fix failures before continuing.
3. `terraform -chdir=<project>/terraform plan -var-file=<env>.tfvars -out=tfplan`
4. **Summarize the plan in chat**: counts of add/change/destroy, and name every resource that costs
   money while idle — NAT gateways, RDS/DocumentDB instances, ALBs, provisioned DynamoDB capacity.
5. **STOP. Get explicit approval.** Apply creates billable resources; per CLAUDE.md this is a hard
   gate that a running plan does not get to skip.
6. `terraform -chdir=<project>/terraform apply tfplan`
7. Report the outputs the load test needs (base URL, DB endpoint) and note the time the environment
   came up, so idle cost is visible later.

## `down`

1. `terraform -chdir=<project>/terraform destroy -var-file=<env>.tfvars` — **stop for approval first**;
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

Report findings as a list with the reason each one costs money. Do **not** delete anything found in
the sweep without asking — a survivor may belong to another project in this account.

## `status`

Run the tag query and the NAT/EIP/RDS checks without touching Terraform. Use this to answer "is
anything still running?" — and answer it with command output, never from memory of an earlier teardown.
