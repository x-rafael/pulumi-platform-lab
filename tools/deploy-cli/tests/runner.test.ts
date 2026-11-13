import { describe, expect, it } from "vitest";
import { type DeployRequest, EXIT, type Mode, workDirFor } from "../src/config";
import {
    type DomainReport,
    type DomainStatus,
    RunnerError,
    SECRET_PLACEHOLDER,
    StackLockedError,
    StackMissingError,
    exitCodeFor,
    redactOutputs,
    runDomain,
    runRequest,
    summarizeCommandFailure,
} from "../src/runner";
import { ORG, clock, deferred, flush, makeDeps, makeFake } from "./fakes";

function request(mode: Mode, overrides: Partial<Omit<DeployRequest, "mode">> = {}): DeployRequest {
    return { mode, domain: "worker", env: "dev", parallel: 1, ...overrides };
}

describe("mode preview", () => {
    it("preview không refresh, không bao giờ gọi up, và trả summary dù có create/update", async () => {
        const fake = makeFake({ previewSummary: { create: 3, update: 1, same: 7 } });
        const { deps, progress } = makeDeps(fake);

        const report = await runDomain(request("preview"), "worker", ORG, deps);

        expect(fake.count("preview:")).toBe(1);
        expect(fake.events).toContain("preview:refresh=false");
        expect(fake.count("up:")).toBe(0);
        expect(report.status).toBe("preview-ok");
        expect(report.changeSummary).toEqual({ create: 3, update: 1, same: 7 });
        expect(report.update).toBeNull();
        expect(exitCodeFor([report])).toBe(EXIT.OK);
        expect(progress).toEqual(["<preview output>\n"]);
    });

    it("preview thấy cả delete/replace vẫn là thành công (preview không phải gate)", async () => {
        const fake = makeFake({ previewSummary: { same: 5, delete: 1, replace: 1 } });
        const report = await runDomain(request("preview"), "worker", ORG, makeDeps(fake).deps);
        expect(report.status).toBe("preview-ok");
        expect(exitCodeFor([report])).toBe(EXIT.OK);
        expect(fake.count("up:")).toBe(0);
    });

    it("preview lỗi: lỗi nổi lên nguyên vẹn và không có up", async () => {
        const failure = new Error("provider exploded");
        const fake = makeFake({ previewError: failure });
        await expect(runDomain(request("preview"), "worker", ORG, makeDeps(fake).deps)).rejects.toBe(failure);
        expect(fake.count("up:")).toBe(0);
    });
});

describe("mode apply", () => {
    it("diff hợp lệ: preview có refresh rồi gọi up đúng một lần, cũng có refresh", async () => {
        const fake = makeFake({ previewSummary: { create: 11 } });
        const report = await runDomain(request("apply"), "worker", ORG, makeDeps(fake).deps);

        const operations = fake.events.filter((e) => e.startsWith("preview:") || e.startsWith("up:"));
        expect(operations).toEqual(["preview:refresh=true", "up:refresh=true"]);
        expect(report.status).toBe("applied");
        expect(report.update?.result).toBe("succeeded");
        expect(report.update?.outsideGate).toEqual([]);
        expect(exitCodeFor([report])).toBe(EXIT.OK);
    });

    it.each(["delete", "replace", "create-replacement", "delete-replaced"])(
        "preview có %s: chặn trước up, exit 2",
        async (operation) => {
            const fake = makeFake({ previewSummary: { same: 8, [operation]: 1 } });
            const { deps, logs } = makeDeps(fake);

            const report = await runDomain(request("apply"), "worker", ORG, deps);

            expect(fake.count("up:")).toBe(0);
            expect(report.status).toBe("blocked");
            expect(report.blockedOperations).toEqual([operation]);
            expect(report.update).toBeNull();
            expect(exitCodeFor([report])).toBe(EXIT.GATE_BLOCKED);
            expect(logs.join("\n")).toContain("up was not called");
        },
    );

    it("up làm điều ngoài gate dù preview sạch: báo to, không giả vờ thành công, exit 2", async () => {
        const fake = makeFake({
            previewSummary: { create: 1 },
            up: { changeSummary: { create: 1, delete: 1 } },
        });
        const { deps, logs } = makeDeps(fake);

        const report = await runDomain(request("apply"), "worker", ORG, deps);

        expect(fake.count("up:")).toBe(1);
        expect(report.status).toBe("applied-outside-gate");
        expect(report.update?.outsideGate).toEqual(["delete"]);
        expect(exitCodeFor([report])).toBe(EXIT.GATE_BLOCKED);
        expect(logs.join("\n")).toMatch(/not one atomic step/);
    });

    it("update không kết thúc succeeded: lỗi, không báo applied", async () => {
        const fake = makeFake({ up: { updateResult: "failed" } });
        await expect(runDomain(request("apply"), "worker", ORG, makeDeps(fake).deps)).rejects.toThrow(
            /finished with result "failed"/,
        );
    });

    it("up lỗi: lỗi nổi lên nguyên vẹn", async () => {
        const failure = new Error("AccessDenied");
        const fake = makeFake({ upError: failure });
        await expect(runDomain(request("apply"), "worker", ORG, makeDeps(fake).deps)).rejects.toBe(failure);
    });

    it("preview lỗi trong apply: không up", async () => {
        const fake = makeFake({ previewError: new Error("auth failed") });
        await expect(runDomain(request("apply"), "worker", ORG, makeDeps(fake).deps)).rejects.toThrow("auth failed");
        expect(fake.count("up:")).toBe(0);
    });
});

