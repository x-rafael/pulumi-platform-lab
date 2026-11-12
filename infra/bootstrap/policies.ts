/**
 * Trust và permission policy cho các role CI (GitHub Actions → AWS qua OIDC).
 *
 * Hai lớp quyền khác nhau:
 *   - trust policy: job nào của repo nào được assume role (aud + sub chính xác, không wildcard);
 *   - permission policy: sau khi assume thì làm được gì (giới hạn theo tên resource của worker).
 *
 * Toàn bộ là hàm thuần (không import Pulumi/AWS) để unit test trực tiếp.
 * Mẫu tên resource phải khớp infra/worker/components/LambdaWorker.ts:
 *   function / log group `/aws/lambda/…` / source queue `…-queue` / DLQ `…-dlq` / role `…-role`,
 *   đều dạng `platform-worker-<stack>`.
 */

export const OIDC_HOST = "token.actions.githubusercontent.com";
export const OIDC_AUDIENCE = "sts.amazonaws.com";
/** = SERVICE_NAME ở infra/worker/components/workerConfig.ts. */
export const SERVICE_PREFIX = "platform-worker";

/**
 * Subject mặc định của repo mới (immutable): `repo:OWNER@OWNER_ID/REPO@REPO_ID`.
 * Cố ý KHÔNG nhận dạng cũ `repo:OWNER/REPO`: tên owner/repo có thể bị đổi hoặc bị người khác đăng ký lại,
 * còn ID thì không. Lấy giá trị thật từ `GET /repos/{owner}/{repo}/actions/oidc/customization/sub`.
 */
const SUB_PREFIX_PATTERN = /^repo:[A-Za-z0-9_.-]+@[0-9]+\/[A-Za-z0-9_.-]+@[0-9]+$/;
const ACCOUNT_ID_PATTERN = /^[0-9]{12}$/;
const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-[0-9]$/;
const GITHUB_ENVIRONMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface AccountContext {
  accountId: string;
  region: string;
  /** `repo:OWNER@OWNER_ID/REPO@REPO_ID`, chưa có hậu tố `:environment:…`. */
  subPrefix: string;
}

/** Phạm vi stack mà một role được quản lý. `pr-*` = mọi PR stack (không bao gồm `prod`, vì có dấu `-`). */
export type StackScope = "dev" | "prod" | "pr-*";
export type CiRoleKind = "preview" | "deploy";

export interface CiRoleSpec {
  key: string;
  roleName: string;
  /** GitHub Environment: ra hậu tố `:environment:<name>` của sub. Mỗi role đúng một environment. */
  githubEnvironment: string;
  kind: CiRoleKind;
  scope: StackScope;
}

export const CI_ROLES: readonly CiRoleSpec[] = [
  { key: "preview", roleName: "lab-preview", githubEnvironment: "preview", kind: "preview", scope: "dev" },
  { key: "deploy-dev", roleName: "lab-deploy-dev", githubEnvironment: "dev", kind: "deploy", scope: "dev" },
  { key: "deploy-prod", roleName: "lab-deploy-prod", githubEnvironment: "prod", kind: "deploy", scope: "prod" },
  { key: "pr-env", roleName: "lab-pr-env", githubEnvironment: "pr-env", kind: "deploy", scope: "pr-*" },
];

export interface Statement {
  Sid: string;
  Effect: "Allow" | "Deny";
  Action: string[];
  Resource: string[];
  Condition?: Record<string, Record<string, string>>;
}

export interface PermissionPolicy {
  Version: "2012-10-17";
  Statement: Statement[];
}

export interface TrustPolicy {
  Version: "2012-10-17";
  Statement: Array<{
    Effect: "Allow";
    Principal: { Federated: string };
    Action: "sts:AssumeRoleWithWebIdentity";
    Condition: { StringEquals: Record<string, string> };
  }>;
}

/** IAM chỉ nhận mô tả gồm tab/LF/CR, ASCII in được và Latin-1 (U+00A1–U+00FF); ký tự như "→" bị từ chối lúc CreateRole. */
export const IAM_DESCRIPTION_PATTERN = /^[\u0009\u000A\u000D -~¡-ÿ]{0,1000}$/;

export function describeRole(spec: CiRoleSpec): string {
  return `GitHub Actions environment ${spec.githubEnvironment}: ${spec.kind} for platform-worker/${spec.scope}`;
}

export function validateContext(ctx: AccountContext): void {
  if (!ACCOUNT_ID_PATTERN.test(ctx.accountId)) {
    throw new Error(`Invalid accountId: ${JSON.stringify(ctx.accountId)} (must be 12 digits)`);
  }
  if (!REGION_PATTERN.test(ctx.region)) {
    throw new Error(`Invalid region: ${JSON.stringify(ctx.region)} (e.g. ap-southeast-1)`);
  }
  if (!SUB_PREFIX_PATTERN.test(ctx.subPrefix)) {
    throw new Error(
      `Invalid subPrefix: ${JSON.stringify(ctx.subPrefix)} (expected repo:OWNER@OWNER_ID/REPO@REPO_ID; ` +
        `read it from GET /repos/{owner}/{repo}/actions/oidc/customization/sub)`,
    );
  }
}

