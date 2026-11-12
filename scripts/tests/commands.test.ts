import { describe, expect, test } from "vitest";
import { destroy, reap, up } from "../lib/commands.ts";
import {
  NOW, ORG, REPO, type Responder, awsAllAbsent, fakeRunner, goodTags, makeDeps, on, prJson, stackListJson, tagsJson,
} from "./helpers.ts";

const FUTURE = "2026-11-13T09:00:00.000Z";
const PAST = "2026-11-12T09:00:00.000Z";
const FULL12 = `${ORG}/platform-worker/pr-12`;

const smokeOk: Responder[] = [
  on("aws sqs get-queue-url", { stdout: "https://sqs.example/123/q\n" }),
  (file, args) => (args.includes("filter-log-events") ? { stdout: '{"status":"processed","eventId":"ci-test-12"}' } : undefined),
];

interface World {
  pr?: ReturnType<typeof prJson> | { status: number; stderr: string };
  stacks?: string[];
  tags?: Record<string, string>;
  exportedResources?: number;
  extra?: Responder[];
  /** Chỉ các test `up` cần smoke test; nếu bật cho `destroy` thì nó che mất kết quả 'AWS vắng'. */
  smoke?: boolean;
}

function world(w: World) {
  const responders: Responder[] = [...(w.extra ?? [])];
  const pr = w.pr ?? prJson("open");
  responders.push(on("gh api repos", typeof pr === "string" ? { stdout: pr } : pr));
  responders.push(on("pulumi stack ls", { stdout: stackListJson(w.stacks ?? ["dev", "prod"]) }));
  responders.push(on("pulumi stack tag ls", { stdout: tagsJson(w.tags ?? {}) }));
  responders.push(on("pulumi stack export", { stdout: JSON.stringify({ deployment: { resources: new Array(w.exportedResources ?? 0).fill({}) } }) }));
  return fakeRunner(...responders, ...(w.smoke ? smokeOk : []), ...awsAllAbsent);
}

const index = (calls: { text: string }[], needle: string) => calls.findIndex((c) => c.text.includes(needle));