describe("mode check", () => {
    it("{ same: 11 }: sạch, preview có refresh, up không bao giờ được gọi, exit 0", async () => {
        const fake = makeFake({ previewSummary: { same: 11 } });
        const { deps, logs } = makeDeps(fake);

        const report = await runDomain(request("check"), "worker", ORG, deps);

        expect(fake.events.filter((e) => e.startsWith("preview:") || e.startsWith("up:"))).toEqual([
            "preview:refresh=true",
        ]);
        expect(report.status).toBe("check-clean");
        expect(report.blockedOperations).toEqual([]);
        expect(report.update).toBeNull();
        expect(exitCodeFor([report])).toBe(EXIT.OK);
        expect(logs.join("\n")).toContain("check clean");
    });

    it("{ same: 8, update: 1 }: có thay đổi, exit 2, up chưa được gọi", async () => {
        const fake = makeFake({ previewSummary: { same: 8, update: 1 } });
        const { deps, logs } = makeDeps(fake);

        const report = await runDomain(request("check"), "worker", ORG, deps);

        expect(report.status).toBe("check-changes");
        expect(report.blockedOperations).toEqual(["update"]);
        expect(exitCodeFor([report])).toBe(EXIT.GATE_BLOCKED);
        expect(fake.count("up:")).toBe(0);
        expect(logs.join("\n")).toContain("--check never calls up");
    });

    // Mỗi operation một ca riêng, gồm cả các bước của replace: không chỉ đếm `update`.
    it.each([
        "create",
        "update",
        "delete",
        "replace",
        "create-replacement",
        "delete-replaced",
        "import",
        "read",
        "refresh",
    ])("%s đứng riêng bên cạnh same: exit 2 và không up", async (operation) => {
        const fake = makeFake({ previewSummary: { same: 8, [operation]: 1 } });
        const report = await runDomain(request("check"), "worker", ORG, makeDeps(fake).deps);
        expect(report.status).toBe("check-changes");
        expect(report.blockedOperations).toEqual([operation]);
        expect(exitCodeFor([report])).toBe(EXIT.GATE_BLOCKED);
        expect(fake.count("up:")).toBe(0);
    });

    it("count 0 hoặc undefined không tạo false positive", async () => {
        const fake = makeFake({ previewSummary: { same: 8, update: 0, delete: undefined } });
        const report = await runDomain(request("check"), "worker", ORG, makeDeps(fake).deps);
        expect(report.status).toBe("check-clean");
        expect(exitCodeFor([report])).toBe(EXIT.OK);
    });

    it("preview lỗi: lỗi nổi lên nguyên vẹn, không up, không thành summary rỗng", async () => {
        const failure = new Error("failed to refresh: AccessDenied");
        const fake = makeFake({ previewError: failure });
        await expect(runDomain(request("check"), "worker", ORG, makeDeps(fake).deps)).rejects.toBe(failure);
        expect(fake.count("up:")).toBe(0);
    });

    it("stack chưa tồn tại: báo thiếu stack, chỉ select, không preview/up", async () => {
        const fake = makeFake({ selectError: new StackMissingError("example-org/platform-worker/dev") });
        await expect(runDomain(request("check"), "worker", ORG, makeDeps(fake).deps)).rejects.toBeInstanceOf(
            StackMissingError,
        );
        expect(fake.events).toEqual(["select:example-org/platform-worker/dev"]);
    });

    it("check đối chiếu config như các mode khác: config lệch environment thì không preview", async () => {
        const fake = makeFake({ config: { "platform-worker:environment": "prod", "aws:region": "ap-southeast-1" } });
        await expect(runDomain(request("check"), "worker", ORG, makeDeps(fake).deps)).rejects.toThrow(/but --env is "dev"/);
        expect(fake.count("preview:")).toBe(0);
    });
});

