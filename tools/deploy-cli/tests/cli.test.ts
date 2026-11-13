import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { type Io, type RunDeps, run } from "../src/cli";
import { EXIT, workDirFor } from "../src/config";
import { RunnerError, StackLockedError, StackMissingError } from "../src/runner";
import { type Fake, ORG, clock, deferred, flush, makeFake } from "./fakes";

interface Collected {
    code: number;
    out: string[];
    err: string[];
    raw: string[];
}

async function collect(
    argv: string[],
    fake: Fake = makeFake(),
    env: RunDeps["env"] = { PULUMI_ORG: ORG },
): Promise<Collected> {
    const out: string[] = [];
    const err: string[] = [];
    const raw: string[] = [];
    const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l), raw: (c) => raw.push(c) };
    const code = await run(argv, io, { opener: fake.opener, env, now: clock(0) });
    return { code, out, err, raw };
}

describe("run: đường thành công (opener giả, không chạm Pulumi/AWS)", () => {
    it("preview: exit 0, stdout chỉ là một JSON, tiến trình ở stderr", async () => {
        const fake = makeFake({ previewSummary: { create: 11 } });
        const { code, out, err, raw } = await collect(["--domain", "worker", "--env", "dev"], fake);

        expect(code).toBe(EXIT.OK);
        expect(out).toHaveLength(1);
        const summary = JSON.parse(out[0] ?? "") as { request: unknown; reports: Array<Record<string, unknown>>; exitCode: number };
        expect(summary.exitCode).toBe(EXIT.OK);
        expect(summary.request).toEqual({ mode: "preview", domain: "worker", env: "dev", parallel: 1 });
        expect(summary.reports[0]).toMatchObject({
            domain: "worker",
            stack: "example-org/platform-worker/dev",
            status: "preview-ok",
            changeSummary: { create: 11 },
        });
        expect(err.join("\n")).toContain("stack=example-org/platform-worker/dev");
        expect(raw).toEqual(["<preview output>\n"]);
        expect(fake.selected[0]?.workDir).toBe(workDirFor("worker"));
    });

    it("apply ở dev: gọi up một lần, exit 0", async () => {
        const fake = makeFake();
        const { code } = await collect(["--domain", "worker", "--env", "dev", "--apply"], fake);
        expect(code).toBe(EXIT.OK);
        expect(fake.count("up:")).toBe(1);
    });

    it("apply bị gate chặn: exit 2, up không được gọi, stdout vẫn có JSON cho CI", async () => {
        const fake = makeFake({ previewSummary: { same: 8, replace: 1 } });
        const { code, out } = await collect(["--domain", "worker", "--env", "dev", "--apply"], fake);

        expect(code).toBe(EXIT.GATE_BLOCKED);
        expect(fake.count("up:")).toBe(0);
        const summary = JSON.parse(out[0] ?? "") as { reports: Array<{ status: string; blockedOperations: string[] }> };
        expect(summary.reports[0]).toMatchObject({ status: "blocked", blockedOperations: ["replace"] });
    });
});

describe("run: lỗi không bao giờ chạm tới opener", () => {
    it.each([
        ["input sai", ["--domain", "../../other-project", "--env", "dev"]],
        ["args rỗng", []],
        ["apply ở prod bị policy từ chối", ["--domain", "worker", "--env", "prod", "--apply"]],
    ])("%s: exit 64, stdout trống, opener không được gọi", async (_label, argv) => {
        const fake = makeFake();
        const { code, out, err } = await collect(argv, fake);
        expect(code).toBe(EXIT.USAGE);
        expect(out).toEqual([]);
        expect(err[0]).toMatch(/^error: /);
        expect(err.join("\n")).toMatch(/Usage: npm run deploy/);
        expect(fake.events).toEqual([]);
    });

    it("thiếu PULUMI_ORG: exit 1, opener không được gọi", async () => {
        const fake = makeFake();
        const { code, out, err } = await collect(["--domain", "worker", "--env", "dev"], fake, {});
        expect(code).toBe(EXIT.RUNTIME);
        expect(out).toEqual([]);
        expect(err.join("\n")).toMatch(/PULUMI_ORG is not set/);
        expect(fake.events).toEqual([]);
    });

    it("PULUMI_ORG chứa ký tự không hợp lệ: exit 1, opener không được gọi", async () => {
        const fake = makeFake();
        const { code, err } = await collect(["--domain", "worker", "--env", "dev"], fake, { PULUMI_ORG: "a/b" });
        expect(code).toBe(EXIT.RUNTIME);
        expect(err.join("\n")).toMatch(/invalid Pulumi organization name/);
        expect(fake.events).toEqual([]);
    });

});

