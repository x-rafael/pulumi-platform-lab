import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import {
  CI_ROLES,
  OIDC_AUDIENCE,
  OIDC_HOST,
  type AccountContext,
  buildPermissionPolicy,
  buildTrustPolicy,
  describeRole,
} from "./policies";

/**
 * Bootstrap truy cập CI: OIDC provider + role cho GitHub Actions.
 *
 * Tách khỏi stack worker có chủ đích: `destroy` worker không được cắt đường vào của CI.
 * Chỉ admin chạy project này ở máy local (profile SSO); CI không có quyền sửa nó
 * (policy của mọi role CI có Deny `iam:*` trên role `lab-*` và OIDC provider).
 *
 * Config:
 *   aws:region                         vd ap-southeast-1
 *   platform-ci-bootstrap:githubSubPrefix   `repo:OWNER@OWNER_ID/REPO@REPO_ID`, lấy từ
 *       gh api repos/OWNER/REPO/actions/oidc/customization/sub --jq .sub_claim_prefix
 * Account ID lấy lúc chạy từ credentials hiện tại, không lưu trong config/repo.
 */
const config = new pulumi.Config();
const subPrefix = config.require("githubSubPrefix");
const region = new pulumi.Config("aws").require("region");

const tags = {
  ManagedBy: "Pulumi",
  Purpose: "ci-oidc",
  Project: "platform-ci-bootstrap",
};

const accountId = aws.getCallerIdentityOutput().accountId;

// Không đặt thumbprintLists: AWS tự xác thực chứng chỉ của GitHub bằng thư viện CA tin cậy.
// protect: provider dùng chung cho các lab sau (Day 5/6), không để bị xoá nhầm cùng worker.
const provider = new aws.iam.OpenIdConnectProvider(
  "github-actions",
  { url: `https://${OIDC_HOST}`, clientIdLists: [OIDC_AUDIENCE], tags },
  { protect: true },
);

const roleArns: Record<string, pulumi.Output<string>> = {};

for (const spec of CI_ROLES) {
  const ctx: pulumi.Output<AccountContext> = accountId.apply((id) => ({
    accountId: id,
    region,
    subPrefix,
  }));

  const role = new aws.iam.Role(
    spec.roleName,
    {
      name: spec.roleName,
      description: describeRole(spec),
      assumeRolePolicy: ctx.apply((c) => JSON.stringify(buildTrustPolicy(c, spec.githubEnvironment))),
      maxSessionDuration: 3600,
      tags: { ...tags, GitHubEnvironment: spec.githubEnvironment },
    },
    // Role cần provider tồn tại trước, nếu không CreateRole báo principal không hợp lệ.
    { dependsOn: [provider], protect: true },
  );

  new aws.iam.RolePolicy(`${spec.roleName}-permissions`, {
    name: "permissions",
    role: role.name,
    policy: ctx.apply((c) => JSON.stringify(buildPermissionPolicy(c, spec))),
  });

  roleArns[spec.roleName] = role.arn;
}

export const oidcProviderArn = provider.arn;
export const githubSubPrefix = subPrefix;
export const ciRoleArns = pulumi.output(roleArns);