describe("chọn stack và đối chiếu config", () => {
    it("chọn đúng stack đầy đủ và workDir tuyệt đối từ allowlist", async () => {
        const fake = makeFake();
        await runDomain(request("preview"), "worker", ORG, makeDeps(fake).deps);
        expect(fake.selected).toHaveLength(1);
        expect(fake.selected[0]).toMatchObject({
            domain: "worker",
            env: "dev",
            project: "platform-worker",
            stackName: "example-org/platform-worker/dev",
            workDir: workDirFor("worker"),
        });
    });

    it("stack chưa tồn tại: báo thiếu stack, không preview/up (opener không có đường tạo stack)", async () => {
        const fake = makeFake({ selectError: new StackMissingError("example-org/platform-worker/dev") });
        const failure = runDomain(request("check"), "worker", ORG, makeDeps(fake).deps);
        await expect(failure).rejects.toBeInstanceOf(StackMissingError);
        await expect(failure).rejects.toThrow(/never creates stacks/);
        expect(fake.events).toEqual(["select:example-org/platform-worker/dev"]);
    });

    it("config environment khác --env: lỗi, không preview, không sửa config", async () => {
        const fake = makeFake({ config: { "platform-worker:environment": "prod", "aws:region": "ap-southeast-1" } });
        const failure = runDomain(request("preview"), "worker", ORG, makeDeps(fake).deps);
        await expect(failure).rejects.toBeInstanceOf(RunnerError);
        await expect(failure).rejects.toThrow(/platform-worker:environment="prod" but --env is "dev"/);
        expect(fake.count("preview:")).toBe(0);
    });

    it("thiếu config environment: lỗi thay vì đoán", async () => {
        const fake = makeFake({ config: { "aws:region": "ap-southeast-1" } });
        await expect(runDomain(request("preview"), "worker", ORG, makeDeps(fake).deps)).rejects.toThrow(
            /has no config platform-worker:environment/,
        );
        expect(fake.count("preview:")).toBe(0);
    });

    it("thiếu aws:region: lỗi thay vì chọn region", async () => {
        const fake = makeFake({ config: { "platform-worker:environment": "dev" } });
        await expect(runDomain(request("preview"), "worker", ORG, makeDeps(fake).deps)).rejects.toThrow(
            /has no config aws:region/,
        );
        expect(fake.count("preview:")).toBe(0);
    });
});

