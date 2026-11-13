import { automationOpener } from "./adapter";
import { EXIT, USAGE, UsageError, assertApplyAllowed, parseArgs, requireOrg } from "./config";
import { type StackOpener, exitCodeFor, runRequest } from "./runner";

/** Kênh in ra ngoài; tests thay bằng bộ thu thập thay vì console. stdout chỉ dành cho JSON summary. */
export interface Io {
    /** Một dòng ra stdout. */
    out(line: string): void;
    /** Một dòng ra stderr. */
    err(line: string): void;
    /** Đoạn output thô của engine ra stderr, không thêm xuống dòng. */
    raw(chunk: string): void;
}

/** Mọi thứ chạm tới thế giới bên ngoài được truyền vào, nên `run` không tự gọi Pulumi, đọc env hay xem đồng hồ. */
export interface RunDeps {
    opener: StackOpener;
    env: Readonly<Record<string, string | undefined>>;
    /** Đồng hồ đơn điệu, ms. */
    now: () => number;
}

/**
 * Parse → policy → chạy → in JSON summary ra stdout. Tiến trình đi ra stderr để stdout đọc được bằng máy.
 * Trả exit code thay vì gọi process.exit để test được và để output kịp flush.
 */
export async function run(argv: readonly string[], io: Io, deps: RunDeps): Promise<number> {
    try {
        const request = parseArgs(argv);
        assertApplyAllowed(request);
        const org = requireOrg(deps.env);

        const reports = await runRequest(request, org, {
            opener: deps.opener,
            now: deps.now,
            log: io.err,
            progress: io.raw,
        });
        const exitCode = exitCodeFor(reports);
        io.out(JSON.stringify({ request, reports, exitCode }, null, 2));
        return exitCode;
    } catch (error) {
        if (error instanceof UsageError) {
            io.err(`error: ${error.message}`);
            io.err("");
            io.err(USAGE);
            return EXIT.USAGE;
        }
        io.err(`error: ${error instanceof Error ? error.message : String(error)}`);
        return EXIT.RUNTIME;
    }
}

// Chỉ chạy khi được gọi trực tiếp (`tsx src/cli.ts`), không chạy khi tests import `run`.
// Deps thật chỉ được dựng ở đây: một test quên truyền deps sẽ lỗi biên dịch thay vì chạy Pulumi thật.
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
    run(
        process.argv.slice(2),
        {
            out: (line) => console.log(line),
            err: (line) => console.error(line),
            raw: (chunk) => process.stderr.write(chunk),
        },
        { opener: automationOpener, env: process.env, now: () => performance.now() },
    ).then(
        (code) => {
            process.exitCode = code;
        },
        (error: unknown) => {
            // `run` đã bắt mọi lỗi; vào đây nghĩa là lỗi lập trình. Vẫn đi ra bằng exit 1 thay vì unhandled rejection.
            console.error(`error: unexpected failure: ${error instanceof Error ? error.stack : String(error)}`);
            process.exitCode = EXIT.RUNTIME;
        },
    );
}
