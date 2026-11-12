import { describe, expect, test } from "vitest";
import { checkPrResources, classifyLookup, isProcessed, smokeTest } from "../lib/aws.ts";
import { fetchPr, parsePrResponse } from "../lib/github.ts";
import { countResources, parseStackList, parseStackTags, stackExists } from "../lib/pulumi.ts";
import { decideReap } from "../lib/reaper.ts";
import {
  computeExpiresAt, fullStackName, parseExpiresAt, parsePrNumber, physicalNames, prNumberFromStackName, requireOrg,
  requireRegion, requireRepository,
} from "../lib/validate.ts";
import { NOW, ORG, REPO, awsAllAbsent, fakeRunner, goodTags, on, prJson } from "./helpers.ts";

describe("parsePrNumber", () => {
  test.each(["1", "12", "999999999"])("chấp nhận %j", (v) => expect(parsePrNumber(v)).toBe(Number(v)));
  test.each([undefined, "", "0", "012", "-1", "+1", "12abc", "1e2", "1.5", " 12", "12 ", "1234567890", "12; rm -rf /", "$(id)"])(
    "từ chối %j",
    (v) => expect(() => parsePrNumber(v)).toThrow("Invalid PR number"),
  );
});

describe("parseExpiresAt / computeExpiresAt", () => {
  test("chuẩn hoá về toISOString", () => {
    expect(parseExpiresAt("2026-11-13T10:00:00Z")).toBe("2026-11-13T10:00:00.000Z");
    expect(parseExpiresAt("2026-11-13T10:00:00.123Z")).toBe("2026-11-13T10:00:00.123Z");
  });
  test("quá khứ vẫn hợp lệ (dùng để thử reaper)", () => {
    expect(parseExpiresAt("2020-01-01T00:00:00Z")).toBe("2020-01-01T00:00:00.000Z");
  });
  test.each([undefined, "", "2026-11-13", "2026-11-13T10:00:00", "2026-11-13T10:00:00+07:00", "2026-02-31T10:00:00Z", "2026-11-13T24:00:00Z", "2026-11-13T10:00:00z"])(
    "từ chối %j",
    (v) => expect(() => parseExpiresAt(v)).toThrow("Invalid expiresAt"),
  );
  test("TTL 24 giờ tính theo UTC, không phụ thuộc múi giờ máy", () => {
    expect(computeExpiresAt(NOW)).toBe("2026-11-13T12:00:00.000Z");
    expect(computeExpiresAt(NOW, 1)).toBe("2026-11-12T13:00:00.000Z");
  });
});

describe("tên stack và allowlist", () => {
  test("prNumberFromStackName: chỉ pr-<số nguyên dương>", () => {
    expect(prNumberFromStackName("pr-12")).toBe(12);
    for (const name of ["dev", "prod", "test", "pr-0", "pr-012", "PR-12", "pr-12x", "pr-", "preprod", "prod-2", "constructor", "__proto__", "", "pr-1234567890"]) {
      expect(prNumberFromStackName(name), name).toBeUndefined();
    }
  });
  test("fullStackName dựng từ allowlist, không nhận org lạ", () => {
    expect(fullStackName(ORG, 12)).toBe("x-rafael-org/platform-worker/pr-12");
    expect(() => fullStackName("attacker-org", 12)).toThrow("not in the allowlist");
    expect(() => requireOrg(undefined)).toThrow("not in the allowlist");
  });
  test("requireRepository / requireRegion", () => {
    expect(requireRepository(REPO)).toBe(REPO);
    expect(() => requireRepository("someone/else")).toThrow("not in the allowlist");
    expect(requireRegion("ap-southeast-1")).toBe("ap-southeast-1");
    expect(() => requireRegion("sg")).toThrow("Invalid AWS region");
  });
  test("physicalNames khớp mẫu tên của worker (platform-worker-pr-<n>…)", () => {
    expect(physicalNames(12)).toEqual({
      functionName: "platform-worker-pr-12",
      sourceQueue: "platform-worker-pr-12-queue",
      dlq: "platform-worker-pr-12-dlq",
      logGroup: "/aws/lambda/platform-worker-pr-12",
      role: "platform-worker-pr-12-role",
    });
  });
});

