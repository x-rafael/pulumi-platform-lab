import { CommandError, ConcurrentUpdateError, StackNotFoundError } from "@pulumi/pulumi/automation";
import { describe, expect, it } from "vitest";
import { translateFailure } from "../src/adapter";
import { RunnerError, StackLockedError, StackMissingError } from "../src/runner";

// Phần nối với SDK không có unit test (cần Pulumi CLI thật), nhưng phần DỊCH LỖI là hàm thuần nên được test bằng
// chính các lớp lỗi thật của SDK. Constructor của các lớp này là @internal (nhận CommandResult); ở runtime nó chỉ
// gọi `.toString()`, và message thật có đúng dạng "code: …\n stdout: …\n stderr: …" nên dựng lại bằng chuỗi cùng dạng.
const sdkMessage = (stderr: string) => `code: 255\n stdout: \n stderr: ${stderr}\n err?: \n`;

const CONTEXT = { stackName: "example-org/platform-worker/dev", operation: "up" };

const CLOUD_CONFLICT = sdkMessage(
    "Command failed with exit code 255: pulumi up --stack example-org/platform-worker/dev\n" +
        "error: [409] Conflict: Another update is currently in progress.\n\n\nUpdating (dev)",
);
const DIY_LOCK = sdkMessage("error: the stack is currently locked by 1 lock(s). Either wait for the process(es) to end or delete the lock file");

describe("translateFailure", () => {
    it("ConcurrentUpdateError (Pulumi Cloud) → StackLockedError nêu tên stack, nguyên nhân và cách xử lý", () => {
        const original = new ConcurrentUpdateError(CLOUD_CONFLICT);
        const translated = translateFailure(original, CONTEXT);

        expect(translated).toBeInstanceOf(StackLockedError);
        expect(translated).toBeInstanceOf(RunnerError);
        const message = (translated as Error).message;
        expect(message).toContain('"example-org/platform-worker/dev"');
        expect(message).toContain("[409] Conflict: Another update is currently in progress.");
        expect(message).toContain("never cancels or breaks another update");
        expect(message).toContain("pulumi stack history --stack example-org/platform-worker/dev");
        expect((translated as Error).cause).toBe(original); // lỗi gốc được giữ để điều tra
    });

    it("ConcurrentUpdateError (backend DIY, khoá file) cũng thành StackLockedError", () => {
        const translated = translateFailure(new ConcurrentUpdateError(DIY_LOCK), CONTEXT);
        expect(translated).toBeInstanceOf(StackLockedError);
        expect((translated as Error).message).toContain("the stack is currently locked by");
    });

    it("lock KHÔNG bị nuốt thành lỗi chung: thứ tự kiểm tra lớp con trước CommandError", () => {
        const translated = translateFailure(new ConcurrentUpdateError(CLOUD_CONFLICT), CONTEXT);
        expect((translated as Error).name).toBe("StackLockedError");
        expect((translated as Error).message).not.toContain("pulumi up failed");
    });

    it("StackNotFoundError → StackMissingError (CLI không tạo stack)", () => {
        const translated = translateFailure(
            new StackNotFoundError(sdkMessage("error: no stack named 'x' found")),
            { stackName: "example-org/platform-worker/test", operation: "select stack" },
        );
        expect(translated).toBeInstanceOf(StackMissingError);
        expect((translated as Error).message).toMatch(/never creates stacks/);
    });

    it("CommandError khác → RunnerError với nguyên nhân gọn, không còn tiêu đề 'code: -2' thô", () => {
        const original = new CommandError(
            sdkMessage("Command failed with exit code 1: pulumi preview\nerror: failed to get shared config profile, nope\n\n\nPreviewing") as never,
        );
        const translated = translateFailure(original, { stackName: CONTEXT.stackName, operation: "preview" });

        expect(translated).toBeInstanceOf(RunnerError);
        expect(translated).not.toBeInstanceOf(StackLockedError);
        const message = (translated as Error).message;
        expect(message).toContain("pulumi preview failed:");
        expect(message).toContain("failed to get shared config profile, nope");
        expect(message).not.toContain("code: 255");
        expect(message).not.toContain("Previewing");
        expect((translated as Error).cause).toBe(original);
    });

    it.each([
        ["TypeError", new TypeError("bug")],
        ["chuỗi", "plain failure"],
        ["undefined", undefined],
    ])("lỗi không phải của SDK (%s) đi qua nguyên vẹn", (_label, error) => {
        expect(translateFailure(error, CONTEXT)).toBe(error);
    });

    it("tên operation đi vào thông báo, để biết lệnh nào hỏng (kể cả select/whoami/config)", () => {
        for (const operation of ["select stack", "whoami", "config read", "preview", "up"]) {
            const translated = translateFailure(new CommandError(sdkMessage("error: boom") as never), {
                stackName: CONTEXT.stackName,
                operation,
            });
            expect((translated as Error).message).toContain(`pulumi ${operation} failed:`);
        }
    });
});