describe("thông tin in ra và JSON summary", () => {
    it("in domain/env/stack/backend/workDir TRƯỚC khi preview", async () => {
        const fake = makeFake({ backendUrl: "https://backend.example" });
        const { deps, logs } = makeDeps(fake);

        await runDomain(request("preview"), "worker", ORG, deps);

        const header = logs.join("\n");
        expect(header).toContain("domain=worker");
        expect(header).toContain("env=dev");
        expect(header).toContain("stack=example-org/platform-worker/dev");
        expect(header).toContain("region=ap-southeast-1");
        expect(header).toContain("backend=https://backend.example");
        expect(header).toContain(`workDir=${workDirFor("worker")}`);

        const firstLog = fake.events.findIndex((e) => e.startsWith("log:"));
        const firstPreview = fake.events.findIndex((e) => e.startsWith("preview:"));
        expect(firstLog).toBeGreaterThanOrEqual(0);
        expect(firstLog).toBeLessThan(firstPreview);
    });

    it("ghi duration từ đồng hồ được inject", async () => {
        const fake = makeFake();
        const report = await runDomain(request("preview"), "worker", ORG, makeDeps(fake, clock(1000, 1250.4)).deps);
        expect(report.durationMs).toBe(250);
    });

    it("report có đủ trường để CI đọc", async () => {
        const report = await runDomain(request("preview"), "worker", ORG, makeDeps(makeFake()).deps);
        expect(report).toEqual({
            domain: "worker",
            env: "dev",
            mode: "preview",
            stack: "example-org/platform-worker/dev",
            backend: "https://backend.example",
            workDir: workDirFor("worker"),
            status: "preview-ok",
            changeSummary: { create: 11 },
            blockedOperations: [],
            update: null,
            error: null,
            reason: null,
            durationMs: 0,
        });
    });
});

describe("secret", () => {
    const PLAIN = "hunter2-do-not-print";

    it("redactOutputs thay secret bằng [secret], giữ giá trị thường, không sửa đầu vào", () => {
        const input = {
            queueUrl: { value: "https://sqs.example/queue", secret: false },
            token: { value: PLAIN, secret: true },
        };
        const snapshot = JSON.stringify(input);

        expect(redactOutputs(input)).toEqual({ queueUrl: "https://sqs.example/queue", token: SECRET_PLACEHOLDER });
        expect(JSON.stringify(input)).toBe(snapshot);
    });

    it("giá trị secret không xuất hiện trong report, log hay progress", async () => {
        const fake = makeFake({
            up: {
                outputs: {
                    token: { value: PLAIN, secret: true },
                    queueUrl: { value: "https://sqs.example/queue", secret: false },
                },
            },
        });
        const { deps, logs, progress } = makeDeps(fake);

        const report = await runDomain(request("apply"), "worker", ORG, deps);

        expect(report.update?.outputs).toEqual({ token: "[secret]", queueUrl: "https://sqs.example/queue" });
        const everythingPrinted = JSON.stringify(report) + logs.join("\n") + progress.join("");
        expect(everythingPrinted).not.toContain(PLAIN);
    });
});