describe("up", () => {
  test("PR đã đóng → bỏ qua, không đụng Pulumi", () => {
    const { runner, calls } = world({ pr: prJson("closed") });
    expect(up(makeDeps(runner), 12)).toBe(0);
    expect(calls.every((c) => c.file === "gh")).toBe(true);
  });

  test("PR từ fork → từ chối, không đụng Pulumi/AWS (không cấp credentials)", () => {
    const { runner, calls } = world({ pr: prJson("open", "stranger/pulumi-platform-lab") });
    expect(up(makeDeps(runner), 12)).toBe(1);
    expect(calls.every((c) => c.file === "gh")).toBe(true);
  });

  test("không xác minh được PR (lỗi mạng hoặc 404) → từ chối deploy", () => {
    for (const stderr of ["HTTP 502", "gh: Not Found (HTTP 404)"]) {
      const { runner, calls } = world({ pr: { status: 1, stderr } });
      expect(up(makeDeps(runner), 12)).toBe(1);
      expect(calls.every((c) => c.file === "gh")).toBe(true);
    }
  });

  test("`stack ls` thất bại → ném lỗi và KHÔNG `stack init` / `up` (lỗi backend không có nghĩa là chưa có stack)", () => {
    const { runner, has } = world({ extra: [on("pulumi stack ls", { status: 255, stderr: "error: could not authenticate" })] });
    expect(() => up(makeDeps(runner), 12)).toThrow("failed");
    expect(has("stack init")).toBe(false);
    expect(has("pulumi up")).toBe(false);
  });

  test("stack chưa có → init, đặt đủ tag và config, preview rồi up, smoke test; TTL = now + 24h", () => {
    const { runner, calls, has } = world({ smoke: true });
    const deps = makeDeps(runner);
    expect(up(deps, 12)).toBe(0);
    expect(has(`pulumi stack init ${FULL12}`)).toBe(true);
    for (const [name, value] of Object.entries({
      Purpose: "pr-environment", ManagedBy: "Pulumi", Repository: REPO, PR: "12", ExpiresAt: "2026-11-13T12:00:00.000Z",
    })) {
      expect(has(`pulumi stack tag set ${name} ${value} --stack ${FULL12}`), name).toBe(true);
    }
    expect(has("config set aws:region ap-southeast-1")).toBe(true);
    expect(has("config set environment dev")).toBe(true);
    expect(has("config set prNumber 12")).toBe(true);
    expect(has("config set expiresAt 2026-11-13T12:00:00.000Z")).toBe(true);
    expect(has(`config set repository ${REPO}`)).toBe(true);
    // thứ tự: tag/config trước, rồi preview, rồi up, rồi smoke test
    expect(index(calls, "stack tag set")).toBeLessThan(index(calls, "pulumi preview"));
    expect(index(calls, "pulumi preview")).toBeLessThan(index(calls, "pulumi up"));
    expect(index(calls, "pulumi up")).toBeLessThan(index(calls, "send-message"));
    expect(deps.logs.join("\n")).toContain("eventId=ci-test-12 processed");
    expect(deps.summaries.join("")).not.toContain("https://"); // summary không chứa URL/ARN (có account ID)
  });

  test("stack đã có và còn hạn → select (không init), GIỮ NGUYÊN ExpiresAt, config trùng tag", () => {
    const { runner, has } = world({ stacks: ["dev", "pr-12"], tags: goodTags(12, FUTURE), smoke: true });
    expect(up(makeDeps(runner), 12, "2030-01-01T00:00:00Z")).toBe(0);
    expect(has("stack init")).toBe(false);
    expect(has(`pulumi stack select ${FULL12}`)).toBe(true);
    expect(has(`stack tag set ExpiresAt ${FUTURE}`)).toBe(true);
    expect(has(`config set expiresAt ${FUTURE}`)).toBe(true);
    expect(has("2030-01-01")).toBe(false); // push thêm commit không kéo dài TTL
  });

  test("stack đã có nhưng ExpiresAt hỏng → tính lại từ bây giờ", () => {
    const { runner, has } = world({ stacks: ["pr-12"], tags: goodTags(12, "tomorrow"), smoke: true });
    expect(up(makeDeps(runner), 12)).toBe(0);
    expect(has("stack tag set ExpiresAt 2026-11-13T12:00:00.000Z")).toBe(true);
  });

  test("stack pr-12 mang tag của repo khác → từ chối chạm vào", () => {
    const { runner, has } = world({ stacks: ["pr-12"], tags: goodTags(12, FUTURE, { Repository: "someone/else" }) });
    expect(up(makeDeps(runner), 12)).toBe(1);
    expect(has("pulumi up")).toBe(false);
    expect(has("stack tag set")).toBe(false);
  });
});

