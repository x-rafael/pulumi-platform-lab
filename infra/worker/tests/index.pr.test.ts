import * as pulumi from "@pulumi/pulumi";
import { beforeAll, expect, test, vi } from "vitest";
import { MOCK_PROJECT, type MockRuntime, resolveOutput, setupMocks } from "./mocks.js";

// Caller thật với stack `pr-12`. Stack mock cố định theo file nên `dev` nằm ở index.test.ts.
let runtime: MockRuntime;
beforeAll(() => {
  runtime = setupMocks("pr-12");
});

const setConfig = (cfg: Record<string, string>) =>
  pulumi.runtime.setAllConfig(Object.fromEntries(Object.entries(cfg).map(([k, v]) => [`${MOCK_PROJECT}:${k}`, v])));

const PR = { prNumber: "12", expiresAt: "2026-11-13T10:00:00Z" };
const FUNCTION = "aws:lambda/function:Function";

// Các ca lỗi chạy trước: chúng throw trước khi tạo resource nào.
test("pr-12 thiếu prNumber/expiresAt → bị chặn, không tạo resource", async () => {
  for (const [cfg, message] of [
    [{ environment: "dev" }, 'Invalid config "prNumber"'],
    [{ environment: "dev", prNumber: "12" }, 'Invalid config "expiresAt"'],
    [{ environment: "dev", expiresAt: PR.expiresAt }, 'Invalid config "prNumber"'],
  ] as const) {
    setConfig(cfg);
    vi.resetModules();
    await expect(import("../index.js")).rejects.toThrow(message);
  }
  expect(runtime.ofType(FUNCTION)).toEqual([]);
});

test("pr-12 với prNumber khác tên stack → bị chặn", async () => {
  setConfig({ environment: "dev", prNumber: "13", expiresAt: PR.expiresAt });
  vi.resetModules();
  await expect(import("../index.js")).rejects.toThrow('Config "prNumber" (13) does not match stack "pr-12"');
  expect(runtime.ofType(FUNCTION)).toEqual([]);
});

test.each(["test", "prod"])("pr-12 với environment=%s → bị chặn", async (environment) => {
  setConfig({ environment, ...PR });
  vi.resetModules();
  await expect(import("../index.js")).rejects.toThrow('Stack "pr-12" must use environment "dev"');
  expect(runtime.ofType(FUNCTION)).toEqual([]);
});

test("pr-12 + environment=dev: tên vật lý có stack, tag PR đầy đủ", async () => {
  setConfig({ environment: "dev", ...PR, repository: "owner/repo" });
  vi.resetModules();
  const m = await import("../index.js");

  await vi.waitFor(() => expect(runtime.ofType("aws:lambda/eventSourceMapping:EventSourceMapping")).toHaveLength(1));

  // Khác hẳn tên của stack dev (`platform-worker-dev`) nên hai stack cùng account/region không va nhau.
  expect(await resolveOutput(m.functionName)).toBe("platform-worker-pr-12");
  expect(await resolveOutput(m.logGroupName)).toBe("/aws/lambda/platform-worker-pr-12");
  expect(runtime.one("aws:sqs/queue:Queue", "platform-worker-queues-queue").inputs.name).toBe(
    "platform-worker-pr-12-queue",
  );
  expect(runtime.one("aws:sqs/queue:Queue", "platform-worker-queues-dlq").inputs.name).toBe(
    "platform-worker-pr-12-dlq",
  );
  // Tên role cố định theo stack: policy của lab-pr-env cho phép `platform-worker-pr-*-role`, không đụng role của dev.
  expect(runtime.one("aws:iam/role:Role", "platform-worker-role").inputs.name).toBe("platform-worker-pr-12-role");

  // Stack PR không khai báo configStack: độc lập với stack config, dùng prefix mặc định của lab, và không có
  // StackReference nào nên dọn được theo đúng vòng đời PR đã viết (không cần stack config tồn tại).
  expect(runtime.one("aws:lambda/function:Function", "platform-worker-fn").inputs.environment).toEqual({
    variables: { MESSAGE_PREFIX: "lab" },
  });
  expect(runtime.ofType("pulumi:pulumi:StackReference")).toEqual([]);

  const expectedTags = {
    Service: "platform-worker",
    Environment: "dev",
    ManagedBy: "Pulumi",
    Purpose: "pr-environment",
    PR: "12",
    ExpiresAt: "2026-11-13T10:00:00.000Z",
    Repository: "owner/repo",
  };
  // Mọi resource hỗ trợ tags đều mang tag PR.
  for (const [type, name] of [
    ["aws:lambda/function:Function", "platform-worker-fn"],
    ["aws:iam/role:Role", "platform-worker-role"],
    ["aws:cloudwatch/logGroup:LogGroup", "platform-worker-logs"],
    ["aws:lambda/eventSourceMapping:EventSourceMapping", "platform-worker-mapping"],
    ["aws:sqs/queue:Queue", "platform-worker-queues-queue"],
    ["aws:sqs/queue:Queue", "platform-worker-queues-dlq"],
  ] as const) {
    expect(runtime.one(type, name).inputs.tags, `${type} ${name}`).toEqual(expectedTags);
  }
});