describe("runRequest: nhiều domain", () => {
    const all = (mode: Mode, overrides: Partial<Omit<DeployRequest, "mode">> = {}) =>
        request(mode, { domain: "all", ...overrides });
    const statuses = (reports: DomainReport[]) => reports.map((r) => `${r.domain}:${r.status}`);

    it("all chạy config rồi worker, báo cáo theo thứ tự phụ thuộc", async () => {
        const fake = makeFake({ previewSummary: { same: 5 } });
        const reports = await runRequest(all("check"), ORG, makeDeps(fake).deps);

        expect(statuses(reports)).toEqual(["config:check-clean", "worker:check-clean"]);
        expect(fake.selected.map((t) => t.stackName)).toEqual([
            "example-org/platform-config/dev",
            "example-org/platform-worker/dev",
        ]);
        expect(exitCodeFor(reports)).toBe(EXIT.OK);
    });

    it("--domain worker chạy đúng worker, KHÔNG kéo theo config", async () => {
        const fake = makeFake();
        const reports = await runRequest(request("preview", { domain: "worker" }), ORG, makeDeps(fake).deps);
        expect(reports.map((r) => r.domain)).toEqual(["worker"]);
        expect(fake.domainEvents.some((e) => e.startsWith("config:"))).toBe(false);
    });

    it("worker KHÔNG bắt đầu trước khi config xong, kể cả khi --parallel cho phép nhiều domain cùng lúc", async () => {
        const configPreview = deferred();
        const fake = makeFake({ byDomain: { config: { previewGate: configPreview.promise } } });

        const running = runRequest(all("check", { parallel: 8 }), ORG, makeDeps(fake).deps);
        await flush();
        expect(fake.domainEvents).toEqual(["config:select", "config:preview"]); // worker chưa được select

        configPreview.resolve();
        await running;
        expect(fake.domainEvents).toEqual([
            "config:select",
            "config:preview",
            "worker:select",
            "worker:preview",
        ]);
        expect(fake.peakConcurrency()).toBe(1); // phụ thuộc nhau nên không bao giờ chạy cùng lúc
    });

    describe("giới hạn song song với domain độc lập (đồ thị truyền vào)", () => {
        const independent = { config: [], worker: [] } as const;

        it("--parallel 1: chỉ một domain chạy tại một thời điểm", async () => {
            const gate = deferred();
            const fake = makeFake({ previewGate: gate.promise });
            const running = runRequest(all("check", { parallel: 1 }), ORG, makeDeps(fake).deps, independent);

            await flush();
            expect(fake.domainEvents.filter((e) => e.endsWith(":preview"))).toHaveLength(1);
            gate.resolve();
            await running;
            expect(fake.peakConcurrency()).toBe(1);
        });

        it("--parallel 2: hai domain độc lập chạy cùng lúc và không vượt giới hạn", async () => {
            const gate = deferred();
            const fake = makeFake({ previewGate: gate.promise, previewSummary: { same: 1 } });
            const running = runRequest(all("check", { parallel: 2 }), ORG, makeDeps(fake).deps, independent);

            await flush();
            expect(fake.domainEvents.filter((e) => e.endsWith(":preview"))).toHaveLength(2);
            gate.resolve();
            const reports = await running;
            expect(fake.peakConcurrency()).toBe(2);
            expect(statuses(reports)).toEqual(["config:check-clean", "worker:check-clean"]);
        });
    });

    describe("apply: dependency phải `applied`, và không bắt đầu gì mới sau thất bại đầu tiên", () => {
        it("config applied → worker mới chạy, up theo đúng thứ tự", async () => {
            const fake = makeFake({ previewSummary: { create: 1 } });
            const reports = await runRequest(all("apply"), ORG, makeDeps(fake).deps);

            expect(statuses(reports)).toEqual(["config:applied", "worker:applied"]);
            expect(fake.domainEvents.filter((e) => e.endsWith(":up"))).toEqual(["config:up", "worker:up"]);
            expect(exitCodeFor(reports)).toBe(EXIT.OK);
        });

        it("config bị gate chặn → worker bị skip, không select, exit 2", async () => {
            const fake = makeFake({ byDomain: { config: { previewSummary: { same: 1, delete: 1 } } } });
            const { deps, logs } = makeDeps(fake);
            const reports = await runRequest(all("apply"), ORG, deps);

            expect(statuses(reports)).toEqual(["config:blocked", "worker:skipped"]);
            expect(reports[1]?.reason).toBe("dependency config did not succeed (blocked)");
            expect(fake.domainEvents.some((e) => e.startsWith("worker:"))).toBe(false);
            expect(fake.count("up:")).toBe(0);
            expect(logs.join("\n")).toContain("skipped worker: dependency config did not succeed (blocked)");
            expect(exitCodeFor(reports)).toBe(EXIT.GATE_BLOCKED);
        });

        it("config `up` vượt gate → worker bị skip", async () => {
            const fake = makeFake({
                byDomain: { config: { previewSummary: { create: 1 }, up: { changeSummary: { create: 1, delete: 1 } } } },
            });
            const reports = await runRequest(all("apply"), ORG, makeDeps(fake).deps);
            expect(statuses(reports)).toEqual(["config:applied-outside-gate", "worker:skipped"]);
            expect(fake.domainEvents.filter((e) => e.startsWith("worker:"))).toEqual([]);
        });

        it("config lỗi → failed (kèm lỗi), worker skip, exit 1, lỗi chỉ log một lần", async () => {
            const fake = makeFake({ byDomain: { config: { upError: new Error("AccessDenied: ssm:PutParameter") } } });
            const { deps, logs } = makeDeps(fake);
            const reports = await runRequest(all("apply"), ORG, deps);

            expect(statuses(reports)).toEqual(["config:failed", "worker:skipped"]);
            expect(reports[0]?.error).toBe("AccessDenied: ssm:PutParameter");
            expect(reports[1]?.reason).toBe("dependency config did not succeed (failed)");
            expect(exitCodeFor(reports)).toBe(EXIT.RUNTIME);
            expect(logs.filter((line) => line.includes("AccessDenied: ssm:PutParameter"))).toHaveLength(1);
        });

        it("domain độc lập đang chạy vẫn được đợi và ghi nhận khi domain kia thất bại; domain chưa bắt đầu thì bị skip", async () => {
            const gate = deferred();
            const fake = makeFake({
                byDomain: {
                    config: { previewGate: gate.promise },
                    worker: { previewError: new Error("boom") },
                },
            });
            const independent = { config: [], worker: [] } as const;
            const running = runRequest(all("apply", { parallel: 2 }), ORG, makeDeps(fake).deps, independent);

            await flush();
            gate.resolve();
            const reports = await running;

            expect(statuses(reports)).toEqual(["config:applied", "worker:failed"]);
            expect(exitCodeFor(reports)).toBe(EXIT.RUNTIME);
        });

        it("--parallel 1 và domain đầu thất bại: domain sau không bắt đầu (fail-fast)", async () => {
            const fake = makeFake({ byDomain: { config: { previewError: new Error("boom") } } });
            const independent = { config: [], worker: [] } as const;
            const reports = await runRequest(all("apply", { parallel: 1 }), ORG, makeDeps(fake).deps, independent);

            expect(statuses(reports)).toEqual(["config:failed", "worker:skipped"]);
            expect(reports[1]?.reason).toMatch(/not started: config did not succeed/);
            expect(fake.domainEvents.some((e) => e.startsWith("worker:"))).toBe(false);
        });
    });

    describe("chỉ đọc (preview/check): dependency chỉ cần chạy được", () => {
        it("check: config có thay đổi thì worker VẪN được check, exit 2", async () => {
            const fake = makeFake({
                previewSummary: { same: 1 },
                byDomain: { config: { previewSummary: { same: 1, update: 1 } } },
            });
            const reports = await runRequest(all("check"), ORG, makeDeps(fake).deps);

            expect(statuses(reports)).toEqual(["config:check-changes", "worker:check-clean"]);
            expect(fake.domainEvents).toContain("worker:preview");
            expect(exitCodeFor(reports)).toBe(EXIT.GATE_BLOCKED);
        });

        it("check: config lỗi (stack thiếu) → worker bị skip, exit 1", async () => {
            const fake = makeFake({ byDomain: { config: { selectError: new StackMissingError("example-org/platform-config/dev") } } });
            const reports = await runRequest(all("check"), ORG, makeDeps(fake).deps);

            expect(statuses(reports)).toEqual(["config:failed", "worker:skipped"]);
            expect(reports[0]?.error).toMatch(/never creates stacks/);
            expect(reports[1]?.reason).toBe("dependency config did not succeed (failed)");
            expect(exitCodeFor(reports)).toBe(EXIT.RUNTIME);
        });

        it("preview: config lỗi → worker bị skip", async () => {
            const fake = makeFake({ byDomain: { config: { previewError: new Error("no credentials") } } });
            const reports = await runRequest(all("preview"), ORG, makeDeps(fake).deps);
            expect(statuses(reports)).toEqual(["config:failed", "worker:skipped"]);
        });

        it("domain độc lập với domain hỏng vẫn chạy tiếp (không fail-fast)", async () => {
            const fake = makeFake({
                previewSummary: { same: 1 },
                byDomain: { config: { previewError: new Error("boom") } },
            });
            const independent = { config: [], worker: [] } as const;
            const reports = await runRequest(all("check", { parallel: 1 }), ORG, makeDeps(fake).deps, independent);
            expect(statuses(reports)).toEqual(["config:failed", "worker:check-clean"]);
        });
    });

    it("tên org sai → throw trước khi chạm vào bất kỳ domain nào (không có báo cáo một phần)", async () => {
        const fake = makeFake();
        await expect(runRequest(all("check"), "a/b", makeDeps(fake).deps)).rejects.toThrow(/invalid Pulumi organization name/);
        expect(fake.events).toEqual([]);
    });

    it("mỗi domain ghi đúng tên stack và workDir của chính nó", async () => {
        const fake = makeFake();
        const reports = await runRequest(all("preview"), ORG, makeDeps(fake).deps);
        expect(reports.map((r) => r.workDir)).toEqual([workDirFor("config"), workDirFor("worker")]);
    });
});