describe("destroy", () => {
  const closedPr = { pr: prJson("closed"), stacks: ["dev", "pr-12"], tags: goodTags(12, FUTURE) };

  test("thành công: region → destroy → stack rỗng → AWS vắng → stack rm; không dùng --force", () => {
    const { runner, calls, has } = world(closedPr);
    expect(destroy(makeDeps(runner), 12)).toBe(0);
    const order = ["config set aws:region", "pulumi destroy", "pulumi stack export", "aws lambda get-function", "pulumi stack rm"].map((n) => index(calls, n));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(calls.some((c) => c.args.includes("--force"))).toBe(false);
    expect(has("stack init")).toBe(false);
    // Thử lại phải idempotent: refresh trước khi xoá để resource AWS đã xoá nhưng còn trong state không gây Delete lên thứ không tồn tại.
    expect(calls.find((c) => c.text.includes("pulumi destroy"))?.args).toContain("--refresh");
  });

  test("tag không khớp (repo khác) → từ chối, không destroy, không rm", () => {
    const { runner, has } = world({ ...closedPr, tags: goodTags(12, FUTURE, { Repository: "someone/else" }) });
    expect(destroy(makeDeps(runner), 12)).toBe(1);
    expect(has("pulumi destroy")).toBe(false);
    expect(has("stack rm")).toBe(false);
  });

  test("thiếu tag hoàn toàn → từ chối", () => {
    const { runner, has } = world({ ...closedPr, tags: {} });
    expect(destroy(makeDeps(runner), 12)).toBe(1);
    expect(has("pulumi destroy")).toBe(false);
  });

  test("PR được mở lại và TTL còn hạn → giữ, không destroy (kiểm lại sau khi có lượt chạy)", () => {
    const { runner, has } = world({ pr: prJson("open"), stacks: ["pr-12"], tags: goodTags(12, FUTURE) });
    expect(destroy(makeDeps(runner), 12)).toBe(0);
    expect(has("pulumi destroy")).toBe(false);
  });

  test("PR mở nhưng TTL hết hạn → dọn", () => {
    const { runner, has } = world({ pr: prJson("open"), stacks: ["pr-12"], tags: goodTags(12, PAST) });
    expect(destroy(makeDeps(runner), 12)).toBe(0);
    expect(has("stack rm")).toBe(true);
  });

  test("tra cứu GitHub lỗi nhưng TTL đã hết → vẫn dọn", () => {
    const { runner, has } = world({ pr: { status: 1, stderr: "HTTP 502" }, stacks: ["pr-12"], tags: goodTags(12, PAST) });
    expect(destroy(makeDeps(runner), 12)).toBe(0);
    expect(has("stack rm")).toBe(true);
  });

  test("`pulumi destroy` thất bại → ném lỗi và KHÔNG stack rm (giữ state để thử lại)", () => {
    const { runner, has } = world({ ...closedPr, extra: [on("pulumi destroy", { status: 255, stderr: "error: update failed" })] });
    expect(() => destroy(makeDeps(runner), 12)).toThrow("failed");
    expect(has("stack rm")).toBe(false);
  });

  test("destroy xong nhưng stack còn resource → không rm", () => {
    const { runner, has } = world({ ...closedPr, exportedResources: 2 });
    expect(destroy(makeDeps(runner), 12)).toBe(1);
    expect(has("stack rm")).toBe(false);
  });

  test("destroy xong nhưng AWS vẫn còn Lambda → không rm", () => {
    const { runner, has } = world({ ...closedPr, extra: [on("aws lambda get-function", { status: 0, stdout: "{}" })] });
    expect(destroy(makeDeps(runner), 12)).toBe(1);
    expect(has("stack rm")).toBe(false);
  });

  test("AccessDenied khi kiểm AWS → ném lỗi, không rm (không coi lỗi là 'đã xoá')", () => {
    const { runner, has } = world({ ...closedPr, extra: [on("aws sqs get-queue-url", { status: 254, stderr: "(AccessDenied)" })] });
    expect(() => destroy(makeDeps(runner), 12)).toThrow("Cannot determine");
    expect(has("stack rm")).toBe(false);
  });

  test("`stack ls` thất bại → ném lỗi, không làm gì thêm", () => {
    const { runner, calls } = world({ ...closedPr, extra: [on("pulumi stack ls", { status: 255, stderr: "error: auth" })] });
    expect(() => destroy(makeDeps(runner), 12)).toThrow("failed");
    expect(calls.some((c) => c.text.includes("destroy") || c.text.includes("stack rm") || c.text.includes("stack init"))).toBe(false);
  });

  test("stack không còn: không init; AWS sạch → OK, nhưng còn resource mồ côi → lỗi", () => {
    const clean = world({ pr: prJson("closed"), stacks: ["dev"] });
    expect(destroy(makeDeps(clean.runner), 12)).toBe(0);
    expect(clean.has("stack init")).toBe(false);
    expect(clean.has("pulumi destroy")).toBe(false);

    const orphan = world({ pr: prJson("closed"), stacks: ["dev"], extra: [on("aws lambda get-function", { status: 0, stdout: "{}" })] });
    expect(destroy(makeDeps(orphan.runner), 12)).toBe(1);
    expect(orphan.has("stack init")).toBe(false);
  });
});