describe("run: --domain all (config → worker)", () => {
    const argv = ["--domain", "all", "--env", "dev", "--check"];
    type Summary = {
        request: { domain: string };
        reports: Array<{ domain: string; status: string; stack: string; reason: string | null; error: string | null }>;
        exitCode: number;
    };

    it("sạch: hai báo cáo theo thứ tự config → worker, mỗi domain đúng stack của nó, exit 0", async () => {
        const fake = makeFake({ previewSummary: { same: 5 } });
        const { code, out } = await collect(argv, fake);

        expect(code).toBe(EXIT.OK);
        const summary = JSON.parse(out[0] ?? "") as Summary;
        expect(summary.reports.map((r) => `${r.domain}:${r.status}`)).toEqual(["config:check-clean", "worker:check-clean"]);
        expect(summary.reports.map((r) => r.stack)).toEqual([
            "example-org/platform-config/dev",
            "example-org/platform-worker/dev",
        ]);
        expect(fake.domainEvents.indexOf("config:preview")).toBeLessThan(fake.domainEvents.indexOf("worker:select"));
    });

    it("config lỗi: báo cáo vẫn có đủ cả hai domain (config failed, worker skipped kèm lý do), exit 1", async () => {
        const fake = makeFake({
            byDomain: { config: { selectError: new StackMissingError("example-org/platform-config/dev") } },
        });
        const { code, out, err } = await collect(argv, fake);

        expect(code).toBe(EXIT.RUNTIME);
        const summary = JSON.parse(out[0] ?? "") as Summary;
        expect(summary.reports.map((r) => `${r.domain}:${r.status}`)).toEqual(["config:failed", "worker:skipped"]);
        expect(summary.reports[1]?.reason).toBe("dependency config did not succeed (failed)");
        expect(summary.exitCode).toBe(EXIT.RUNTIME);
        expect(err.join("\n")).toContain("skipped worker: dependency config did not succeed (failed)");
        expect(fake.domainEvents.some((e) => e.startsWith("worker:"))).toBe(false);
    });

    it("apply all bị chặn ở prod trước khi chạm opener", async () => {
        const fake = makeFake();
        const { code } = await collect(["--domain", "all", "--env", "prod", "--apply"], fake);
        expect(code).toBe(EXIT.USAGE);
        expect(fake.events).toEqual([]);
    });
});

