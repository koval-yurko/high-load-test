# HCP Terraform dynamic provider credentials: an IAM OIDC provider that trusts
# app.terraform.io, and two roles per project workspace. A remote run exchanges its
# signed workload identity token for role credentials that last one hour, so no
# long-lived AWS key is stored in HCP (platform security review, 2026-09-24; this
# reverses Tier 3 item 2.3 of the restructure spec, which declined OIDC).
#
# Each role trusts exactly one workspace and one run phase, through the token's
# `sub` claim:
#   organization:<org>:project:high-load-test:workspace:<project>:run_phase:<phase>
#
#   plan   ReadOnlyAccess       -- what refresh and data sources need. Anyone who can
#                                  queue a plan can run arbitrary configuration, so
#                                  this is all such a run can ever do in AWS.
#   apply  AdministratorAccess  -- unchanged from the IAM user keys it replaces. The
#                                  projects create IAM roles, VPCs, ECS, RDS, Lambda,
#                                  so narrowing it is its own piece of work.

data "aws_caller_identity" "current" {}

locals {
  run_roles = {
    for pair in setproduct(keys(local.projects), ["plan", "apply"]) :
    "${pair[0]}/${pair[1]}" => { project = pair[0], phase = pair[1] }
  }
  run_role_policy = {
    plan  = "arn:aws:iam::aws:policy/ReadOnlyAccess"
    apply = "arn:aws:iam::aws:policy/AdministratorAccess"
  }
}

# One per account per URL. If the account already has one for app.terraform.io
# (created by hand or another stack), the create fails with EntityAlreadyExists:
# import it rather than deleting it -- `terraform -chdir=platform import
# aws_iam_openid_connect_provider.hcp_terraform <arn>`.
resource "aws_iam_openid_connect_provider" "hcp_terraform" {
  url            = "https://app.terraform.io"
  client_id_list = ["aws.workload.identity"]
  # thumbprint_list omitted: IAM validates app.terraform.io against its own trusted
  # CA store, and aws provider 6.x computes the field.

  lifecycle {
    # Same guard the projects put on aws_vpc.main: the .env keys this stack runs with
    # must belong to the account the workspaces are told about.
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.aws_account_id
      error_message = "Refusing to plan against account ${data.aws_caller_identity.current.account_id}; the workspaces are told aws_account_id = ${var.aws_account_id}. Check which credentials this shell carries."
    }
  }
}

data "aws_iam_policy_document" "run_trust" {
  for_each = local.run_roles

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.hcp_terraform.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "app.terraform.io:aud"
      values   = ["aws.workload.identity"]
    }

    condition {
      test     = "StringEquals"
      variable = "app.terraform.io:sub"
      values   = ["organization:${var.tfc_organization}:project:${tfe_project.this.name}:workspace:${tfe_workspace.project[each.value.project].name}:run_phase:${each.value.phase}"]
    }
  }
}

resource "aws_iam_role" "run" {
  for_each = local.run_roles

  name               = "hcp-${each.value.project}-${each.value.phase}"
  description        = "HCP Terraform ${each.value.phase} phase of workspace ${each.value.project}. Managed by platform/aws.tf."
  assume_role_policy = data.aws_iam_policy_document.run_trust[each.key].json
}

resource "aws_iam_role_policy_attachment" "run" {
  for_each = local.run_roles

  role       = aws_iam_role.run[each.key].name
  policy_arn = local.run_role_policy[each.value.phase]
}