export function oidcProviderArn(accountId: string): string {
  return `arn:aws:iam::${accountId}:oidc-provider/${OIDC_HOST}`;
}

/** Trust policy: đúng một sub (`<prefix>:environment:<env>`) và aud `sts.amazonaws.com`, chỉ `StringEquals`. */
export function buildTrustPolicy(ctx: AccountContext, githubEnvironment: string): TrustPolicy {
  validateContext(ctx);
  if (!GITHUB_ENVIRONMENT_PATTERN.test(githubEnvironment)) {
    throw new Error(`Invalid GitHub environment name: ${JSON.stringify(githubEnvironment)}`);
  }
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Federated: oidcProviderArn(ctx.accountId) },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: {
            [`${OIDC_HOST}:aud`]: OIDC_AUDIENCE,
            [`${OIDC_HOST}:sub`]: `${ctx.subPrefix}:environment:${githubEnvironment}`,
          },
        },
      },
    ],
  };
}

/** ARN (có thể chứa wildcard `*` của IAM) của các resource worker thuộc một phạm vi stack. */
export function workerArns(ctx: AccountContext, scope: StackScope) {
  const { accountId: a, region: r } = ctx;
  const n = `${SERVICE_PREFIX}-${scope}`;
  const logGroup = `arn:aws:logs:${r}:${a}:log-group:/aws/lambda/${n}`;
  return {
    sourceQueue: `arn:aws:sqs:${r}:${a}:${n}-queue`,
    queues: [`arn:aws:sqs:${r}:${a}:${n}-queue`, `arn:aws:sqs:${r}:${a}:${n}-dlq`],
    fn: `arn:aws:lambda:${r}:${a}:function:${n}`,
    // UUID của event source mapping không chứa tên nên không giới hạn được theo ARN.
    mappings: `arn:aws:lambda:${r}:${a}:event-source-mapping:*`,
    // Cả `log-group:NAME` và `log-group:NAME:*`: API khác nhau dùng một trong hai dạng.
    logGroups: [logGroup, `${logGroup}:*`],
    // DescribeLogGroups không giới hạn được theo tên log group.
    allLogGroups: `arn:aws:logs:${r}:${a}:log-group:*`,
    role: `arn:aws:iam::${a}:role/${n}-role`,
  };
}

/** Các quyền chỉ đọc mà `pulumi preview --refresh` cần. */
function readStatements(ctx: AccountContext, scope: StackScope): Statement[] {
  const arn = workerArns(ctx, scope);
  return [
    {
      Sid: "SqsRead",
      Effect: "Allow",
      Action: ["sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:ListQueueTags"],
      Resource: arn.queues,
    },
    {
      Sid: "LambdaFunctionRead",
      Effect: "Allow",
      Action: [
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:GetFunctionCodeSigningConfig",
        "lambda:GetPolicy",
        "lambda:ListTags",
        "lambda:ListVersionsByFunction",
      ],
      Resource: [arn.fn],
    },
    {
      Sid: "LambdaMappingRead",
      Effect: "Allow",
      Action: ["lambda:GetEventSourceMapping", "lambda:ListTags"],
      Resource: [arn.mappings],
    },
    {
      // Liệt kê mapping là thao tác cấp account, không có resource-level.
      Sid: "LambdaMappingList",
      Effect: "Allow",
      Action: ["lambda:ListEventSourceMappings"],
      Resource: ["*"],
    },
    {
      Sid: "LogsDescribe",
      Effect: "Allow",
      Action: ["logs:DescribeLogGroups"],
      Resource: [arn.allLogGroups],
    },
    {
      Sid: "LogsRead",
      Effect: "Allow",
      Action: ["logs:ListTagsForResource", "logs:ListTagsLogGroup"],
      Resource: arn.logGroups,
    },
    {
      Sid: "IamWorkerRoleRead",
      Effect: "Allow",
      Action: [
        "iam:GetRole",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:ListRoleTags",
        "iam:ListInstanceProfilesForRole",
      ],
      Resource: [arn.role],
    },
  ];
}

/**
 * Quyền ghi để create/update/destroy worker, kèm quyền smoke test (gửi message, đọc log).
 * Mỗi action tạo resource đều đi kèm action gắn tag tương ứng, vì worker gắn tags khi tạo:
 *   sqs:CreateQueue→TagQueue, lambda:CreateFunction→TagResource, logs:CreateLogGroup→TagResource,
 *   iam:CreateRole→TagRole, lambda:CreateEventSourceMapping→TagResource.
 */