describe("run: Ctrl-C → exit 130", () => {
    async function runWithSignal(argv: string[], fake: Fake, signal: AbortSignal) {
        const out: string[] = [];
        const err: string[] = [];
        const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l), raw: () => undefined };
        const code = await run(argv, io, { opener: fake.opener, env: { PULUMI_ORG: ORG }, now: clock(0), signal });
        return { code, out, err };
    }
    type Summary = { interrupted: boolean; exitCode: number; reports: Array<{ domain: string; status: string; reason: string | null }> };

    it("đã bị ngắt từ trước: exit 130, không chạm opener, JSON nói rõ interrupted và mọi domain skipped", async () => {
        const stop = new AbortController();
        stop.abort();
        const fake = makeFake();
        const { code, out } = await runWithSignal(["--domain", "all", "--env", "dev", "--check"], fake, stop.signal);

        expect(code).toBe(EXIT.INTERRUPTED);
        expect(fake.events).toEqual([]);
        const summary = JSON.parse(out[0] ?? "") as Summary;
        expect(summary.interrupted).toBe(true);
        expect(summary.exitCode).toBe(130);
        expect(summary.reports.map((r) => r.status)).toEqual(["skipped", "skipped"]);
    });

    it("bị ngắt giữa chừng: exit 130 dù domain đang chạy kết thúc bình thường; vẫn in JSON và hướng dẫn khôi phục", async () => {
        const stop = new AbortController();
        const gate = deferred();
        const fake = makeFake({ previewSummary: { same: 1 }, byDomain: { config: { previewGate: gate.promise } } });

        const running = runWithSignal(["--domain", "all", "--env", "dev", "--check"], fake, stop.signal);
        await flush();
        stop.abort();
        gate.resolve();
        const { code, out, err } = await running;

        expect(code).toBe(EXIT.INTERRUPTED);
        const summary = JSON.parse(out[0] ?? "") as Summary;
        expect(summary.reports.map((r) => `${r.domain}:${r.status}`)).toEqual(["config:check-clean", "worker:skipped"]);
        expect(summary.interrupted).toBe(true);
        expect(err.join("\n")).toMatch(/Interrupting rolls nothing back, and this CLI did not cancel any update/);
        expect(fake.events.some((e) => e.startsWith("cancel"))).toBe(false);
    });

    it("130 thắng cả lỗi thật: domain đang chạy lỗi lúc bị ngắt vẫn ra 130, JSON ghi rõ failed", async () => {
        const stop = new AbortController();
        const gate = deferred();
        const fake = makeFake({
            byDomain: { config: { previewGate: gate.promise, previewError: new Error("AccessDenied") } },
        });

        const running = runWithSignal(["--domain", "all", "--env", "dev", "--check"], fake, stop.signal);
        await flush();
        stop.abort();
        gate.resolve();
        const { code, out } = await running;

        expect(code).toBe(EXIT.INTERRUPTED);
        const summary = JSON.parse(out[0] ?? "") as Summary;
        expect(summary.reports.map((r) => `${r.domain}:${r.status}`)).toEqual(["config:failed", "worker:skipped"]);
    });

    it("không bị ngắt: interrupted=false và exit code bình thường", async () => {
        const stop = new AbortController();
        const fake = makeFake({ previewSummary: { same: 1 } });
        const { code, out } = await runWithSignal(["--domain", "worker", "--env", "dev", "--check"], fake, stop.signal);

        expect(code).toBe(EXIT.OK);
        expect((JSON.parse(out[0] ?? "") as Summary).interrupted).toBe(false);
    });
});

describe("run: stack đang bị lock → exit 3", () => {
    const lock = () =>
        new StackLockedError("example-org/platform-worker/dev", "error: [409] Conflict: Another update is currently in progress.");

    it("--apply: exit 3, stdout vẫn có JSON với domain `locked`, stderr có hướng dẫn, không cancel", async () => {
        const fake = makeFake({ upError: lock(), previewSummary: { same: 11 } });
        const { code, out, err } = await collect(["--domain", "worker", "--env", "dev", "--apply"], fake);

        expect(code).toBe(EXIT.STACK_LOCKED);
        const summary = JSON.parse(out[0] ?? "") as { reports: Array<{ status: string; error: string }>; exitCode: number };
        expect(summary.exitCode).toBe(EXIT.STACK_LOCKED);
        expect(summary.reports[0]?.status).toBe("locked");
        expect(summary.reports[0]?.error).toContain("Another update is currently in progress");
        expect(err.join("\n")).toMatch(/pulumi stack history --stack example-org\/platform-worker\/dev/);
        expect(fake.count("up:")).toBe(1);
    });

    it("--check: exit 3 thay vì exit 1 (lỗi thật) hay 2 (có thay đổi)", async () => {
        const fake = makeFake({ previewError: lock() });
        const { code } = await collect(["--domain", "worker", "--env", "dev", "--check"], fake);
        expect(code).toBe(EXIT.STACK_LOCKED);
    });

    it("--domain all: config bị lock → worker bị skip, exit 3", async () => {
        const fake = makeFake({ byDomain: { config: { previewError: lock() } } });
        const { code, out } = await collect(["--domain", "all", "--env", "dev", "--check"], fake);
        expect(code).toBe(EXIT.STACK_LOCKED);
        const summary = JSON.parse(out[0] ?? "") as { reports: Array<{ domain: string; status: string }> };
        expect(summary.reports.map((r) => `${r.domain}:${r.status}`)).toEqual(["config:locked", "worker:skipped"]);
    });
});

