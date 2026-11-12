import type * as pulumi from "@pulumi/pulumi";
import { describe, expect, test } from "vitest";
import {
  assertStackMatchesEnvironment,
  loadWorkerArgs,
  parseEnvironment,
  parseExpiresAt,
  parsePrNumber,
  parseRepository,
  resolveStack,
} from "../components/workerConfig.js";

/** Config giả: chỉ cần `get`/`getNumber`, nên test không cần Pulumi runtime. */
function fakeConfig(values: Record<string, string>): pulumi.Config {
  return {
    get: (key: string) => values[key],
    getNumber: (key: string) => (values[key] === undefined ? undefined : Number(values[key])),
  } as unknown as pulumi.Config;
}

describe("parseEnvironment", () => {
  test.each(["dev", "test", "prod"] as const)("chấp nhận %s", (v) => {
    expect(parseEnvironment(v)).toBe(v);
  });

  test.each([undefined, "", "Dev", "PROD", " dev", "staging", "production", "pr-12"])("từ chối %j", (v) => {
    expect(() => parseEnvironment(v)).toThrow('Invalid config "environment"');
  });
});

describe("resolveStack", () => {
  test.each([
    ["dev", "dev"],
    ["test", "test"],
    ["prod", "prod"],
  ] as const)("stack cố định %s ↔ environment %s, không có số PR", (stack, environment) => {
    expect(resolveStack(stack)).toEqual({ environment, prNumber: undefined });
  });

  test.each([
    ["pr-1", 1],
    ["pr-12", 12],
    ["pr-999999999", 999_999_999],
  ])("stack %s → environment dev, PR %d", (stack, prNumber) => {
    expect(resolveStack(stack)).toEqual({ environment: "dev", prNumber });
  });

  // Không đoán environment bằng includes("prod") hay prefix lỏng; mọi biến thể đều là stack lạ.
  test.each([
    "pr-0",
    "pr-012",
    "pr--1",
    "pr-1.5",
    "pr-12x",
    "pr-",
    "pr",
    "PR-12",
    "Pr-12",
    "pr-1234567890",
    "pr-12 ",
    " pr-12",
    "xpr-12",
    "preprod",
    "prod-2",
    "dev-1",
    "Dev",
    "staging",
    "",
    // Tên trùng thuộc tính của Object.prototype: không được "khớp" nhờ prototype.
    "constructor",
    "toString",
    "__proto__",
  ])("từ chối stack %j", (stack) => {
    expect(() => resolveStack(stack)).toThrow(`Unknown stack "${stack}"`);
  });
});

describe("assertStackMatchesEnvironment", () => {
  test("mỗi stack cố định khớp đúng environment của nó", () => {
    expect(() => assertStackMatchesEnvironment("dev", "dev")).not.toThrow();
    expect(() => assertStackMatchesEnvironment("test", "test")).not.toThrow();
    expect(() => assertStackMatchesEnvironment("prod", "prod")).not.toThrow();
  });

  test("gắn nhãn chéo bị chặn", () => {
    expect(() => assertStackMatchesEnvironment("dev", "test")).toThrow('Stack "dev" must use environment "dev"');
    expect(() => assertStackMatchesEnvironment("test", "dev")).toThrow('Stack "test" must use environment "test"');
    expect(() => assertStackMatchesEnvironment("dev", "prod")).toThrow('Stack "dev" must use environment "dev"');
    expect(() => assertStackMatchesEnvironment("prod", "dev")).toThrow('Stack "prod" must use environment "prod"');
  });

  test("PR stack chỉ dùng environment dev", () => {
    expect(() => assertStackMatchesEnvironment("pr-12", "dev")).not.toThrow();
    expect(() => assertStackMatchesEnvironment("pr-12", "test")).toThrow('Stack "pr-12" must use environment "dev"');
    expect(() => assertStackMatchesEnvironment("pr-12", "prod")).toThrow('Stack "pr-12" must use environment "dev"');
  });

  test("stack lạ bị chặn", () => {
    expect(() => assertStackMatchesEnvironment("staging", "dev")).toThrow('Unknown stack "staging"');
  });
});

describe("parsePrNumber", () => {
  test.each([
    ["1", 1],
    ["12", 12],
    ["999999999", 999_999_999],
  ])("chấp nhận %j", (raw, expected) => {
    expect(parsePrNumber(raw)).toBe(expected);
  });

  // `Config.getNumber` dùng parseFloat nên "12abc"/"1e2" lọt qua; regex chặt thì không.
  test.each([undefined, "", "0", "012", "-1", "+1", "12abc", "1e2", "1.5", " 12", "12 ", "١٢", "1234567890"])(
    "từ chối %j",
    (raw) => {
      expect(() => parsePrNumber(raw)).toThrow('Invalid config "prNumber"');
    },
  );
});