describe("decideReap (bảng quyết định)", () => {
  const future = "2026-11-13T09:00:00.000Z";
  const past = "2026-11-12T09:00:00.000Z";
  const open = { kind: "found", state: "open", merged: false, headRepository: REPO } as const;
  const closed = { kind: "found", state: "closed", merged: true, headRepository: REPO } as const;
  const decide = (stackName: string, tags: Record<string, string>, pr = open as Parameters<typeof decideReap>[0]["pr"]) =>
    decideReap({ stackName, tags, repository: REPO, now: NOW, pr });

  test("dev, prod, test luôn bị loại, dù tag giả mạo hợp lệ", () => {
    for (const name of ["dev", "prod", "test"]) {
      const d = decide(name, goodTags(12, past), closed);
      expect(d.action, name).toBe("exclude");
      expect(d.reason).toContain("is not pr-<positive integer>");
    }
  });
  test.each([
    ["thiếu Purpose", { ...goodTags(12, past), Purpose: "" }, "Purpose"],
    ["Purpose sai", { ...goodTags(12, past), Purpose: "something-else" }, "Purpose"],
    ["ManagedBy sai", { ...goodTags(12, past), ManagedBy: "Terraform" }, "ManagedBy"],
    ["repo khác", { ...goodTags(12, past), Repository: "someone/else" }, "Repository"],
    ["PR tag không khớp tên stack", { ...goodTags(13, past) }, "PR"],
    ["thiếu ExpiresAt", (({ ExpiresAt: _e, ...rest }) => rest)(goodTags(12, past)), "ExpiresAt"],
    ["ExpiresAt không hợp lệ", { ...goodTags(12, "tomorrow") }, "ExpiresAt"],
    ["ExpiresAt có offset", { ...goodTags(12, "2026-11-12T09:00:00+07:00") }, "ExpiresAt"],
  ])("loại: %s", (_label, tags, field) => {
    const d = decide("pr-12", tags, closed);
    expect(d.action).toBe("exclude");
    expect(d.reason).toContain(field);
  });
  test("PR đã đóng → dọn, kể cả khi TTL còn hạn", () => {
    expect(decide("pr-12", goodTags(12, future), closed)).toMatchObject({ action: "clean", reason: "PR #12 is closed" });
  });
  test("PR mở nhưng TTL hết hạn → dọn", () => {
    expect(decide("pr-12", goodTags(12, past))).toMatchObject({ action: "clean" });
  });
  test("đúng thời điểm hết hạn tính là hết hạn", () => {
    expect(decide("pr-12", goodTags(12, NOW.toISOString()))).toMatchObject({ action: "clean" });
  });
  test("PR mở và còn hạn → giữ", () => {
    expect(decide("pr-12", goodTags(12, future))).toMatchObject({ action: "keep", expiresAt: future });
  });
  test("tra cứu GitHub lỗi + TTL còn hạn → giữ (không xoá khi thông tin mơ hồ)", () => {
    expect(decide("pr-12", goodTags(12, future), { kind: "lookup-failed", detail: "network" })).toMatchObject({ action: "keep" });
    expect(decide("pr-12", goodTags(12, future), { kind: "not-found" })).toMatchObject({ action: "keep" });
    expect(decide("pr-12", goodTags(12, future), undefined)).toMatchObject({ action: "keep" });
  });
  test("tra cứu GitHub lỗi nhưng TTL đã hết → vẫn dọn (TTL đủ một mình)", () => {
    expect(decide("pr-12", goodTags(12, past), { kind: "lookup-failed", detail: "network" })).toMatchObject({ action: "clean" });
  });
});

