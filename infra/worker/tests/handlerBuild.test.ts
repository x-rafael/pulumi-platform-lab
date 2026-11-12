import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

// Build vào thư mục tạm (không đụng `dist/`, nơi chỉ chứa bundle dùng để deploy),
// dùng đúng các tuỳ chọn của `npm run build:handler`.
let outDir: string;
beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), "day2-handler-"));
  await build({
    entryPoints: ["handlers/worker.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: join(outDir, "worker.js"),
    logLevel: "silent",
  });
});
// Nạp bundle CommonJS giống cách Lambda runtime nạp `worker.handler`.
const loadBundle = () => createRequire(join(outDir, "loader.js"))("./worker.js");

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

test("bundle là một file worker.js ở root archive và export `handler`", () => {
  expect(readdirSync(outDir)).toEqual(["worker.js"]);
  const bundle = loadBundle();
  expect(typeof bundle.handler).toBe("function");
});

test("bundle chạy được như Lambda: record xấu trả về trong batchItemFailures", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const bundle = loadBundle();
  const res = await bundle.handler({
    Records: [
      { messageId: "ok", body: '{"eventId":"e","action":"process"}', attributes: {} },
      { messageId: "bad", body: "nope", attributes: {} },
    ],
  });
  expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: "bad" }] });
  vi.restoreAllMocks();
});