describe("run: --check", () => {
    const argv = ["--domain", "worker", "--env", "dev", "--check"];

    it("sạch: exit 0, JSON status check-clean, không up", async () => {
        const fake = makeFake({ previewSummary: { same: 11 } });
        const { code, out } = await collect(argv, fake);

        expect(code).toBe(EXIT.OK);
        expect(fake.events.filter((e) => e.startsWith("preview:") || e.startsWith("up:"))).toEqual(["preview:refresh=true"]);
        const summary = JSON.parse(out[0] ?? "") as { reports: Array<{ status: string }>; exitCode: number };
        expect(summary.reports[0]?.status).toBe("check-clean");
        expect(summary.exitCode).toBe(EXIT.OK);
    });

    it("có thay đổi: exit 2, stdout vẫn có JSON liệt kê operation, không up để tự làm sạch", async () => {
        const fake = makeFake({ previewSummary: { same: 8, update: 3 } });
        const { code, out, err } = await collect(argv, fake);

        expect(code).toBe(EXIT.GATE_BLOCKED);
        expect(fake.count("up:")).toBe(0);
        const summary = JSON.parse(out[0] ?? "") as {
            reports: Array<{ status: string; blockedOperations: string[]; changeSummary: Record<string, number> }>;
        };
        expect(summary.reports[0]).toMatchObject({
            status: "check-changes",
            blockedOperations: ["update"],
            changeSummary: { same: 8, update: 3 },
        });
        expect(err.join("\n")).toContain("check found changes: update");
    });

    it("provider/auth lỗi: exit 1 và báo cáo failed: không biến thành summary rỗng rồi exit 0", async () => {
        const fake = makeFake({ previewError: new Error("failed to refresh resources: no valid credential sources") });
        const { code, out, err } = await collect(argv, fake);

        expect(code).toBe(EXIT.RUNTIME);
        const summary = JSON.parse(out[0] ?? "") as { reports: Array<{ status: string; error: string }>; exitCode: number };
        expect(summary.exitCode).toBe(EXIT.RUNTIME);
        expect(summary.reports[0]?.status).toBe("failed");
        expect(summary.reports[0]?.error).toContain("no valid credential sources");
        expect(err.join("\n")).toContain("no valid credential sources");
        expect(fake.count("up:")).toBe(0);
    });

    it("stack chưa tồn tại: exit 1, không tạo stack", async () => {
        const fake = makeFake({ selectError: new StackMissingError("example-org/platform-worker/dev") });
        const { code, out, err } = await collect(argv, fake);

        expect(code).toBe(EXIT.RUNTIME);
        expect((JSON.parse(out[0] ?? "") as { reports: Array<{ status: string }> }).reports[0]?.status).toBe("failed");
        expect(err.join("\n")).toMatch(/never creates stacks/);
        expect(fake.events).toEqual(["select:example-org/platform-worker/dev"]);
    });

    it("--apply và --check cùng lúc: exit 64 trước khi chạm opener", async () => {
        const fake = makeFake();
        const { code } = await collect([...argv, "--apply"], fake);
        expect(code).toBe(EXIT.USAGE);
        expect(fake.events).toEqual([]);
    });
});

