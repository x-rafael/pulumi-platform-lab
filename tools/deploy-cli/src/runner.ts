import { type ChangeSummary, blockedApplyOperations, unexpectedOperations } from "./changes";
import {
    type DeployRequest,
    type Domain,
    type Environment,
    EXIT,
    type Mode,
    domainsFor,
    graphFor,
    isDomain,
    projectFor,
    stackNameFor,
    workDirFor,
} from "./config";
import { type DependencyGraph, type SkipCause, deployOrder, runGraph } from "./scheduler";

// ---------------------------------------------------------------------------
// Runner: quyết định có preview/apply hay không và báo cáo kết quả.
// Không import Pulumi SDK. Chỉ phụ thuộc interface nhỏ dưới đây; adapter.ts là bản dùng Automation API,
// tests dùng bản giả. Nhờ vậy test xác nhận quyết định (có gọi `up` hay không), không xác nhận tên hàm của SDK.
// ---------------------------------------------------------------------------

export interface StackTarget {
    domain: Domain;
    env: Environment;
    /** Tên Pulumi project, cũng là namespace của config. */
    project: string;
    /** `<org>/<project>/<stack>` */
    stackName: string;
    /** Đường dẫn tuyệt đối của Pulumi project. */
    workDir: string;
}

export interface StackOutput {
    value: unknown;
    secret: boolean;
}

export interface OperationOptions {
    /** Có refresh state theo AWS thật trước khi tính kế hoạch hay không. */
    refresh: boolean;
    /** Nhận từng đoạn output của engine (không phải từng dòng). */
    onOutput: (chunk: string) => void;
}

export interface PreviewOutcome {
    changeSummary: ChangeSummary;
}

export interface UpOutcome {
    /** Kết quả của update theo Pulumi, ví dụ "succeeded". */
    updateResult: string;
    /** Operations `up` thực sự đã chạy (có thể khác bản preview đã duyệt). */
    changeSummary: ChangeSummary;
    outputs: Readonly<Record<string, StackOutput>>;
}

/** Một stack đã chọn. Không có hàm tạo stack hay đổi config: runner không có đường nào để làm hai việc đó. */
export interface StackSession {
    readonly backendUrl: string | undefined;
    readonly user: string | undefined;
    /** Chỉ trả đúng các key được hỏi (giá trị secret được thay bằng "[secret]"), không bao giờ trả cả map config. */
    readConfig(keys: readonly string[]): Promise<Readonly<Record<string, string | undefined>>>;
    preview(options: OperationOptions): Promise<PreviewOutcome>;
    up(options: OperationOptions): Promise<UpOutcome>;
}

/** Chỉ có `select`, không có `createOrSelect`: stack gõ sai tên không bao giờ biến thành stack mới. */
export interface StackOpener {
    select(target: StackTarget): Promise<StackSession>;
}

export interface RunnerDeps {
    opener: StackOpener;
    /** Đồng hồ đơn điệu, đơn vị ms. */
    now: () => number;
    /** Một dòng tiến trình cho người đọc (stderr). */
    log: (line: string) => void;
    /** Đoạn output thô của engine (stderr). */
    progress: (chunk: string) => void;
    /**
     * Người dùng yêu cầu dừng (Ctrl-C). Khi abort: không bắt đầu domain mới; domain đang chạy được đợi và ghi nhận.
     * KHÔNG huỷ gì đang chạy và KHÔNG gọi cancel: chỉ process nào sở hữu một update mới có quyền cancel nó, và
     * lab này chưa xác minh được quyền sở hữu đó.
     */
    signal?: AbortSignal;
}

/** Lỗi vận hành đã biết, message đủ để người đọc xử lý. cli.ts đổi thành exit 1. */
export class RunnerError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "RunnerError";
    }
}

/** Stack chưa tồn tại. Hướng dẫn tạo bằng một bước bootstrap có chủ đích, không tạo ngầm. */
export class StackMissingError extends RunnerError {
    constructor(stackName: string, options?: ErrorOptions) {
        super(
            `stack ${JSON.stringify(stackName)} does not exist. This CLI never creates stacks; ` +
                "create it deliberately (pulumi stack init) and set its config first",
            options,
        );
        this.name = "StackMissingError";
    }
}

/**
 * Message của `CommandError` trong SDK có dạng "code: -2\n stdout: …\n stderr: <nguyên nhân>\n\n<output đã stream, lặp lại>".
 * Giữ phần nguyên nhân (stderr tới dòng trống đầu tiên); không có thì trả lại nguyên message.
 */