describe("kiểm tra AWS: chỉ mã 'không tồn tại' thật mới là đã xoá", () => {
  const fail = (stderr: string) => ({ status: 254, stdout: "", stderr });
  test("lambda / sqs / iam: mã không tồn tại → absent", () => {
    expect(classifyLookup("lambda", "f", fail("(ResourceNotFoundException)"))).toBe("absent");
    expect(classifyLookup("sqs", "q", fail("(AWS.SimpleQueueService.NonExistentQueue)"))).toBe("absent");
    expect(classifyLookup("sqs", "q", fail("(QueueDoesNotExist)"))).toBe("absent");
    expect(classifyLookup("iam", "r", fail("(NoSuchEntity)"))).toBe("absent");
  });
  test("thành công → present", () => {
    for (const kind of ["lambda", "sqs", "iam"] as const) expect(classifyLookup(kind, "x", { status: 0, stdout: "{}", stderr: "" })).toBe("present");
  });
  test("AccessDenied, throttling, mạng KHÔNG được coi là 'đã xoá'", () => {
    for (const kind of ["lambda", "sqs", "iam"] as const) {
      expect(() => classifyLookup(kind, "x", fail("(AccessDenied) User is not authorized"))).toThrow("Cannot determine");
      expect(() => classifyLookup(kind, "x", fail("Could not connect to the endpoint URL"))).toThrow("Cannot determine");
    }
  });
  test("log group: danh sách rỗng → absent, có phần tử → present, lỗi → throw", () => {
    expect(classifyLookup("logs", "g", { status: 0, stdout: "[]", stderr: "" })).toBe("absent");
    expect(classifyLookup("logs", "g", { status: 0, stdout: '["/aws/lambda/g"]', stderr: "" })).toBe("present");
    expect(() => classifyLookup("logs", "g", fail("(AccessDeniedException)"))).toThrow("Cannot determine");
    expect(() => classifyLookup("logs", "g", { status: 0, stdout: "not json", stderr: "" })).toThrow("Unreadable");
  });
  test("checkPrResources: 5 resource đều absent", () => {
    const { runner } = fakeRunner(...awsAllAbsent);
    const report = checkPrResources(12, runner);
    expect(report.map((r) => `${r.kind}:${r.presence}`)).toEqual(["lambda:absent", "sqs:absent", "sqs:absent", "logs:absent", "iam:absent"]);
  });
  test("checkPrResources: AccessDenied ở một lookup làm cả kiểm tra thất bại", () => {
    const { runner } = fakeRunner(on("aws iam get-role", { status: 254, stderr: "(AccessDenied)" }), ...awsAllAbsent);
    expect(() => checkPrResources(12, runner)).toThrow("Cannot determine");
  });
});

describe("smoke test", () => {
  test("isProcessed cần cả status processed lẫn đúng eventId", () => {
    const line = '{"status":"processed","eventId":"ci-1","messageId":"m"}';
    expect(isProcessed(line, "ci-1")).toBe(true);
    expect(isProcessed(line, "ci-2")).toBe(false);
    expect(isProcessed('{"status":"failed","eventId":"ci-1"}', "ci-1")).toBe(false);
    expect(isProcessed("", "ci-1")).toBe(false);
  });
  test("thành công ở lần poll thứ 3, dùng --start-time và eventId đúng", () => {
    let polls = 0;
    const { runner, calls } = fakeRunner(
      on("aws sqs get-queue-url", { stdout: "https://sqs.example/123/q\n" }),
      (file, args) => (args.includes("filter-log-events") ? (++polls >= 3 ? { stdout: '{"status":"processed","eventId":"ci-x"}' } : { stdout: "" }) : undefined),
    );
    expect(smokeTest(12, "ci-x", { runner, sleep: () => {}, nowMs: () => 1_700_000_000_000 })).toBe(3);
    const filter = calls.find((c) => c.args.includes("filter-log-events"));
    expect(filter?.args).toContain("1700000000000");
    expect(filter?.args).toContain('"ci-x"');
    expect(filter?.args).toContain("/aws/lambda/platform-worker-pr-12");
    const send = calls.find((c) => c.args.includes("send-message"));
    expect(JSON.parse(send?.args[send.args.indexOf("--message-body") + 1] as string)).toEqual({ eventId: "ci-x", action: "process", forceFail: false });
  });
  test("không thấy log → ném lỗi sau số lần poll tối đa", () => {
    const { runner } = fakeRunner(on("aws sqs get-queue-url", { stdout: "u\n" }));
    expect(() => smokeTest(12, "ci-x", { runner, sleep: () => {}, nowMs: () => 0, attempts: 3, intervalMs: 5000 })).toThrow("not seen as processed within 15s");
  });
});