describe("run: lỗi vận hành → exit 1 với message hữu ích, không tạo stack", () => {
    // Hợp đồng từ chặng 3: lỗi của MỘT domain là báo cáo `failed` trong JSON (CI cần biết domain nào hỏng và domain nào
    // bị skip), exit 1. Chỉ lỗi TRƯỚC khi chạy domain nào (input sai, thiếu/sai PULUMI_ORG) mới không in gì ra stdout.
    const failedReport = (out: string[]) =>
        (JSON.parse(out[0] ?? "") as { reports: Array<{ domain: string; status: string; error: string | null }>; exitCode: number });

    it("stack chưa tồn tại", async () => {
        const fake = makeFake({ selectError: new StackMissingError("example-org/platform-worker/dev") });
        const { code, out, err } = await collect(["--domain", "worker", "--env", "dev"], fake);
        expect(code).toBe(EXIT.RUNTIME);
        const summary = failedReport(out);
        expect(summary.exitCode).toBe(EXIT.RUNTIME);
        expect(summary.reports).toHaveLength(1);
        expect(summary.reports[0]).toMatchObject({ domain: "worker", status: "failed" });
        expect(summary.reports[0]?.error).toMatch(/does not exist.*never creates stacks/);
        expect(err.join("\n")).toMatch(/does not exist.*never creates stacks/);
        expect(fake.events).toEqual(["select:example-org/platform-worker/dev"]);
    });

    it("preview của provider lỗi: exit 1, không up, không biến thành summary rỗng exit 0", async () => {
        const fake = makeFake({ previewError: new Error("NoCredentialProviders: no valid credentials") });
        const { code, out, err } = await collect(["--domain", "worker", "--env", "dev", "--apply"], fake);
        expect(code).toBe(EXIT.RUNTIME);
        expect(failedReport(out).reports[0]).toMatchObject({ status: "failed" });
        expect(err.join("\n")).toContain("NoCredentialProviders");
        expect(fake.count("up:")).toBe(0);
    });

    it("lỗi không phải Error cũng ra exit 1", async () => {
        const fake = makeFake({ previewError: "plain string failure" });
        const { code, err } = await collect(["--domain", "worker", "--env", "dev"], fake);
        expect(code).toBe(EXIT.RUNTIME);
        expect(err.join("\n")).toContain("plain string failure");
    });

    it("RunnerError (config lệch) ra exit 1", async () => {
        const fake = makeFake({ selectError: new RunnerError("config mismatch") });
        const { code, err } = await collect(["--domain", "worker", "--env", "dev"], fake);
        expect(code).toBe(EXIT.RUNTIME);
        expect(err.join("\n")).toContain("config mismatch");
    });
});

describe("chạy thật như một process, từ thư mục khác", () => {
    const tsx = path.join(__dirname, "..", "node_modules", ".bin", "tsx");
    const cli = path.join(__dirname, "..", "src", "cli.ts");

    // Chỉ các ca thất bại TRƯỚC khi chạm Pulumi: test này không bao giờ được gọi Pulumi hay AWS thật,
    // kể cả khi shell đang có credentials. Vì vậy xoá PULUMI_ORG khỏi môi trường của process con.
    function spawnCli(args: string[], extraEnv: Record<string, string> = {}) {
        const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
        if (!("PULUMI_ORG" in extraEnv)) {
            delete env.PULUMI_ORG;
        }
        return spawnSync(tsx, [cli, ...args], { cwd: os.tmpdir(), env, encoding: "utf8", timeout: 60_000 });
    }

    it("input không hợp lệ: exit 64 và stdout trống", () => {
        const result = spawnCli(["--domain", "nope", "--env", "dev"]);
        expect(result.status).toBe(EXIT.USAGE);
        expect(result.stdout).toBe("");
        expect(result.stderr).toMatch(/unknown domain "nope"/);
    });

    it("apply ở prod: exit 64 qua process thật", () => {
        const result = spawnCli(["--domain", "worker", "--env", "prod", "--apply"], { PULUMI_ORG: ORG });
        expect(result.status).toBe(EXIT.USAGE);
        expect(result.stdout).toBe("");
    });

    it("thiếu PULUMI_ORG: exit 1, stdout trống, không chạm Pulumi", () => {
        const result = spawnCli(["--domain", "worker", "--env", "dev"]);
        expect(result.status).toBe(EXIT.RUNTIME);
        expect(result.stdout).toBe("");
        expect(result.stderr).toMatch(/PULUMI_ORG is not set/);
    });
});
