import { EXIT, USAGE, UsageError, assertApplyAllowed, domainsFor, parseArgs, workDirFor } from "./config";

/** Kênh in ra ngoài; tests thay bằng bộ thu thập thay vì console. */
export interface Io {
    out(line: string): void;
    err(line: string): void;
}

/**
 * Chặng 0: chỉ parse, kiểm tra policy và in request đã validate.
 * Chưa import runner/Automation API, nên input sai không thể chạm tới Pulumi hay AWS.
 * Trả exit code thay vì gọi process.exit để test được và để stdout kịp flush.
 */
export function run(argv: readonly string[], io: Io): number {
    try {
        const request = parseArgs(argv);
        assertApplyAllowed(request);
        const targets = domainsFor(request.domain).map((domain) => ({ domain, workDir: workDirFor(domain) }));
        io.out(JSON.stringify({ request, targets }, null, 2));
        return EXIT.OK;
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
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
    process.exitCode = run(process.argv.slice(2), {
        out: (line) => console.log(line),
        err: (line) => console.error(line),
    });
}
