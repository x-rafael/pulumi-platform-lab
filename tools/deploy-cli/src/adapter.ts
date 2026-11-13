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
    StackLockedError,
    StackMissingError,
    type StackOpener,
    type StackSession,
    type StackTarget,
    summarizeCommandFailure,
} from "./runner";

// Adapter dùng Automation API, là nơi DUY NHẤT import Pulumi SDK. Phần quyết định nằm ở runner.ts (có tests với fake);
// ở đây chỉ có (1) hàm thuần `translateFailure` đổi lỗi của SDK thành lỗi của CLI, được test bằng chính các lớp lỗi
// thật của SDK, và (2) phần nối với SDK, được kiểm chứng bằng lần chạy thật (xem bằng chứng Day 5).

/** Ghi vào lịch sử update của Pulumi để biết update này đến từ CLI nào. */
const UPDATE_MESSAGE = "deploy-cli --apply";

export interface FailureContext {
    /** Tên đầy đủ `<org>/<project>/<stack>`. */
    stackName: string;
    /** Việc đang làm, dùng trong thông báo: "preview", "up", "select stack", ... */
    operation: string;
}

/**
 * Đổi lỗi của SDK thành lỗi của CLI. Thứ tự kiểm tra quan trọng: ConcurrentUpdateError và StackNotFoundError đều
 * là lớp con của CommandError nên phải được xét trước.
 * - ConcurrentUpdateError → StackLockedError (exit 3). Không bao giờ cancel: update kia có thể là của người khác.
 * - StackNotFoundError → StackMissingError (CLI không tạo stack).
 * - CommandError khác → RunnerError với phần nguyên nhân gọn thay vì "code: -2 / stdout / stderr" thô.
 * - Lỗi lạ (không phải CommandError) đi qua nguyên vẹn.
 */
export function translateFailure(error: unknown, context: FailureContext): unknown {
    if (error instanceof ConcurrentUpdateError) {
        return new StackLockedError(context.stackName, summarizeCommandFailure(error.message), { cause: error });
    }
    if (error instanceof StackNotFoundError) {
        return new StackMissingError(context.stackName, { cause: error });
    }
    if (error instanceof CommandError) {
        return new RunnerError(`pulumi ${context.operation} failed: ${summarizeCommandFailure(error.message)}`, {
            cause: error,
        });
    }
    return error;
}

async function guard<T>(context: FailureContext, run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        throw translateFailure(error, context);
    }
}

function sessionFor(stack: Stack, who: { user?: string; url?: string }, stackName: string): StackSession {
    const guarded = <T>(operation: string, run: () => Promise<T>) => guard({ stackName, operation }, run);

    return {
        backendUrl: who.url,
        user: who.user,

        async readConfig(keys) {
            // getAllConfig chạy `pulumi config --show-secrets`, tức trả plaintext của cả secret.
            // Vì vậy chỉ rút đúng các key được hỏi và không để map đi ra khỏi hàm này.
            const all = await guarded("config read", () => stack.getAllConfig());
            const result: Record<string, string | undefined> = {};
            for (const key of keys) {
                const entry = Object.hasOwn(all, key) ? all[key] : undefined;
                result[key] = entry === undefined ? undefined : entry.secret ? SECRET_PLACEHOLDER : entry.value;
            }
            return result;
        },

        async preview({ refresh, onOutput }) {
            const result = await guarded("preview", () => stack.preview({ refresh, diff: true, onOutput }));
            return { changeSummary: result.changeSummary };
        },

        async up({ refresh, onOutput }) {
            const result = await guarded("up", () => stack.up({ refresh, onOutput, message: UPDATE_MESSAGE }));
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
        const guarded = <T>(operation: string, run: () => Promise<T>) =>
            guard({ stackName: target.stackName, operation }, run);

        // selectStack chỉ chọn stack đang có. createOrSelectStack có thể tạo stack mới nên bị cố ý không dùng.
        const stack = await guarded("select stack", () =>
            LocalWorkspace.selectStack({ stackName: target.stackName, workDir: target.workDir }),
        );
        const who = await guarded("whoami", () => stack.workspace.whoAmI());
        return sessionFor(stack, who, target.stackName);
    },
};
