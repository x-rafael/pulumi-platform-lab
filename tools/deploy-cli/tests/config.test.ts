import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
    DEFAULT_PARALLEL,
    DOMAINS,
    REPO_ROOT,
    UsageError,
    assertApplyAllowed,
    domainsFor,
    graphFor,
    parseArgs,
    projectFor,
    stackNameFor,
    workDirFor,
} from "../src/config";

function expectUsageError(argv: string[], message: RegExp): void {
    const parse = () => parseArgs(argv);
    expect(parse).toThrow(UsageError);
    expect(parse).toThrow(message);
}

describe("parseArgs: input hợp lệ", () => {
    it("worker/dev mặc định là preview với parallel mặc định", () => {
        expect(parseArgs(["--domain", "worker", "--env", "dev"])).toEqual({
            mode: "preview",
            domain: "worker",
            env: "dev",
            parallel: DEFAULT_PARALLEL,
        });
    });

    it.each([
        ["--preview", "preview"],
        ["--apply", "apply"],
        ["--check", "check"],
    ] as const)("%s → mode %s", (flag, mode) => {
        expect(parseArgs(["--domain", "worker", "--env", "dev", flag]).mode).toBe(mode);
    });

    it("thứ tự flag không quan trọng", () => {
        expect(parseArgs(["--check", "--env", "dev", "--domain", "worker"])).toEqual(
            parseArgs(["--domain", "worker", "--env", "dev", "--check"]),
        );
    });

    it("nhận domain all, env test/prod (policy apply nằm ở assertApplyAllowed) và --parallel", () => {
        expect(parseArgs(["--domain", "all", "--env", "prod", "--check", "--parallel", "4"])).toEqual({
            mode: "check",
            domain: "all",
            env: "prod",
            parallel: 4,
        });
        expect(parseArgs(["--domain", "worker", "--env", "test"]).env).toBe("test");
    });

    it("nhận domain config (domain thứ hai của allowlist)", () => {
        expect(parseArgs(["--domain", "config", "--env", "dev"]).domain).toBe("config");
    });
});

describe("parseArgs: input bị từ chối", () => {
    it("args rỗng", () => {
        expectUsageError([], /--domain is required/);
    });

    it("thiếu env", () => {
        expectUsageError(["--domain", "worker"], /--env is required/);
    });

    it.each([
        [["--apply", "--check"], /--apply and --check cannot be combined/],
        [["--check", "--apply"], /--check and --apply cannot be combined/],
        [["--preview", "--apply"], /--preview and --apply cannot be combined/],
        [["--preview", "--check"], /--preview and --check cannot be combined/],
    ] as const)("mode mâu thuẫn %j", (modes, message) => {
        expectUsageError(["--domain", "worker", "--env", "dev", ...modes], message);
    });

    it("mode flag lặp", () => {
        expectUsageError(["--domain", "worker", "--env", "dev", "--apply", "--apply"], /--apply was given more than once/);
    });

    it.each([
        ["đường dẫn thoát khỏi repo", "../../other-project"],
        ["sai hoa/thường", "WORKER"],
        ["tên project thay vì tên domain", "platform-config"],
        ["số nhiều", "workers"],
        ["chuỗi rỗng", ""],
        ["tên thuộc tính của Object", "constructor"],
        ["tên thuộc tính của Object (proto)", "__proto__"],
        ["domain kèm path", "worker/../worker"],
    ])("domain không hợp lệ: %s", (_label, domain) => {
        expectUsageError(["--domain", domain, "--env", "dev"], /unknown domain/);
    });

    it.each(["production", "Dev", "staging", "pr-12", ""])("env không hợp lệ: %j", (env) => {
        expectUsageError(["--domain", "worker", "--env", env], /unknown env/);
    });

    it.each([
        ["--force", /unknown flag "--force"/],
        ["--help", /unknown flag "--help"/],
        ["-d", /unexpected argument "-d"/],
        ["worker", /unexpected argument "worker"/],
    ])("flag/đối số lạ: %s", (token, message) => {
        expectUsageError(["--domain", "worker", "--env", "dev", token], message);
    });

    it("dạng --flag=value bị từ chối kèm gợi ý", () => {
        expectUsageError(["--domain=worker", "--env", "dev"], /--flag=value.*not supported/);
    });

    it.each([
        [["--env", "dev", "--domain"], /--domain requires a value/],
        [["--domain", "worker", "--env"], /--env requires a value/],
        [["--domain", "worker", "--env", "dev", "--parallel"], /--parallel requires a value/],
        // giá trị kế tiếp là một flag nên --domain thiếu giá trị, không được nuốt --env làm domain
        [["--domain", "--env", "dev"], /--domain requires a value/],
        [["--domain", "worker", "--env", "--apply"], /--env requires a value/],
    ] as const)("flag thiếu giá trị %j", (argv, message) => {
        expectUsageError([...argv], message);
    });

    it.each([
        [["--env", "dev", "--env", "test", "--domain", "worker"], /--env was given more than once/],
        [["--domain", "worker", "--domain", "all", "--env", "dev"], /--domain was given more than once/],
        [["--domain", "worker", "--env", "dev", "--parallel", "1", "--parallel", "2"], /--parallel was given more than once/],
    ] as const)("value flag lặp %j", (argv, message) => {
        expectUsageError([...argv], message);
    });

    it.each([
        "0",
        "NaN",
        "",
        "1.5",
        "1e1",
        "0x10",
        " 2 ",
        "2 ",
        "-1",
        "+1",
        "007",
        "abc",
        "99999999999999999999", // khớp pattern nhưng vượt safe integer
    ])("--parallel không phải số nguyên dương: %j", (value) => {
        expectUsageError(["--domain", "worker", "--env", "dev", "--parallel", value], /--parallel must be a positive integer/);
    });

    it.each([
        ["1", 1],
        ["2", 2],
        ["16", 16],
    ])("--parallel hợp lệ: %s", (value, expected) => {
        expect(parseArgs(["--domain", "worker", "--env", "dev", "--parallel", value]).parallel).toBe(expected);
    });

    it("lỗi trích dẫn input bằng JSON để ký tự điều khiển không lọt ra log", () => {
        const parse = () => parseArgs(["--domain", "worker\u001b[31m", "--env", "dev"]);
        expect(parse).toThrow(/unknown domain "worker\\u001b\[31m"/);
    });

    it("không sửa đổi argv đầu vào", () => {
        const argv = Object.freeze(["--domain", "worker", "--env", "dev", "--check"]);
        expect(() => parseArgs(argv)).not.toThrow();
        expect(argv).toEqual(["--domain", "worker", "--env", "dev", "--check"]);
    });
});