describe("stack bị lock bởi update khác (exit 3)", () => {
    const STACK = "example-org/platform-worker/dev";
    const locked = () => new StackLockedError(STACK, "error: [409] Conflict: Another update is currently in progress.");
    const all = (mode: Mode, overrides: Partial<Omit<DeployRequest, "mode">> = {}) =>
        request(mode, { domain: "all", ...overrides });
    const statuses = (reports: DomainReport[]) => reports.map((r) => `${r.domain}:${r.status}`);
    const independent = { config: [], worker: [] } as const;

    it("up bị lock: domain `locked` (không phải failed), lỗi nêu cách xử lý, exit 3, lỗi chỉ log một lần", async () => {
        const fake = makeFake({ upError: locked() });
        const { deps, logs } = makeDeps(fake);
        const [report] = await runRequest(request("apply"), ORG, deps);

        expect(report?.status).toBe("locked");
        expect(report?.error).toContain("locked by another update");
        expect(report?.error).toContain("never cancels or breaks another update");
        expect(exitCodeFor(report ? [report] : [])).toBe(EXIT.STACK_LOCKED);
        expect(logs.filter((line) => line.includes("locked by another update"))).toHaveLength(1);
    });

    it("lock ở bước preview của check cũng là `locked`, không phải failed", async () => {
        const fake = makeFake({ previewError: locked() });
        const [report] = await runRequest(request("check"), ORG, makeDeps(fake).deps);
        expect(report?.status).toBe("locked");
        expect(fake.count("up:")).toBe(0);
    });

    it("không bao giờ gọi cancel hay up lại để chiếm lock: chỉ đúng một lần thử", async () => {
        const fake = makeFake({ upError: locked(), previewSummary: { create: 1 } });
        await runRequest(request("apply"), ORG, makeDeps(fake).deps);
        expect(fake.count("up:")).toBe(1); // không retry
        expect(fake.events.some((e) => e.startsWith("cancel"))).toBe(false);
    });

    it("apply: dependency bị lock → domain phụ thuộc bị skip, exit 3", async () => {
        const fake = makeFake({ byDomain: { config: { upError: locked() } } });
        const reports = await runRequest(all("apply"), ORG, makeDeps(fake).deps);

        expect(statuses(reports)).toEqual(["config:locked", "worker:skipped"]);
        expect(reports[1]?.reason).toBe("dependency config did not succeed (locked)");
        expect(fake.domainEvents.some((e) => e.startsWith("worker:"))).toBe(false);
        expect(exitCodeFor(reports)).toBe(EXIT.STACK_LOCKED);
    });

    it("chỉ đọc: dependency bị lock cũng không cho domain phụ thuộc chạy", async () => {
        const fake = makeFake({ byDomain: { config: { previewError: locked() } } });
        const reports = await runRequest(all("check"), ORG, makeDeps(fake).deps);
        expect(statuses(reports)).toEqual(["config:locked", "worker:skipped"]);
        expect(exitCodeFor(reports)).toBe(EXIT.STACK_LOCKED);
    });

    it("lock không che lỗi thật: một domain locked + một domain failed → exit 1", async () => {
        const fake = makeFake({
            byDomain: { config: { previewError: locked() }, worker: { previewError: new Error("AccessDenied") } },
        });
        const reports = await runRequest(all("check", { parallel: 2 }), ORG, makeDeps(fake).deps, independent);
        expect(statuses(reports).sort()).toEqual(["config:locked", "worker:failed"]);
        expect(exitCodeFor(reports)).toBe(EXIT.RUNTIME);
    });

    it("lock thắng gate: một domain locked + một domain check-changes → exit 3", async () => {
        const fake = makeFake({
            previewSummary: { same: 1, update: 1 },
            byDomain: { config: { previewError: locked() } },
        });
        const reports = await runRequest(all("check", { parallel: 2 }), ORG, makeDeps(fake).deps, independent);
        expect(statuses(reports).sort()).toEqual(["config:locked", "worker:check-changes"]);
        expect(exitCodeFor(reports)).toBe(EXIT.STACK_LOCKED);
    });
});