export function summarizeCommandFailure(message: string): string {
    const marker = "stderr: ";
    const start = message.indexOf(marker);
    const body = start >= 0 ? message.slice(start + marker.length) : message;
    const blankLine = body.search(/\r?\n[ \t]*\r?\n/);
    const summary = (blankLine >= 0 ? body.slice(0, blankLine) : body).trim();
    // Pulumi/Node tô màu lỗi bằng mã ANSI; bỏ đi để log CI và trường `error` trong JSON đọc được.
    return (summary === "" ? message.trim() : summary).replace(ANSI_ESCAPE, "");
}

const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;

/**
 * Stack đang có một update khác (backend giữ lock). KHÔNG phải lỗi của lệnh này: update kia có thể thuộc một workflow
 * hoặc người khác đang chạy đúng, nên CLI không bao giờ `cancel` hay phá lock để chiếm chỗ; chỉ báo và để người
 * vận hành quyết định. cli.ts đổi thành exit 3.
 */
export class StackLockedError extends RunnerError {
    constructor(stackName: string, detail: string, options?: ErrorOptions) {
        super(
            `stack ${JSON.stringify(stackName)} is locked by another update. This CLI never cancels or breaks another ` +
                "update. Check who holds the lock (the stack's Activity page in Pulumi Cloud, or " +
                `\`pulumi stack history --stack ${stackName}\`), wait for it to finish, then run this again.\n` +
                `Pulumi said: ${detail}`,
            options,
        );
        this.name = "StackLockedError";
    }
}

// ---------------------------------------------------------------------------
// Báo cáo
// ---------------------------------------------------------------------------

export const SECRET_PLACEHOLDER = "[secret]";

export type DomainStatus =
    | "preview-ok" // preview thành công (kể cả khi có create/update)
    | "applied" // `up` chạy và chỉ làm những gì gate cho phép
    | "applied-outside-gate" // `up` đã chạy nhưng làm điều gate sẽ chặn: kế hoạch đã đổi giữa preview và up
    | "blocked" // gate chặn trước `up`, `up` không được gọi
    | "check-clean" // --check: mọi thứ là `same`
    | "check-changes" // --check: có operation khác `same`; `up` không bao giờ được gọi từ đường check
    | "failed" // domain gặp lỗi (provider, credentials, stack thiếu, config lệch...); xem `error`
    | "locked" // stack đang có update khác; domain này KHÔNG chạy được, thử lại sau; xem `error`
    | "skipped"; // domain không được chạy; xem `reason`

const SUCCESS_STATUSES: readonly DomainStatus[] = ["preview-ok", "applied", "check-clean"];

function isSuccess(status: DomainStatus): boolean {
    return SUCCESS_STATUSES.includes(status);
}

export interface UpdateReport {
    result: string;
    changeSummary: ChangeSummary;
    /** Operations nằm ngoài gate mà `up` thực sự chạy. Rỗng khi mọi thứ đúng kế hoạch. */
    outsideGate: string[];
    /** Secret đã thay bằng "[secret]". */
    outputs: Record<string, unknown>;
}

export interface DomainReport {
    domain: Domain;
    env: Environment;
    mode: Mode;
    stack: string;
    backend: string | null;
    workDir: string;
    status: DomainStatus;
    /** Kết quả preview đã dùng để quyết định. */
    changeSummary: ChangeSummary;
    /** Operations làm gate chặn: với apply (status = blocked) hoặc với check (status = check-changes). */
    blockedOperations: string[];
    /** Chỉ có khi `up` đã chạy. */
    update: UpdateReport | null;
    /** Thông báo lỗi khi status = failed hoặc locked. */
    error: string | null;
    /** Vì sao domain không chạy khi status = skipped. */
    reason: string | null;
    durationMs: number;
}

/** Thay giá trị secret bằng "[secret]". Không sửa object đầu vào. */
export function redactOutputs(outputs: Readonly<Record<string, StackOutput>>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(outputs).map(([name, output]) => [name, output.secret ? SECRET_PLACEHOLDER : output.value]),
    );
}

/**
 * Thứ tự ưu tiên khi nhiều domain có kết quả khác nhau (xem thêm `EXIT`): 1 > 3 > 2 > 0.
 * - Bất kỳ domain failed → 1: có lỗi thật cần người xem; không để một lock "thử lại sau" che nó.
 * - Còn lại, bất kỳ domain locked → 3: chỉ cần chờ update kia xong rồi chạy lại.
 * - Còn lại, mọi thứ không thành công (gate chặn, check thấy thay đổi, `up` vượt gate, domain bị skip) → 2.
 * - Không có gì bất thường → 0.
 * (130, người dùng ngắt, đứng trên cả bốn và do cli.ts đặt.)
 */
