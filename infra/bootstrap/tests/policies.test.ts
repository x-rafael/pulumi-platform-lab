import { describe, expect, test } from "vitest";
import {
  CI_ROLES,
  type AccountContext,
  type CiRoleSpec,
  type PermissionPolicy,
  type Statement,
  buildPermissionPolicy,
  buildTrustPolicy,
  describeRole,
  IAM_DESCRIPTION_PATTERN,
  oidcProviderArn,
  workerArns,
} from "../policies.js";

const CTX: AccountContext = {
  accountId: "123456789012",
  region: "ap-southeast-1",
  subPrefix: "repo:owner@111/repo@222",
};

const role = (name: string): CiRoleSpec => {
  const found = CI_ROLES.find((r) => r.roleName === name);
  if (!found) throw new Error(`no role ${name}`);
  return found;
};

/** Khớp wildcard của IAM: `*` = chuỗi bất kỳ, `?` = một ký tự; phân biệt hoa thường. */
function iamGlob(pattern: string, value: string): boolean {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${re}$`).test(value);
}

const allows = (policy: PermissionPolicy) => policy.Statement.filter((s) => s.Effect === "Allow");
const resourcesOf = (statements: Statement[]) => statements.flatMap((s) => s.Resource);
/**
 * Có Allow nào cho phép `arn` không, xét theo pattern resource.
 * Bỏ qua hai statement "liệt kê" mà AWS không cho giới hạn theo tên: `logs:DescribeLogGroups` (nằm trên
 * `log-group:*`) và `lambda:ListEventSourceMappings` (Resource `*`). Chúng chỉ liệt kê metadata, không
 * đọc/ghi dữ liệu, và là giới hạn đã biết ghi ở docs/ci-access.md. Resource `*` khớp mọi ARN nên nếu
 * không loại ra thì phép kiểm tra phạm vi vô nghĩa.
 */
const DISCOVERY_ACTIONS = new Set([
  "logs:DescribeLogGroups",
  "lambda:ListEventSourceMappings",
  // Resource "*" bắt buộc (không có resource-level), phạm vi nằm ở điều kiện lambda:FunctionArn; có test riêng.
  "lambda:CreateEventSourceMapping",
]);
const anyAllowMatches = (policy: PermissionPolicy, arn: string) =>
  resourcesOf(allows(policy).filter((s) => !s.Action.every((a) => DISCOVERY_ACTIONS.has(a)))).some((p) =>
    iamGlob(p, arn),
  );

/** Tên thật mà worker tạo cho một stack (xem infra/worker/components/LambdaWorker.ts). */
function actualNames(stack: string, ctx: AccountContext = CTX) {
  const { accountId: a, region: r } = ctx;
  const n = `platform-worker-${stack}`;
  return {
    sourceQueue: `arn:aws:sqs:${r}:${a}:${n}-queue`,
    dlq: `arn:aws:sqs:${r}:${a}:${n}-dlq`,
    fn: `arn:aws:lambda:${r}:${a}:function:${n}`,
    logGroup: `arn:aws:logs:${r}:${a}:log-group:/aws/lambda/${n}`,
    logGroupStar: `arn:aws:logs:${r}:${a}:log-group:/aws/lambda/${n}:*`,
    role: `arn:aws:iam::${a}:role/${n}-role`,
  };
}

describe("CI_ROLES", () => {
  test("đúng bốn role, mỗi role một GitHub environment riêng", () => {
    expect(CI_ROLES.map((r) => r.roleName)).toEqual(["lab-preview", "lab-deploy-dev", "lab-deploy-prod", "lab-pr-env"]);
    expect(CI_ROLES.map((r) => r.githubEnvironment)).toEqual(["preview", "dev", "prod", "pr-env"]);
    expect(new Set(CI_ROLES.map((r) => r.githubEnvironment)).size).toBe(CI_ROLES.length);
  });
});

describe("mô tả role", () => {
  test.each(CI_ROLES.map((r) => [r.roleName, r] as const))("%s: mô tả hợp lệ với ràng buộc ký tự của IAM", (_name, spec) => {
    expect(describeRole(spec)).toMatch(IAM_DESCRIPTION_PATTERN);
  });

  test("bộ kiểm tra bắt được ký tự mà IAM đã từ chối ở lần apply đầu tiên", () => {
    expect("preview → platform-worker").not.toMatch(IAM_DESCRIPTION_PATTERN);
    expect("preview -> platform-worker/dev").toMatch(IAM_DESCRIPTION_PATTERN);
  });
});

describe("trust policy", () => {
  test.each(CI_ROLES.map((r) => [r.roleName, r.githubEnvironment]))(
    "%s: đúng một sub `<prefix>:environment:%s` và aud sts.amazonaws.com",
    (_name, env) => {
      const policy = buildTrustPolicy(CTX, env);
      expect(policy.Statement).toHaveLength(1);
      const [s] = policy.Statement;
      expect(s.Effect).toBe("Allow");
      expect(s.Action).toBe("sts:AssumeRoleWithWebIdentity");
      expect(s.Principal).toEqual({ Federated: oidcProviderArn(CTX.accountId) });
      expect(s.Condition).toEqual({
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": `repo:owner@111/repo@222:environment:${env}`,
        },
      });
    },
  );

  test("chỉ StringEquals, không wildcard trong trust policy", () => {
    for (const r of CI_ROLES) {
      const policy = buildTrustPolicy(CTX, r.githubEnvironment);
      const text = JSON.stringify(policy);
      expect(Object.keys(policy.Statement[0].Condition)).toEqual(["StringEquals"]);
      expect(text).not.toContain("StringLike");
      expect(text).not.toContain("*");
    }
  });

  test("sub của các role khác nhau từng đôi một", () => {
    const subs = CI_ROLES.map(
      (r) => buildTrustPolicy(CTX, r.githubEnvironment).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"],
    );
    expect(new Set(subs).size).toBe(CI_ROLES.length);
  });

  test.each([
    ["dạng cũ chưa có ID", "repo:owner/repo"],
    ["thiếu repo ID", "repo:owner@111/repo"],
    ["thiếu owner ID", "repo:owner/repo@222"],
    ["wildcard", "repo:owner@111/*"],
    ["wildcard owner", "repo:*@111/repo@222"],
    ["đã có hậu tố environment", "repo:owner@111/repo@222:environment:dev"],
    ["đã có dấu hai chấm cuối", "repo:owner@111/repo@222:"],
    ["ID không phải số", "repo:owner@abc/repo@222"],
    ["khoảng trắng", "repo:owner@111/re po@222"],
    ["rỗng", ""],
  ])("từ chối subPrefix: %s", (_label, subPrefix) => {
    expect(() => buildTrustPolicy({ ...CTX, subPrefix }, "dev")).toThrow("Invalid subPrefix");
  });

  test("từ chối account ID, region và tên environment sai", () => {
    expect(() => buildTrustPolicy({ ...CTX, accountId: "1234" }, "dev")).toThrow("Invalid accountId");
    expect(() => buildTrustPolicy({ ...CTX, region: "sg" }, "dev")).toThrow("Invalid region");
    expect(() => buildTrustPolicy(CTX, "dev*")).toThrow("Invalid GitHub environment name");
    expect(() => buildTrustPolicy(CTX, "")).toThrow("Invalid GitHub environment name");
  });
});

describe("permission policy: cấu trúc chung", () => {
  const policies = CI_ROLES.map((r) => [r.roleName, buildPermissionPolicy(CTX, r)] as const);

  test.each(policies)("%s: không có action wildcard trong Allow", (_name, policy) => {
    for (const s of allows(policy)) {
      for (const action of s.Action) {
        expect(action, s.Sid).not.toBe("*");
        expect(action, s.Sid).not.toMatch(/\*$/);
      }
    }
  });

  test.each(policies)("%s: resource '*' chỉ cho List mapping và Create mapping (có điều kiện function)", (_name, policy) => {
    for (const s of allows(policy)) {
      if (!s.Resource.includes("*")) continue;
      expect(["lambda:ListEventSourceMappings", "lambda:CreateEventSourceMapping"], s.Sid).toEqual(
        expect.arrayContaining(s.Action),
      );
      // Create trên '*' mà không có điều kiện FunctionArn sẽ cho tạo mapping tới bất kỳ function nào.
      if (s.Action.includes("lambda:CreateEventSourceMapping")) {
        expect(s.Condition, s.Sid).toEqual({ ArnLike: { "lambda:FunctionArn": expect.stringContaining("function:platform-worker-") } });
      }
    }
  });

  test.each(policies)("%s: Sid không trùng, không có action IAM rộng nào được Allow", (_name, policy) => {
    const sids = policy.Statement.map((s) => s.Sid);
    expect(new Set(sids).size).toBe(sids.length);
    const iamAllowed = allows(policy).flatMap((s) => s.Action).filter((a) => a.startsWith("iam:"));
    for (const forbidden of ["iam:CreatePolicy", "iam:CreatePolicyVersion", "iam:AttachRolePolicy", "iam:CreateOpenIDConnectProvider"]) {
      expect(iamAllowed).not.toContain(forbidden);
    }
  });

  test.each(policies)("%s: nằm trong giới hạn kích thước inline policy (10.240 ký tự)", (_name, policy) => {
    expect(JSON.stringify(policy).length).toBeLessThan(10_240);
  });

  test.each(policies)("%s: có Deny iam:* trên role lab-* và OIDC provider", (_name, policy) => {
    const denies = policy.Statement.filter((s) => s.Effect === "Deny");
    expect(denies).toHaveLength(1);
    expect(denies[0].Action).toEqual(["iam:*"]);
    expect(denies[0].Resource).toEqual([
      `arn:aws:iam::${CTX.accountId}:role/lab-*`,
      oidcProviderArn(CTX.accountId),
    ]);
  });

  test.each(policies)("%s: không Allow nào chạm vào role lab-* hay OIDC provider", (_name, policy) => {
    for (const target of [
      ...CI_ROLES.map((r) => `arn:aws:iam::${CTX.accountId}:role/${r.roleName}`),
      oidcProviderArn(CTX.accountId),
    ]) {
      expect(anyAllowMatches(policy, target), target).toBe(false);
    }
  });
});

describe("lab-preview: chỉ đọc, chỉ stack dev", () => {
  const policy = buildPermissionPolicy(CTX, role("lab-preview"));

  test("mọi Allow là Get/List/Describe", () => {
    for (const s of allows(policy)) {
      for (const action of s.Action) {
        expect(action, `${s.Sid}: ${action}`).toMatch(/^[a-z0-9]+:(Get|List|Describe)/);
      }
    }
  });

  test("không có action ghi, kể cả SendMessage/FilterLogEvents của smoke test", () => {
    const actions = new Set(allows(policy).flatMap((s) => s.Action));
    for (const a of ["sqs:SendMessage", "logs:FilterLogEvents", "logs:GetLogEvents", "iam:PassRole", "lambda:TagResource"]) {
      expect(actions.has(a), a).toBe(false);
    }
  });

  test("đọc được resource của stack dev, không đọc stack khác", () => {
    const dev = actualNames("dev");
    for (const arn of [dev.sourceQueue, dev.dlq, dev.fn, dev.logGroup, dev.role]) {
      expect(anyAllowMatches(policy, arn), arn).toBe(true);
    }
    for (const stack of ["prod", "test", "pr-12"]) {
      const other = actualNames(stack);
      for (const arn of [other.sourceQueue, other.dlq, other.fn, other.logGroup, other.role]) {
        expect(anyAllowMatches(policy, arn), arn).toBe(false);
      }
    }
  });
});

describe("role deploy: phạm vi theo stack", () => {
  // [role, stack được quản lý, các stack KHÔNG được chạm]
  const cases: Array<[string, string[], string[]]> = [
    ["lab-deploy-dev", ["dev"], ["prod", "test", "pr-12", "pr-1", "devx"]],
    ["lab-deploy-prod", ["prod"], ["dev", "test", "pr-12", "prod2", "preprod"]],
    // `pr-*` phải không khớp `prod`/`preprod`: mẫu có dấu gạch ngang sau `pr`.
    ["lab-pr-env", ["pr-12", "pr-1", "pr-999999999"], ["dev", "prod", "test", "prod-2", "pr"]],
  ];

  test.each(cases)("%s: quản lý đúng stack của mình, không chạm stack khác", (name, own, others) => {
    const policy = buildPermissionPolicy(CTX, role(name));
    const keys = ["sourceQueue", "dlq", "fn", "logGroup", "logGroupStar", "role"] as const;
    for (const stack of own) {
      const names = actualNames(stack);
      for (const k of keys) expect(anyAllowMatches(policy, names[k]), `${name} ${stack} ${k}`).toBe(true);
    }
    for (const stack of others) {
      const names = actualNames(stack);
      for (const k of keys) expect(anyAllowMatches(policy, names[k]), `${name} !${stack} ${k}`).toBe(false);
    }
  });

  test.each(cases)("%s: ghi tag đi kèm mỗi action tạo resource", (name) => {
    const actions = new Set(allows(buildPermissionPolicy(CTX, role(name))).flatMap((s) => s.Action));
    const pairs: Array<[string, string]> = [
      ["sqs:CreateQueue", "sqs:TagQueue"],
      ["lambda:CreateFunction", "lambda:TagResource"],
      ["lambda:CreateEventSourceMapping", "lambda:TagResource"],
      ["logs:CreateLogGroup", "logs:TagResource"],
      ["iam:CreateRole", "iam:TagRole"],
    ];
    for (const [create, tag] of pairs) {
      expect(actions.has(create), create).toBe(true);
      expect(actions.has(tag), `${create} cần ${tag}`).toBe(true);
    }
  });

  test.each(cases)("%s: PassRole chỉ cho đúng role của worker và chỉ tới Lambda", (name) => {
    const policy = buildPermissionPolicy(CTX, role(name));
    const withPass = allows(policy).filter((s) => s.Action.includes("iam:PassRole"));
    expect(withPass).toHaveLength(1);
    expect(withPass[0].Action).toEqual(["iam:PassRole"]);
    expect(withPass[0].Resource).toEqual([workerArns(CTX, role(name).scope).role]);
    expect(withPass[0].Condition).toEqual({ StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" } });
  });

  test.each(cases)("%s: event source mapping Create/Update bị ràng buộc theo function của stack", (name) => {
    const policy = buildPermissionPolicy(CTX, role(name));
    const create = allows(policy).find((s) => s.Action.includes("lambda:CreateEventSourceMapping"));
    expect(create?.Condition).toEqual({ ArnLike: { "lambda:FunctionArn": workerArns(CTX, role(name).scope).fn } });
  });

  test.each(cases)("%s: smoke test chỉ gửi vào source queue, không gửi vào DLQ", (name, own) => {
    const policy = buildPermissionPolicy(CTX, role(name));
    const names = actualNames(own[0]);
    const send = allows(policy).filter((s) => s.Action.includes("sqs:SendMessage"));
    expect(send).toHaveLength(1);
    expect(send[0].Resource.some((p) => iamGlob(p, names.sourceQueue))).toBe(true);
    expect(send[0].Resource.some((p) => iamGlob(p, names.dlq))).toBe(false);
  });

  test("preview không có quyền ghi nào mà deploy-dev có", () => {
    const preview = new Set(allows(buildPermissionPolicy(CTX, role("lab-preview"))).flatMap((s) => s.Action));
    const deploy = new Set(allows(buildPermissionPolicy(CTX, role("lab-deploy-dev"))).flatMap((s) => s.Action));
    for (const a of ["sqs:CreateQueue", "lambda:CreateFunction", "iam:CreateRole", "iam:PassRole", "logs:CreateLogGroup"]) {
      expect(preview.has(a), a).toBe(false);
      expect(deploy.has(a), a).toBe(true);
    }
  });
});

describe("workerArns", () => {
  test("dev và prod là tên chính xác, pr-* là mẫu có dấu gạch ngang", () => {
    expect(workerArns(CTX, "dev").fn).toBe("arn:aws:lambda:ap-southeast-1:123456789012:function:platform-worker-dev");
    expect(workerArns(CTX, "prod").role).toBe("arn:aws:iam::123456789012:role/platform-worker-prod-role");
    expect(workerArns(CTX, "pr-*").fn).toBe("arn:aws:lambda:ap-southeast-1:123456789012:function:platform-worker-pr-*");
    expect(workerArns(CTX, "pr-*").queues).toEqual([
      "arn:aws:sqs:ap-southeast-1:123456789012:platform-worker-pr-*-queue",
      "arn:aws:sqs:ap-southeast-1:123456789012:platform-worker-pr-*-dlq",
    ]);
  });
});