function writeStatements(ctx: AccountContext, scope: StackScope): Statement[] {
  const arn = workerArns(ctx, scope);
  return [
    {
      Sid: "SqsLifecycle",
      Effect: "Allow",
      Action: [
        "sqs:CreateQueue",
        "sqs:DeleteQueue",
        "sqs:SetQueueAttributes",
        "sqs:TagQueue",
        "sqs:UntagQueue",
      ],
      Resource: arn.queues,
    },
    {
      // Smoke test: chỉ gửi vào source queue của chính stack, không phải DLQ.
      Sid: "SqsSmokeTestSend",
      Effect: "Allow",
      Action: ["sqs:SendMessage"],
      Resource: [arn.sourceQueue],
    },
    {
      Sid: "LambdaFunctionLifecycle",
      Effect: "Allow",
      Action: [
        "lambda:CreateFunction",
        "lambda:DeleteFunction",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:TagResource",
        "lambda:UntagResource",
      ],
      Resource: [arn.fn],
    },
    {
      // CreateEventSourceMapping không hỗ trợ resource-level (ARN của mapping chưa tồn tại lúc tạo): với
      // Resource là ARN mapping, IAM policy simulator trả implicitDeny, nên bắt buộc Resource "*".
      // Phạm vi được giữ bằng điều kiện lambda:FunctionArn (chỉ tạo mapping trỏ tới function của stack).
      Sid: "LambdaMappingCreate",
      Effect: "Allow",
      Action: ["lambda:CreateEventSourceMapping"],
      Resource: ["*"],
      Condition: { ArnLike: { "lambda:FunctionArn": arn.fn } },
    },
    {
      // Update thì có resource-level (đã kiểm bằng simulator), vẫn ràng buộc theo function đích.
      // Get/Delete/Tag của mapping không ràng buộc được theo tên (UUID).
      Sid: "LambdaMappingUpdate",
      Effect: "Allow",
      Action: ["lambda:UpdateEventSourceMapping"],
      Resource: [arn.mappings],
      Condition: { ArnLike: { "lambda:FunctionArn": arn.fn } },
    },
    {
      Sid: "LambdaMappingDeleteTag",
      Effect: "Allow",
      Action: ["lambda:DeleteEventSourceMapping", "lambda:TagResource", "lambda:UntagResource"],
      Resource: [arn.mappings],
    },
    {
      // AccessDenied thật ở lần destroy đầu tiên bằng role CI (PR environment, 2026-11-12): sau khi xoá mapping, provider
      // poll GetEventSourceMapping cho tới khi báo "không còn". Lúc mapping đã hết, ARN theo UUID không còn nên IAM đánh giá
      // lời gọi với Resource "*" ("on resource: *"), trong khi Get chỉ được Allow trên event-source-mapping:*. Chỉ đọc metadata;
      // Create/Update/Delete vẫn bị ràng buộc như trên. Role preview không có statement này (không xoá gì).
      Sid: "LambdaMappingGetAfterDelete",
      Effect: "Allow",
      Action: ["lambda:GetEventSourceMapping"],
      Resource: ["*"],
    },
    {
      Sid: "LogsLifecycle",
      Effect: "Allow",
      Action: [
        "logs:CreateLogGroup",
        "logs:DeleteLogGroup",
        "logs:PutRetentionPolicy",
        "logs:DeleteRetentionPolicy",
        "logs:TagResource",
        "logs:UntagResource",
        "logs:TagLogGroup",
        "logs:UntagLogGroup",
      ],
      Resource: arn.logGroups,
    },
    {
      // Smoke test: đọc log của chính function để tìm eventId.
      Sid: "LogsSmokeTestRead",
      Effect: "Allow",
      Action: ["logs:DescribeLogStreams", "logs:FilterLogEvents", "logs:GetLogEvents"],
      Resource: arn.logGroups,
    },
    {
      Sid: "IamWorkerRoleLifecycle",
      Effect: "Allow",
      Action: [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:UpdateAssumeRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:TagRole",
        "iam:UntagRole",
      ],
      Resource: [arn.role],
    },
    {
      // Chỉ được "đưa" đúng execution role của worker, và chỉ cho Lambda.
      Sid: "IamPassWorkerRoleToLambda",
      Effect: "Allow",
      Action: ["iam:PassRole"],
      Resource: [arn.role],
      Condition: { StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" } },
    },
  ];
}

/**
 * Deny tường minh cho mọi role CI: không sửa được role `lab-*` (kể cả trust policy của chính nó)
 * lẫn OIDC provider, kể cả khi sau này ai đó thêm một Allow rộng.
 */
function guardrailStatements(ctx: AccountContext): Statement[] {
  return [
    {
      Sid: "DenyCiAccessPathChanges",
      Effect: "Deny",
      Action: ["iam:*"],
      Resource: [`arn:aws:iam::${ctx.accountId}:role/lab-*`, oidcProviderArn(ctx.accountId)],
    },
  ];
}

export function buildPermissionPolicy(ctx: AccountContext, spec: CiRoleSpec): PermissionPolicy {
  validateContext(ctx);
  const statements = [
    ...readStatements(ctx, spec.scope),
    ...(spec.kind === "deploy" ? writeStatements(ctx, spec.scope) : []),
    ...guardrailStatements(ctx),
  ];
  return { Version: "2012-10-17", Statement: statements };
}