describe("reap", () => {
  const perStack: Responder = (file, args) => {
    const text = `${file} ${args.join(" ")}`;
    if (text.includes("pulumi stack tag ls") && text.includes("/pr-12")) return { stdout: tagsJson(goodTags(12, FUTURE)) };
    if (text.includes("pulumi stack tag ls") && text.includes("/pr-13")) return { stdout: tagsJson(goodTags(13, FUTURE)) };
    if (text.includes("pulumi stack tag ls") && text.includes("/pr-14")) return { stdout: tagsJson(goodTags(14, FUTURE, { Repository: "someone/else" })) };
    if (text.includes("pulumi stack tag ls") && text.includes("/pr-15")) return { stdout: tagsJson(goodTags(15, PAST)) };
    if (text.includes("pulls/12")) return { stdout: prJson("closed") };
    if (text.includes("pulls/13")) return { stdout: prJson("open") };
    if (text.includes("pulls/14")) return { stdout: prJson("closed") };
    if (text.includes("pulls/15")) return { stdout: prJson("open") };
    return undefined;
  };
  const stacks = ["dev", "prod", "pr-12", "pr-13", "pr-14", "pr-15"];
  const build = (extra: Responder[] = []) => fakeRunner(...extra, perStack, on("pulumi stack ls", { stdout: stackListJson(stacks) }));

  test("dry run: dev/prod bị loại, chọn đúng pr-12 (đóng) và pr-15 (hết hạn); không dispatch gì", () => {
    const { runner, calls, has } = build();
    const deps = makeDeps(runner);
    expect(reap(deps, true)).toBe(0);
    const out = deps.logs.join("\n");
    expect(out).toMatch(/EXCLUDE\s+dev\s/);
    expect(out).toMatch(/EXCLUDE\s+prod\s/);
    expect(out).toMatch(/CLEAN\s+pr-12\s.*closed/);
    expect(out).toMatch(/KEEP\s+pr-13\s/);
    expect(out).toMatch(/EXCLUDE\s+pr-14\s.*Repository/); // PR đã đóng nhưng tag repo khác → vẫn không đụng
    expect(out).toMatch(/CLEAN\s+pr-15\s.*TTL expired/);
    expect(has("gh workflow run")).toBe(false);
    expect(calls.some((c) => c.text.includes("destroy") || c.text.includes("stack rm"))).toBe(false);
  });

  test("chạy thật: chỉ dispatch cho pr-12 và pr-15; reaper tự nó không destroy", () => {
    const { runner, calls } = build();
    expect(reap(makeDeps(runner), false)).toBe(0);
    const dispatches = calls.filter((c) => c.text.startsWith("gh workflow run"));
    expect(dispatches.map((d) => d.args[d.args.indexOf("-f") + 1])).toEqual(["pr=12", "pr=15"]);
    expect(dispatches[0]?.args).toEqual(expect.arrayContaining(["pr-env-destroy.yml", "--repo", REPO, "--ref", "main"]));
    expect(calls.some((c) => c.text.includes("pulumi destroy") || c.text.includes("stack rm"))).toBe(false);
  });

  test("dispatch thất bại → mã lỗi khác 0 (một lỗi không bị báo là thành công)", () => {
    const { runner } = build([on("gh workflow run", { status: 1, stderr: "HTTP 403" })]);
    const deps = makeDeps(runner);
    expect(reap(deps, false)).toBe(1);
    expect(deps.logs.join("\n")).toContain("ERROR dispatching");
  });

  test("không đọc được tag của một stack pr-* → loại stack đó và trả mã lỗi, không xoá", () => {
    const { runner, has } = build([on("stack tag ls --stack x-rafael-org/platform-worker/pr-12", { status: 1, stderr: "boom" })]);
    expect(reap(makeDeps(runner), false)).toBe(1);
    expect(has("pr=12")).toBe(false);
  });

  test("`stack ls` thất bại → ném lỗi", () => {
    const { runner } = build([on("pulumi stack ls", { status: 255, stderr: "auth" })]);
    expect(() => reap(makeDeps(runner), true)).toThrow("failed");
  });

  test("dùng giờ UTC từ deps.now, không phụ thuộc đồng hồ máy", () => {
    expect(NOW.toISOString()).toBe("2026-11-12T12:00:00.000Z");
  });
});