describe("GitHub", () => {
  test("parsePrResponse", () => {
    expect(parsePrResponse(prJson("open"))).toEqual({ kind: "found", state: "open", merged: false, headRepository: REPO });
    expect(parsePrResponse(prJson("closed", null))).toMatchObject({ state: "closed", headRepository: null });
    expect(parsePrResponse("not json").kind).toBe("lookup-failed");
    expect(parsePrResponse('{"state":"weird"}').kind).toBe("lookup-failed");
  });
  test("fetchPr: 404 → not-found; lỗi khác → lookup-failed; không bao giờ ném", () => {
    expect(fetchPr(REPO, 12, fakeRunner(on("gh api", { status: 1, stderr: "gh: Not Found (HTTP 404)" })).runner)).toEqual({ kind: "not-found" });
    expect(fetchPr(REPO, 12, fakeRunner(on("gh api", { status: 1, stderr: "HTTP 502 Bad Gateway" })).runner).kind).toBe("lookup-failed");
    expect(fetchPr(REPO, 12, fakeRunner(on("gh api", { stdout: prJson("open") })).runner).kind).toBe("found");
  });
});

describe("Pulumi parsing", () => {
  test("parseStackList bỏ tiền tố org/project nếu CLI in dạng đầy đủ", () => {
    const json = JSON.stringify([{ name: "dev", url: "u/dev", resourceCount: 12 }, { name: "x-rafael-org/platform-worker/pr-12" }]);
    expect(parseStackList(json).map((s) => s.name)).toEqual(["dev", "pr-12"]);
    expect(() => parseStackList("{}")).toThrow("Unexpected");
  });
  test("parseStackTags bỏ tag hệ thống pulumi:* và vcs:*", () => {
    expect(parseStackTags(JSON.stringify({ "pulumi:project": "p", "vcs:owner": "o", PR: "12", ExpiresAt: "2026-11-13T10:00:00.123Z" }))).toEqual({
      PR: "12", ExpiresAt: "2026-11-13T10:00:00.123Z",
    });
  });
  test("countResources", () => {
    expect(countResources(JSON.stringify({ deployment: { resources: [] } }))).toBe(0);
    expect(countResources(JSON.stringify({ deployment: { resources: [{}, {}] } }))).toBe(2);
    expect(countResources(JSON.stringify({ deployment: {} }))).toBe(0);
  });
  test("stackExists: URL sai org/project thì từ chối tiếp tục", () => {
    const ctx = { runner: fakeRunner().runner, cwd: "/w", org: ORG };
    expect(stackExists([{ name: "pr-12", url: `https://app.pulumi.com/${ORG}/platform-worker/pr-12` }], ctx, "pr-12")).toBe(true);
    expect(stackExists([{ name: "dev" }], ctx, "pr-12")).toBe(false);
    expect(() => stackExists([{ name: "pr-12", url: "https://app.pulumi.com/other-org/platform-worker/pr-12" }], ctx, "pr-12")).toThrow("unexpected URL");
  });
});