describe("summarizeCommandFailure", () => {
    // Dạng message thật của CommandError khi profile AWS không tồn tại (đã rút gọn URN).
    const sdkMessage = [
        "code: -2",
        " stdout: ",
        " stderr: Command failed with exit code 1: pulumi preview --refresh --stack org/proj/dev",
        "error: could not load provider for resource urn:x: could not create provider",
        "\t* failed to get shared config profile, profile-khong-ton-tai",
        "",
        "",
        "Previewing update (dev)",
        "",
        "Resources:",
    ].join("\n");

    it("giữ nguyên nhân từ stderr, bỏ tiêu đề code và phần output bị lặp", () => {
        const summary = summarizeCommandFailure(sdkMessage);
        expect(summary).toContain("failed to get shared config profile, profile-khong-ton-tai");
        expect(summary).not.toContain("code: -2");
        expect(summary).not.toContain("Previewing update");
    });

    it("bỏ mã màu ANSI để log CI và JSON đọc được", () => {
        const colored = "code: -2\n stdout: \n stderr: error: \u001b[36m<ref *1>\u001b[39m Error: Required output 'x' missing\n\n\nrest";
        expect(summarizeCommandFailure(colored)).toBe("error: <ref *1> Error: Required output 'x' missing");
    });

    it("stderr rỗng thì trả lại nguyên message thay vì chuỗi rỗng", () => {
        expect(summarizeCommandFailure("code: 1\n stdout: boom\n stderr: ")).toBe("code: 1\n stdout: boom\n stderr:");
    });

    it("message không theo dạng của SDK thì giữ nguyên", () => {
        expect(summarizeCommandFailure("  plain failure  ")).toBe("plain failure");
    });
});