describe("parseExpiresAt", () => {
  test("chuẩn hoá về toISOString (UTC, có mili giây)", () => {
    expect(parseExpiresAt("2026-11-13T10:00:00Z")).toBe("2026-11-13T10:00:00.000Z");
    expect(parseExpiresAt("2026-11-13T10:00:00.5Z")).toBe("2026-11-13T10:00:00.500Z");
    expect(parseExpiresAt("2026-11-13T10:00:00.123Z")).toBe("2026-11-13T10:00:00.123Z");
  });

  test("thời điểm trong quá khứ vẫn hợp lệ (dùng để thử reaper)", () => {
    expect(parseExpiresAt("2020-01-01T00:00:00Z")).toBe("2020-01-01T00:00:00.000Z");
  });

  test("năm nhuận: 29/02/2028 hợp lệ", () => {
    expect(parseExpiresAt("2028-02-29T23:59:59Z")).toBe("2028-02-29T23:59:59.000Z");
  });

  test.each([
    undefined,
    "",
    "2026-11-13",
    "2026-11-13T10:00:00",
    "2026-11-13T10:00:00z",
    "2026-11-13 10:00:00Z",
    "2026-11-13T10:00:00+07:00",
    "2026-11-13T10:00:00+00:00",
    "2026-11-13T10:00Z",
    "2026-11-13T10:00:00.1234Z",
    " 2026-11-13T10:00:00Z",
    "1731492000",
  ])("từ chối định dạng sai %j", (raw) => {
    expect(() => parseExpiresAt(raw)).toThrow('Invalid config "expiresAt"');
  });

  test.each([
    "2026-02-31T10:00:00Z",
    "2027-02-29T10:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-00-10T00:00:00Z",
    "2026-11-00T00:00:00Z",
    "2026-11-13T24:00:00Z",
    "2026-11-13T10:60:00Z",
    "2026-11-13T10:00:60Z",
    "0026-11-13T10:00:00Z",
  ])("từ chối ngày giờ không có thật %j", (raw) => {
    expect(() => parseExpiresAt(raw)).toThrow('Invalid config "expiresAt"');
  });
});

describe("parseRepository", () => {
  test.each(["owner/repo", "owner/pulumi-platform-lab", "a.b_c/d-e.f"])("chấp nhận %j", (v) => {
    expect(parseRepository(v)).toBe(v);
  });

  test.each(["", "owner", "owner/", "/repo", "a/b/c", "a b/c", "owner/repo name", "https://github.com/a/b"])(
    "từ chối %j",
    (v) => {
      expect(() => parseRepository(v)).toThrow('Invalid config "repository"');
    },
  );
});

describe("loadWorkerArgs", () => {
  const PR = { prNumber: "12", expiresAt: "2026-11-13T10:00:00Z" };

  test("stack dev: tags cơ bản, không có tag PR", () => {
    const args = loadWorkerArgs(fakeConfig({ environment: "dev" }), "dev");
    expect(args.stack).toBe("dev");
    expect(args.environment).toBe("dev");
    expect(args.tags).toEqual({ Service: "platform-worker", Environment: "dev", ManagedBy: "Pulumi" });
  });

  test.each(["test", "prod"] as const)("stack %s: environment trùng tên stack", (stack) => {
    const args = loadWorkerArgs(fakeConfig({ environment: stack }), stack);
    expect(args.tags.Environment).toBe(stack);
    expect(args.tags).not.toHaveProperty("PR");
  });

  test("stack pr-12: environment dev + tag PR riêng", () => {
    const args = loadWorkerArgs(fakeConfig({ environment: "dev", ...PR }), "pr-12");
    expect(args.stack).toBe("pr-12");
    expect(args.environment).toBe("dev");
    expect(args.tags).toEqual({
      Service: "platform-worker",
      Environment: "dev",
      ManagedBy: "Pulumi",
      Purpose: "pr-environment",
      PR: "12",
      ExpiresAt: "2026-11-13T10:00:00.000Z",
    });
  });

  test("repository tuỳ chọn trên PR stack được gắn thành tag Repository", () => {
    const args = loadWorkerArgs(fakeConfig({ environment: "dev", ...PR, repository: "owner/repo" }), "pr-12");
    expect(args.tags.Repository).toBe("owner/repo");
  });

  test("PR stack thiếu hoặc sai metadata → throw", () => {
    const load = (v: Record<string, string>) => () => loadWorkerArgs(fakeConfig({ environment: "dev", ...v }), "pr-12");
    expect(load({})).toThrow('Invalid config "prNumber"');
    expect(load({ expiresAt: PR.expiresAt })).toThrow('Invalid config "prNumber"');
    expect(load({ prNumber: "12" })).toThrow('Invalid config "expiresAt"');
    expect(load({ prNumber: "12abc", expiresAt: PR.expiresAt })).toThrow('Invalid config "prNumber"');
    expect(load({ prNumber: "12", expiresAt: "2026-11-13T10:00:00+07:00" })).toThrow('Invalid config "expiresAt"');
    expect(load({ ...PR, repository: "not a repo" })).toThrow('Invalid config "repository"');
  });

  test("prNumber không khớp số trong tên stack → throw", () => {
    expect(() =>
      loadWorkerArgs(fakeConfig({ environment: "dev", prNumber: "13", expiresAt: PR.expiresAt }), "pr-12"),
    ).toThrow('Config "prNumber" (13) does not match stack "pr-12"');
  });

  test("PR stack với environment khác dev → throw trước khi đọc metadata", () => {
    expect(() => loadWorkerArgs(fakeConfig({ environment: "prod", ...PR }), "pr-12")).toThrow(
      'Stack "pr-12" must use environment "dev"',
    );
  });

  test.each(["dev", "test", "prod"] as const)("stack %s mang metadata PR → throw", (stack) => {
    const extras: Record<string, string>[] = [
      { prNumber: "12" },
      { expiresAt: PR.expiresAt },
      { repository: "owner/repo" },
      PR,
    ];
    for (const extra of extras) {
      expect(() => loadWorkerArgs(fakeConfig({ environment: stack, ...extra }), stack)).toThrow(
        `only allowed on pr-<number> stacks, not on stack "${stack}"`,
      );
    }
  });
});
