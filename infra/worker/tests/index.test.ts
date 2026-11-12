import * as pulumi from "@pulumi/pulumi";
import { beforeAll, expect, test, vi } from "vitest";
import { MOCK_PROJECT, type MockRuntime, resolveOutput, setupMocks } from "./mocks.js";

// Caller thật: set config TRƯỚC khi import index.ts. Stack mock là `dev`.
// (Stack `pr-<n>` nằm ở index.pr.test.ts vì mỗi file test chỉ có một stack mock.)
let runtime: MockRuntime;
beforeAll(() => {
  runtime = setupMocks("dev");
});

// Namespace config phải trùng tên project (MOCK_PROJECT ↔ Pulumi.yaml `name`), nếu không
// `config.get("environment")` trả undefined.
const setConfig = (cfg: Record<string, string>) =>
  pulumi.runtime.setAllConfig(Object.fromEntries(Object.entries(cfg).map(([k, v]) => [`${MOCK_PROJECT}:${k}`, v])));

// Các ca lỗi chạy trước: chúng throw trước khi tạo resource nào.
test("thiếu config environment → import index.ts thất bại", async () => {
  setConfig({});
  vi.resetModules();
  await expect(import("../index.js")).rejects.toThrow('Invalid config "environment"');
  expect(runtime.ofType("aws:lambda/function:Function")).toEqual([]);
});

test("environment=test trên stack dev → bị chặn, không tạo resource", async () => {
  setConfig({ environment: "test" });
  vi.resetModules();
  await expect(import("../index.js")).rejects.toThrow('Stack "dev" must use environment "dev"');
  expect(runtime.ofType("aws:lambda/function:Function")).toEqual([]);
});

test("environment=prod trên stack dev → bị chặn, không tạo resource", async () => {
  setConfig({ environment: "prod" });
  vi.resetModules();
  await expect(import("../index.js")).rejects.toThrow('Stack "dev" must use environment "dev"');
  expect(runtime.ofType("aws:lambda/function:Function")).toEqual([]);
});

test("stack dev mang metadata PR → bị chặn, không tạo resource", async () => {
  setConfig({ environment: "dev", prNumber: "12", expiresAt: "2026-11-13T10:00:00Z" });
  vi.resetModules();
  await expect(import("../index.js")).rejects.toThrow("only allowed on pr-<number> stacks");
  expect(runtime.ofType("aws:lambda/function:Function")).toEqual([]);
});

test("stack dev + environment=dev: chỉ tạo worker, đủ 7 exports, tags theo environment", async () => {
  setConfig({ environment: "dev", timeoutSeconds: "15", visibilityTimeoutSeconds: "120" });
  vi.resetModules();
  const m = await import("../index.js");

  await vi.waitFor(() => expect(runtime.ofType("aws:lambda/eventSourceMapping:EventSourceMapping")).toHaveLength(1));

  expect(Object.keys(m).sort()).toEqual(
    ["dlqArn", "dlqUrl", "eventSourceMappingId", "functionName", "logGroupName", "queueArn", "queueUrl"].sort(),
  );
  expect(await resolveOutput(m.functionName)).toBe("platform-worker-dev");
  expect(await resolveOutput(m.logGroupName)).toBe("/aws/lambda/platform-worker-dev");

  const fn = runtime.one("aws:lambda/function:Function");
  expect(fn.inputs.timeout).toBe(15);
  // Stack thường không có tag PR: reaper không bao giờ nhận nhầm `dev` là stack PR.
  expect(fn.inputs.tags).toEqual({ Service: "platform-worker", Environment: "dev", ManagedBy: "Pulumi" });

  const source = runtime.one("aws:sqs/queue:Queue", "platform-worker-queues-queue");
  expect(source.inputs.visibilityTimeoutSeconds).toBe(120);
  expect(source.inputs.name).toBe("platform-worker-dev-queue");
  expect(runtime.one("aws:sqs/queue:Queue", "platform-worker-queues-dlq").inputs.name).toBe("platform-worker-dev-dlq");

  // Không có ALB/Fargate trong caller của worker.
  const types = new Set(runtime.registrations.map((r) => r.type));
  for (const t of ["aws:lb/loadBalancer:LoadBalancer", "aws:ecs/service:Service", "aws:ecs/cluster:Cluster"]) {
    expect(types.has(t), t).toBe(false);
  }
});
