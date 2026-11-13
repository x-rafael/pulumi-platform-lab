import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { run, type Io } from "../src/cli";
import { EXIT, workDirFor } from "../src/config";

function collect(argv: string[]): { code: number; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (line) => out.push(line), err: (line) => err.push(line) };
    return { code: run(argv, io), out, err };
}

describe("run (không qua process)", () => {
    it("input hợp lệ: exit 0, stdout là JSON của request đã validate, stderr trống", () => {
        const { code, out, err } = collect(["--domain", "worker", "--env", "dev", "--check"]);
        expect(code).toBe(EXIT.OK);
        expect(err).toEqual([]);
        expect(out).toHaveLength(1);
        expect(JSON.parse(out[0] ?? "")).toEqual({
            request: { mode: "check", domain: "worker", env: "dev", parallel: 1 },
            targets: [{ domain: "worker", workDir: workDirFor("worker") }],
        });
    });

    it("input sai: exit 64, stdout trống, stderr có lý do và usage", () => {
        const { code, out, err } = collect(["--domain", "../../other-project", "--env", "dev"]);
        expect(code).toBe(EXIT.USAGE);
        expect(out).toEqual([]);
        expect(err[0]).toMatch(/^error: unknown domain/);
        expect(err.join("\n")).toMatch(/Usage: npm run deploy/);
    });

    it("apply prod bị policy từ chối trước khi in request: exit 64", () => {
        const { code, out, err } = collect(["--domain", "worker", "--env", "prod", "--apply"]);
        expect(code).toBe(EXIT.USAGE);
        expect(out).toEqual([]);
        expect(err[0]).toMatch(/--apply is not allowed for env "prod"/);
    });

    it("args rỗng: exit 64", () => {
        expect(collect([]).code).toBe(EXIT.USAGE);
    });
});

describe("chạy thật như một process từ thư mục khác", () => {
    const tsx = path.join(__dirname, "..", "node_modules", ".bin", "tsx");
    const cli = path.join(__dirname, "..", "src", "cli.ts");

    function spawnCli(args: string[]) {
        // cwd là thư mục tạm: CLI không được phụ thuộc vào nơi terminal đang đứng.
        return spawnSync(tsx, [cli, ...args], { cwd: os.tmpdir(), encoding: "utf8", timeout: 60_000 });
    }

    it("hợp lệ: exit 0 và workDir vẫn trỏ đúng infra/worker", () => {
        const result = spawnCli(["--domain", "worker", "--env", "dev"]);
        expect(result.status).toBe(EXIT.OK);
        const printed = JSON.parse(result.stdout) as { targets: Array<{ workDir: string }> };
        expect(printed.targets[0]?.workDir).toBe(workDirFor("worker"));
    });

    it("không hợp lệ: exit 64 và stdout trống", () => {
        const result = spawnCli(["--domain", "nope", "--env", "dev"]);
        expect(result.status).toBe(EXIT.USAGE);
        expect(result.stdout).toBe("");
        expect(result.stderr).toMatch(/unknown domain "nope"/);
    });
});