export function exitCodeFor(reports: readonly DomainReport[]): number {
    if (reports.some((report) => report.status === "failed")) {
        return EXIT.RUNTIME;
    }
    if (reports.some((report) => report.status === "locked")) {
        return EXIT.STACK_LOCKED;
    }
    return reports.every((report) => isSuccess(report.status)) ? EXIT.OK : EXIT.GATE_BLOCKED;
}

function assertNever(value: never): never {
    throw new Error(`unhandled request: ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// Chạy
// ---------------------------------------------------------------------------

type Track = (operation: string | null) => void;

/** Bọc session để ghi lại thao tác đang chạy (cho thông báo khi bị ngắt). Không đổi hành vi. */
function withActivity(session: StackSession, track: Track): StackSession {
    return {
        backendUrl: session.backendUrl,
        user: session.user,
        readConfig: (keys) => {
            track("config read");
            return session.readConfig(keys);
        },
        preview: (options) => {
            track("preview");
            return session.preview(options);
        },
        up: (options) => {
            track("up");
            return session.up(options);
        },
    };
}

/** Đối chiếu config của stack với environment người dùng yêu cầu. Khác nhau thì báo lỗi, không tự sửa config. */
async function verifyConfig(session: StackSession, target: StackTarget): Promise<string> {
    const environmentKey = `${target.project}:environment`;
    const regionKey = "aws:region";
    const config = await session.readConfig([environmentKey, regionKey]);

    const configured = config[environmentKey];
    if (configured === undefined) {
        throw new RunnerError(`stack ${target.stackName} has no config ${environmentKey}; refusing to guess`);
    }
    if (configured !== target.env) {
        throw new RunnerError(
            `stack ${target.stackName} is configured with ${environmentKey}=${JSON.stringify(configured)} ` +
                `but --env is ${JSON.stringify(target.env)}; fix the stack config deliberately, this CLI will not change it`,
        );
    }
    const region = config[regionKey];
    if (region === undefined) {
        throw new RunnerError(`stack ${target.stackName} has no config ${regionKey}; refusing to pick a region`);
    }
    return region;
}

export async function runDomain(
    request: DeployRequest,
    domain: Domain,
    org: string,
    deps: RunnerDeps,
    track: Track = () => undefined,
): Promise<DomainReport> {
    const startedAt = deps.now();
    const target: StackTarget = {
        domain,
        env: request.env,
        project: projectFor(domain),
        stackName: stackNameFor(org, domain, request.env),
        workDir: workDirFor(domain),
    };

    track("select stack");
    const session = withActivity(await deps.opener.select(target), track);
    const region = await verifyConfig(session, target);

    // Thông tin định danh trước mọi operation. Chỉ in giá trị không bí mật.
    deps.log(
        `deploy ${request.mode}: domain=${domain} env=${request.env} stack=${target.stackName} region=${region}`,
    );
    deps.log(`  backend=${session.backendUrl ?? "unknown"} user=${session.user ?? "unknown"}`);
    deps.log(`  workDir=${target.workDir}`);

    const base = {
        domain,
        env: request.env,
        mode: request.mode,
        stack: target.stackName,
        backend: session.backendUrl ?? null,
        workDir: target.workDir,
    };
    const finish = (report: Omit<DomainReport, "durationMs" | "error" | "reason" | keyof typeof base>): DomainReport => ({
        ...base,
        ...report,
        error: null,
        reason: null,
        durationMs: Math.round(deps.now() - startedAt),
    });

    switch (request.mode) {
        case "preview": {
            // Không refresh: cùng ngữ nghĩa với `pulumi preview` thủ công, và không đọc AWS thêm.
            const preview = await session.preview({ refresh: false, onOutput: deps.progress });
            return finish({
                status: "preview-ok",
                changeSummary: preview.changeSummary,
                blockedOperations: [],
                update: null,
            });
        }

        case "apply": {
            // Refresh giống `up({ refresh: true })` để kế hoạch được duyệt sát với kế hoạch sẽ chạy.
            const preview = await session.preview({ refresh: true, onOutput: deps.progress });
            const blocked = blockedApplyOperations(preview.changeSummary);
            if (blocked.length > 0) {
                deps.log(`apply blocked by lab policy: ${blocked.join(", ")}; up was not called`);
                return finish({
                    status: "blocked",
                    changeSummary: preview.changeSummary,
                    blockedOperations: blocked,
                    update: null,
                });
            }

            // `up` ghi vào hạ tầng nên là một thao tác MỚI: nếu người dùng đã yêu cầu dừng (Ctrl-C) trong lúc preview,
            // không bắt đầu nó. Preview chỉ đọc nên đã chạy xong thì giữ kết quả. Không cần rollback vì chưa ghi gì.
            if (deps.signal?.aborted === true) {
                deps.log("interrupted after preview: up was not started; nothing was applied");
                return {
                    ...finish({
                        status: "skipped",
                        changeSummary: preview.changeSummary,
                        blockedOperations: [],
                        update: null,
                    }),
                    reason: "interrupted after preview: up was not started, nothing was applied",
                };
            }

            deps.log("running up");
            const up = await session.up({ refresh: true, onOutput: deps.progress });
            if (up.updateResult !== "succeeded") {
                throw new RunnerError(`update of ${target.stackName} finished with result ${JSON.stringify(up.updateResult)}`);
            }

            // Preview rồi up không phải một transaction: up tính kế hoạch lại. Chạy lại cùng policy trên kết quả thật.
            const outsideGate = blockedApplyOperations(up.changeSummary);
            if (outsideGate.length > 0) {
                deps.log(
                    `WARNING: up ran operations outside the approved gate: ${outsideGate.join(", ")}. ` +
                        "The plan changed between preview and up (they are not one atomic step); inspect the stack before continuing",
                );
            }
            return finish({
                status: outsideGate.length > 0 ? "applied-outside-gate" : "applied",
                changeSummary: preview.changeSummary,
                blockedOperations: [],
                update: {
                    result: up.updateResult,
                    changeSummary: up.changeSummary,
                    outsideGate,
                    outputs: redactOutputs(up.outputs),
                },
            });
        }

        case "check": {
            // Stack đã được chọn bằng select (không tạo): gõ sai tên là lỗi, không phải "kiểm tra một stack trống".
            // Refresh để thấy cả thay đổi do ai đó sửa ngoài IaC. Check không bao giờ gọi up để "tự làm sạch" diff.
            const preview = await session.preview({ refresh: true, onOutput: deps.progress });
            const unexpected = unexpectedOperations(preview.changeSummary);
            deps.log(
                unexpected.length > 0
                    ? `check found changes: ${unexpected.join(", ")}; --check never calls up`
                    : "check clean: no changes",
            );
            return finish({
                status: unexpected.length > 0 ? "check-changes" : "check-clean",
                changeSummary: preview.changeSummary,
                blockedOperations: unexpected,
                update: null,
            });
        }

        default:
            return assertNever(request);
    }
}

// ---------------------------------------------------------------------------
// Nhiều domain
// ---------------------------------------------------------------------------

function asDomain(node: string): Domain {
    if (!isDomain(node)) {
        throw new Error(`internal error: ${JSON.stringify(node)} is not a known domain`);
    }
    return node;
}

/** Báo cáo cho domain không có kết quả hoàn chỉnh (lỗi hoặc không được chạy). */
function incompleteReport(
    request: DeployRequest,
    domain: Domain,
    org: string,
    fields: Pick<DomainReport, "status" | "error" | "reason" | "durationMs">,
): DomainReport {
    return {
        domain,
        env: request.env,
        mode: request.mode,
        stack: stackNameFor(org, domain, request.env),
        backend: null,
        workDir: workDirFor(domain),
        changeSummary: {},
        blockedOperations: [],
        update: null,
        ...fields,
    };
}

/**
 * Chạy một domain; mọi lỗi dự kiến (provider, credentials, stack thiếu, config lệch) thành báo cáo `failed` thay vì
 * throw, để các domain khác vẫn được ghi nhận. Mỗi lỗi chỉ được log MỘT lần, ở đây.
 */
async function runDomainSafely(
    request: DeployRequest,
    domain: Domain,
    org: string,
    deps: RunnerDeps,
    running: Map<Domain, string>,
): Promise<DomainReport> {
    const startedAt = deps.now();
    const track: Track = (operation) => {
        if (operation === null) {
            running.delete(domain);
        } else {
            running.set(domain, operation);
        }
    };
    try {
        return await runDomain(request, domain, org, deps, track);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.log(`error: ${domain}: ${message}`);
        return incompleteReport(request, domain, org, {
            // Lock không phải lỗi: domain chưa chạy được vì stack đang bận, và người vận hành cần phân biệt hai việc.
            status: error instanceof StackLockedError ? "locked" : "failed",
            error: message,
            reason: null,
            durationMs: Math.round(deps.now() - startedAt),
        });
    } finally {
        track(null);
    }
}

/**
 * Dependency có cho phép domain phụ thuộc chạy tiếp không.
 * - apply: chỉ khi dependency đã `applied` (không phải blocked, applied-outside-gate, failed, skipped).
 * - preview/check chỉ đọc: miễn dependency chạy được. Check thấy thay đổi ở config không làm worker hết ý nghĩa
 *   (worker đọc output đã deploy của config), nên chỉ failed/locked/skipped (domain không chạy được) mới chặn.
 */
function dependencySatisfied(mode: Mode, report: DomainReport): boolean {
    if (mode === "apply") {
        return report.status === "applied";
    }
    return report.status !== "failed" && report.status !== "locked" && report.status !== "skipped";
}

function skipReason(cause: SkipCause, results: ReadonlyMap<string, DomainReport>): string {
    switch (cause.kind) {
        case "dependency":
            return `dependency ${cause.node} did not succeed (${results.get(cause.node)?.status ?? "unknown"})`;
        case "halted":
            return `not started: ${cause.node} did not succeed and apply stops at the first failure`;
        case "interrupted":
            return "not started: interrupted by the user (nothing of this domain ran, so there is nothing to roll back)";
        default:
            return assertNever(cause);
    }
}

/** Việc cần làm sau khi bị ngắt, trước lần apply kế tiếp. */
export const INTERRUPT_RECOVERY =
    "after an interrupt, before the next apply: check the update history (`pulumi stack history`), the live resources " +
    "and any pending operations (`pulumi stack export`, field pending_operations), then reconcile from that evidence. " +
    "Interrupting rolls nothing back, and this CLI did not cancel any update.";

/**
 * Chạy các domain được chọn theo đồ thị phụ thuộc, từng đợt, tối đa `request.parallel` domain độc lập cùng lúc.
 * - apply: dừng bắt đầu domain mới sau domain đầu tiên không thành công (domain đang chạy vẫn được đợi).
 * - preview/check: chỉ đọc nên domain không phụ thuộc vào domain hỏng vẫn chạy tiếp.
 * Báo cáo trả theo thứ tự topo. Lỗi cấu hình (tên org sai) throw TRƯỚC khi chạy bất kỳ domain nào.
 */
export async function runRequest(
    request: DeployRequest,
    org: string,
    deps: RunnerDeps,
    // Mặc định là đồ thị thật của lab. Tham số này chỉ để test dựng đồ thị có domain độc lập và kiểm tra giới hạn
    // song song qua đúng đường chạy của CLI; đồ thị thật hiện chưa có hai domain độc lập.
    graph: DependencyGraph = graphFor(request.domain),
): Promise<DomainReport[]> {
    for (const domain of domainsFor(request.domain)) {
        stackNameFor(org, domain, request.env); // validate cho mọi domain trước khi chạm vào thứ gì
    }

    // Domain nào đang chạy thao tác nào: để khi bị ngắt, ghi rõ CLI đang đợi gì.
    const running = new Map<Domain, string>();
    const announceInterrupt = (): void => {
        const inFlight = [...running].map(([domain, operation]) => `${domain} (${operation})`);
        deps.log(
            inFlight.length > 0
                ? `interrupted: not starting anything new; waiting for ${inFlight.join(", ")} to finish`
                : "interrupted: nothing is running; not starting anything new",
        );
    };
    deps.signal?.addEventListener("abort", announceInterrupt, { once: true });
    if (deps.signal?.aborted === true) {
        announceInterrupt();
    }

    const results = await runGraph<DomainReport>({
        graph,
        limit: request.parallel,
        failFast: request.mode === "apply",
        stopSignal: deps.signal,
        run: (node) => runDomainSafely(request, asDomain(node), org, deps, running),
        isSatisfied: (report) => dependencySatisfied(request.mode, report),
        skipped: (node, cause, done) => {
            const reason = skipReason(cause, done);
            deps.log(`skipped ${node}: ${reason}`);
            return incompleteReport(request, asDomain(node), org, {
                status: "skipped",
                error: null,
                reason,
                durationMs: 0,
            });
        },
    });

    deps.signal?.removeEventListener("abort", announceInterrupt);
    if (deps.signal?.aborted === true) {
        deps.log(INTERRUPT_RECOVERY);
    }

    return deployOrder(graph).flatMap((node) => {
        const report = results.get(node);
        return report === undefined ? [] : [report];
    });
}
