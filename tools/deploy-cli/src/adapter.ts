import {
    CommandError,
    ConcurrentUpdateError,
    LocalWorkspace,
    StackNotFoundError,
    type Stack,
} from "@pulumi/pulumi/automation";
import {
    RunnerError,
    SECRET_PLACEHOLDER,
    StackMissingError,
    type StackOpener,
    type StackSession,
    type StackTarget,
    summarizeCommandFailure,
} from "./runner";

// Adapter dùng Automation API, là nơi DUY NHẤT import Pulumi SDK. Không có unit test vì không có logic quyết định:
// nó được kiểm chứng bằng lần chạy thật (xem bằng chứng Day 5), runner.ts mới là nơi có tests.

/** Ghi vào lịch sử update của Pulumi để biết update này đến từ CLI nào. */
const UPDATE_MESSAGE = "deploy-cli --apply";

/**
 * Lỗi lệnh Pulumi (provider, credentials, backend) thành RunnerError với nguyên nhân gọn, vẫn giữ lỗi gốc ở `cause`.
 * ConcurrentUpdateError cố ý đi qua nguyên vẹn: chặng 4 sẽ đổi nó thành exit 3 riêng.
 */
async function translateFailure<T>(operation: "preview" | "up", run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        if (error instanceof CommandError && !(error instanceof ConcurrentUpdateError)) {
            throw new RunnerError(`pulumi ${operation} failed: ${summarizeCommandFailure(error.message)}`, {
                cause: error,
            });
        }
        throw error;
    }
}

function sessionFor(stack: Stack, who: { user?: string; url?: string }): StackSession {
    return {
        backendUrl: who.url,
        user: who.user,

        async readConfig(keys) {
            // getAllConfig chạy `pulumi config --show-secrets`, tức trả plaintext của cả secret.
            // Vì vậy chỉ rút đúng các key được hỏi và không để map đi ra khỏi hàm này.
            const all = await stack.getAllConfig();
            const result: Record<string, string | undefined> = {};
            for (const key of keys) {
                const entry = Object.hasOwn(all, key) ? all[key] : undefined;
                result[key] = entry === undefined ? undefined : entry.secret ? SECRET_PLACEHOLDER : entry.value;
            }
            return result;
        },

        async preview({ refresh, onOutput }) {
            const result = await translateFailure("preview", () => stack.preview({ refresh, diff: true, onOutput }));
            return { changeSummary: result.changeSummary };
        },

        async up({ refresh, onOutput }) {
            const result = await translateFailure("up", () => stack.up({ refresh, onOutput, message: UPDATE_MESSAGE }));
            return {
                updateResult: result.summary.result,
                changeSummary: result.summary.resourceChanges ?? {},
                outputs: result.outputs,
            };
        },
    };
}

export const automationOpener: StackOpener = {
    async select(target: StackTarget): Promise<StackSession> {
        let stack: Stack;
        try {
            // selectStack chỉ chọn stack đang có. createOrSelectStack có thể tạo stack mới nên bị cố ý không dùng.
            stack = await LocalWorkspace.selectStack({ stackName: target.stackName, workDir: target.workDir });
        } catch (error) {
            if (error instanceof StackNotFoundError) {
                throw new StackMissingError(target.stackName, { cause: error });
            }
            throw error;
        }
        const who = await stack.workspace.whoAmI();
        return sessionFor(stack, who);
    },
};
