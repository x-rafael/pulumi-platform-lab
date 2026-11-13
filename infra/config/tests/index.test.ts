import * as pulumi from "@pulumi/pulumi";
import { beforeAll, expect, test, vi } from "vitest";
import { MOCK_PROJECT, type MockRuntime, resolveOutput, setupMocks } from "./mocks.js";

// Stack mock là `dev`; namespace config phải trùng tên project (MOCK_PROJECT ↔ Pulumi.yaml `name`).
let runtime: MockRuntime;
beforeAll(() => {
  runtime = setupMocks("dev");
});

const setConfig = (cfg: Record<string, string>) =>
  pulumi.runtime.setAllConfig(Object.fromEntries(Object.entries(cfg).map(([k, v]) => [`${MOCK_PROJECT}:${k}`, v])));

const PARAMETER = "aws:ssm/parameter:Parameter";

// Các ca lỗi chạy trước: chúng throw trước khi tạo resource nào.
test("thiếu config environment → import index.ts thất bại, không tạo resource", async () => {
  setConfig({});
  vi.resetModules();
  await expect(import("../index.js")).rejects.toThrow('Invalid config "environment"');
  expect(runtime.ofType(PARAMETER)).toEqual([]);
});

test("environment=prod trên stack dev → bị chặn, không tạo resource", async () => {
  setConfig({ environment: "prod" });
  vi.resetModules();
  await expect(import("../index.js")).rejects.toThrow('Stack "dev" must use environment "dev"');
  expect(runtime.ofType(PARAMETER)).toEqual([]);
});

test("stack dev + environment=dev: đúng một SSM String parameter, không bí mật, export messagePrefix", async () => {
  setConfig({ environment: "dev" });
  vi.resetModules();
  const m = await import("../index.js");

  await vi.waitFor(() => expect(runtime.ofType(PARAMETER)).toHaveLength(1));

  // Exports chính xác: worker phụ thuộc vào tên output này.
  expect(Object.keys(m)).toEqual(["messagePrefix"]);
  expect(await resolveOutput(m.messagePrefix)).toBe("lab");

  const parameter = runtime.one(PARAMETER, "message-prefix");
  expect(parameter.inputs.name).toBe("/platform-lab/dev/message-prefix");
  expect(parameter.inputs.type).toBe("String");
  expect(parameter.inputs.insecureValue).toBe("lab");
  // `value` luôn bị đánh dấu sensitive; dữ liệu không bí mật phải đi bằng insecureValue.
  expect(parameter.inputs.value).toBeUndefined();
  expect(parameter.inputs.tags).toEqual({ Service: "platform-config", Environment: "dev", ManagedBy: "Pulumi" });

  // Project này chỉ sở hữu parameter: không tạo gì khác.
  expect(runtime.registrations.map((r) => r.type)).toEqual([PARAMETER]);
});
