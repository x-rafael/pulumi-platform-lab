import { beforeAll, describe, expect, test } from "vitest";
import type * as MessagePrefix from "../components/messagePrefix.js";
import { type MockRuntime, resolveOutput, setupMocks } from "./mocks.js";

const CONFIG_STACK = "example-org/platform-config/dev";
const STACK_REFERENCE = "pulumi:pulumi:StackReference";

let runtime: MockRuntime;
let mod: typeof MessagePrefix;

beforeAll(async () => {
  runtime = setupMocks("dev", { stackReferences: { [CONFIG_STACK]: { messagePrefix: "from-config-stack" } } });
  mod = await import("../components/messagePrefix.js");
});

describe("parseConfigStack", () => {
  test("không khai báo → undefined (stack PR dùng prefix mặc định)", () => {
    expect(mod.parseConfigStack(undefined, "dev")).toBeUndefined();
  });

  test("tên đúng và khớp environment → trả lại nguyên tên", () => {
    expect(mod.parseConfigStack(CONFIG_STACK, "dev")).toBe(CONFIG_STACK);
    expect(mod.parseConfigStack("my_org-1/platform-config/prod", "prod")).toBe("my_org-1/platform-config/prod");
  });

  test.each([
    ["rỗng", ""],
    ["thiếu org", "platform-config/dev"],
    ["project khác (chính stack của worker)", "example-org/platform-worker/dev"],
    ["thừa phân đoạn", "example-org/platform-config/dev/extra"],
    ["stack lạ", "example-org/platform-config/pr-12"],
    ["có khoảng trắng", "example-org/platform-config/dev "],
    ["org bắt đầu bằng gạch", "-org/platform-config/dev"],
  ])("từ chối tên sai định dạng: %s", (_label, value) => {
    expect(() => mod.parseConfigStack(value, "dev")).toThrow('Invalid config "configStack"');
  });

  test("trỏ sang environment khác bị từ chối (worker dev không đọc config prod)", () => {
    expect(() => mod.parseConfigStack("example-org/platform-config/prod", "dev")).toThrow(
      /is the prod config stack but this worker's environment is "dev"/,
    );
  });
});

describe("requireMessagePrefix", () => {
  test("chuỗi không rỗng → trả lại", () => {
    expect(mod.requireMessagePrefix("lab")).toBe("lab");
  });

  test.each([
    ["chuỗi rỗng", "", "an empty string"],
    ["toàn khoảng trắng", "   ", "an empty string"],
    ["số", 42, "a number"],
    ["object", { a: 1 }, "a object"],
    ["null", null, "a null"],
    ["undefined", undefined, "a undefined"],
  ])("từ chối %s", (_label, value, got) => {
    expect(() => mod.requireMessagePrefix(value)).toThrow(`must be a non-empty string, got ${got}`);
  });

  test("lỗi không chứa giá trị nhận được (có thể là secret)", () => {
    expect(() => mod.requireMessagePrefix({ token: "hunter2-do-not-print" })).not.toThrow(/hunter2/);
  });
});

describe("resolveMessagePrefix", () => {
  test("không có configStack → prefix mặc định của lab, không tạo StackReference", async () => {
    const before = runtime.ofType(STACK_REFERENCE).length;
    const prefix = mod.resolveMessagePrefix(undefined);
    expect(await resolveOutput(prefix)).toBe("lab");
    expect(prefix).toBe(mod.DEFAULT_MESSAGE_PREFIX);
    expect(runtime.ofType(STACK_REFERENCE)).toHaveLength(before);
  });

  test("có configStack → đọc output messagePrefix của đúng stack đó qua StackReference", async () => {
    const prefix = mod.resolveMessagePrefix(CONFIG_STACK);
    expect(await resolveOutput(prefix)).toBe("from-config-stack");

    const reference = runtime.one(STACK_REFERENCE, "platform-config");
    expect(reference.inputs.name).toBe(CONFIG_STACK);
  });
});