describe("exitCodeFor", () => {
    const report = (status: DomainStatus) => ({ status }) as DomainReport;

    it.each([
        [["preview-ok"], EXIT.OK],
        [["applied"], EXIT.OK],
        [["check-clean"], EXIT.OK],
        [["blocked"], EXIT.GATE_BLOCKED],
        [["applied-outside-gate"], EXIT.GATE_BLOCKED],
        [["check-changes"], EXIT.GATE_BLOCKED],
        [["applied", "blocked"], EXIT.GATE_BLOCKED],
        [["check-clean", "check-changes"], EXIT.GATE_BLOCKED],
        [["blocked", "skipped"], EXIT.GATE_BLOCKED],
        [["skipped"], EXIT.GATE_BLOCKED],
        [["failed"], EXIT.RUNTIME],
        [["applied", "failed"], EXIT.RUNTIME],
        // lỗi vận hành thắng gate: cần thấy ngay là có gì hỏng chứ không chỉ là "có thay đổi"
        [["blocked", "failed"], EXIT.RUNTIME],
        [["failed", "skipped"], EXIT.RUNTIME],
        // lock (3): thắng gate/skip (2) nhưng thua lỗi thật (1)
        [["locked"], EXIT.STACK_LOCKED],
        [["locked", "skipped"], EXIT.STACK_LOCKED],
        [["locked", "blocked"], EXIT.STACK_LOCKED],
        [["check-changes", "locked"], EXIT.STACK_LOCKED],
        [["applied-outside-gate", "locked"], EXIT.STACK_LOCKED],
        [["locked", "failed"], EXIT.RUNTIME],
        [["failed", "locked"], EXIT.RUNTIME],
    ] as const)("%j → %i", (statuses, expected) => {
        expect(exitCodeFor(statuses.map(report))).toBe(expected);
    });
});