describe("assertApplyAllowed: policy tách khỏi parser", () => {
    const request = (mode: "preview" | "apply" | "check", env: "dev" | "test" | "prod") =>
        ({ mode, domain: "worker", env, parallel: 1 }) as const;

    it("cho apply ở dev", () => {
        expect(() => assertApplyAllowed(request("apply", "dev"))).not.toThrow();
    });

    it.each(["test", "prod"] as const)("từ chối apply ở %s", (env) => {
        expect(() => assertApplyAllowed(request("apply", env))).toThrow(UsageError);
        expect(() => assertApplyAllowed(request("apply", env))).toThrow(/--apply is not allowed for env/);
    });

    it.each(["preview", "check"] as const)("vẫn cho %s ở prod (không ghi AWS)", (mode) => {
        expect(() => assertApplyAllowed(request(mode, "prod"))).not.toThrow();
    });

    it("từ chối apply all ở prod: đi từ đầu vào thật qua parseArgs", () => {
        const parsed = parseArgs(["--domain", "all", "--env", "prod", "--apply"]);
        expect(() => assertApplyAllowed(parsed)).toThrow(UsageError);
    });
});

describe("domain → thư mục và stack", () => {
    it("workDir là đường dẫn tuyệt đối tới project có Pulumi.yaml", () => {
        for (const domain of DOMAINS) {
            const workDir = workDirFor(domain);
            expect(path.isAbsolute(workDir)).toBe(true);
            expect(fs.existsSync(path.join(workDir, "Pulumi.yaml"))).toBe(true);
        }
        expect(workDirFor("worker")).toBe(path.join(REPO_ROOT, "infra", "worker"));
    });

    it("workDir tính từ repoRoot truyền vào, không phụ thuộc cwd", () => {
        expect(workDirFor("worker", "/somewhere/else")).toBe(path.join("/somewhere/else", "infra", "worker"));
    });

    it("domainsFor mở rộng all thành toàn bộ allowlist", () => {
        expect(domainsFor("all")).toEqual([...DOMAINS]);
        expect(domainsFor("worker")).toEqual(["worker"]);
        expect(domainsFor("config")).toEqual(["config"]);
    });

    it("graphFor all giữ ràng buộc worker phụ thuộc config", () => {
        expect(graphFor("all")).toEqual({ config: [], worker: ["config"] });
    });

    it("graphFor một domain KHÔNG kéo theo dependency: --domain worker chỉ chạy worker", () => {
        expect(graphFor("worker")).toEqual({ worker: [] });
        expect(graphFor("config")).toEqual({ config: [] });
    });

    it("mỗi domain có thư mục, project và stack riêng", () => {
        expect(workDirFor("config")).toBe(path.join(REPO_ROOT, "infra", "config"));
        expect(stackNameFor("example-org", "config", "dev")).toBe("example-org/platform-config/dev");
        expect(stackNameFor("example-org", "worker", "dev")).toBe("example-org/platform-worker/dev");
        expect(projectFor("config")).toBe("platform-config");
    });

    it("tên stack đầy đủ org/project/stack", () => {
        expect(stackNameFor("example-org", "worker", "dev")).toBe("example-org/platform-worker/dev");
        expect(stackNameFor("example-org", "worker", "prod")).toBe("example-org/platform-worker/prod");
    });

    it.each(["", "a/b", "../x", " org", "org ", "-org", "org\n"])("org không hợp lệ: %j", (org) => {
        expect(() => stackNameFor(org, "worker", "dev")).toThrow(/invalid Pulumi organization name/);
    });
});
