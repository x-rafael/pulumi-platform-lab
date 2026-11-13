import * as path from "node:path";

// ---------------------------------------------------------------------------
// Contract của CLI: allowlist, kiểu request, exit codes.
// Không import Automation API ở đây: parser phải test được mà không chạm Pulumi/AWS.
// ---------------------------------------------------------------------------

/** Exit codes của CLI này (không phải mã mặc định của Pulumi). */
export const EXIT = {
    OK: 0,
    RUNTIME: 1, // runtime/provider/backend/auth hoặc config lỗi
    // Gate chặn thay đổi: --check thấy thay đổi (chặng 2); --apply bị policy chặn trước `up`, hoặc `up` làm
    // điều nằm ngoài gate (chặng 1). Hợp đồng gốc chỉ định nghĩa 2 cho check; mở rộng cho apply có chủ đích.
    GATE_BLOCKED: 2,
    STACK_LOCKED: 3, // stack đang có update khác
    USAGE: 64, // cú pháp/đầu vào không hợp lệ (cả apply bị policy từ chối)
    INTERRUPTED: 130, // Ctrl-C
} as const;

export const ALL = "all";
export const DOMAINS = ["config", "worker"] as const;
export const ENVIRONMENTS = ["dev", "test", "prod"] as const;
export const MODES = ["preview", "apply", "check"] as const;

/** Environment được phép `--apply`. Phần còn lại cần luồng approval riêng, chưa có trong CLI này. */
export const APPLY_ENVIRONMENTS: readonly Environment[] = ["dev"];

export const DEFAULT_PARALLEL = 1;

export type Domain = (typeof DOMAINS)[number];
export type DomainSelection = Domain | typeof ALL;
export type Environment = (typeof ENVIRONMENTS)[number];
export type Mode = (typeof MODES)[number];

/**
 * `DOMAIN_DEPENDENCIES[x]` là các domain phải xong TRƯỚC x. worker đọc output của config qua StackReference
 * (`messagePrefix`), nên config phải được deploy trước. Thứ tự giữa các stack do CLI điều phối: bản thân Pulumi
 * không tự deploy stack được tham chiếu.
 */
export const DOMAIN_DEPENDENCIES = {
    config: [],
    worker: ["config"],
} as const satisfies Record<(typeof DOMAINS)[number], readonly (typeof DOMAINS)[number][]>;

interface RequestBase {
    domain: DomainSelection;
    env: Environment;
    /** Số domain độc lập tối đa chạy cùng lúc (dùng từ chặng 3). */
    parallel: number;
}

/**
 * Discriminated union theo `mode`. Hiện ba nhánh giống hệt nhau nên chưa an toàn hơn `RequestBase & { mode: Mode }`;
 * lợi ích đến khi các nhánh có field riêng. Exhaustiveness không tự có: `switch (request.mode)` phải kết thúc bằng
 * một nhánh `default` gọi `assertNever(request)` (sẽ thêm ở runner, chặng 1).
 */
export type DeployRequest =
    | (RequestBase & { mode: "preview" })
    | (RequestBase & { mode: "apply" })
    | (RequestBase & { mode: "check" });

/** Lỗi do người dùng gõ sai hoặc bị policy từ chối: cli.ts đổi thành exit 64. */
export class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UsageError";
    }
}

export const USAGE = [
    `Usage: npm run deploy -- --domain <${[...DOMAINS, ALL].join("|")}> --env <${ENVIRONMENTS.join("|")}> [mode] [--parallel <n>]`,
    "",
    "Modes (at most one):",
    "  --preview   default; preview only, no AWS changes",
    `  --apply     preview, then up when the CLI policy allows it (env: ${APPLY_ENVIRONMENTS.join(", ")})`,
    "  --check     select an existing stack, preview with refresh; exit 2 when it finds changes",
    "",
    `--parallel <n>  positive integer, default ${DEFAULT_PARALLEL}`,
].join("\n");

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const MODE_FLAGS = {
    "--preview": "preview",
    "--apply": "apply",
    "--check": "check",
} as const satisfies Record<string, Mode>;
type ModeFlag = keyof typeof MODE_FLAGS;

const VALUE_FLAGS = ["--domain", "--env", "--parallel"] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

function isOneOf<T extends readonly string[]>(list: T, value: string): value is T[number] {
    return list.includes(value);
}

function isModeFlag(token: string): token is ModeFlag {
    return Object.hasOwn(MODE_FLAGS, token);
}

/** In giá trị người dùng nhập qua JSON.stringify để ký tự điều khiển không lọt ra terminal/CI log. */
function quote(value: string): string {
    return JSON.stringify(value);
}

function parseDomain(value: string): DomainSelection {
    if (value === ALL || isOneOf(DOMAINS, value)) {
        return value;
    }
    throw new UsageError(`unknown domain ${quote(value)}; allowed: ${[...DOMAINS, ALL].join(", ")}`);
}

function parseEnvironment(value: string): Environment {
    if (isOneOf(ENVIRONMENTS, value)) {
        return value;
    }
    throw new UsageError(`unknown env ${quote(value)}; allowed: ${ENVIRONMENTS.join(", ")}`);
}

/** Chỉ nhận chuỗi số nguyên dương thập phân thuần: không "", "0", "1.5", "1e1", "0x10", " 2 ", "007". */
function parseParallel(value: string): number {
    const parsed = /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(parsed)) {
        throw new UsageError(`--parallel must be a positive integer, got ${quote(value)}`);
    }
    return parsed;
}

/**
 * Chuyển argv (đã bỏ `node` và đường dẫn script) thành request đã validate.
 * Không gọi process.exit và không chạm Pulumi/AWS: chỉ throw UsageError.
 *
 * Quyết định cho các ca biên (mỗi ca có test):
 * - Giá trị của một flag không được bắt đầu bằng `--`, nên `--domain --env dev` là "thiếu giá trị".
 * - Flag lặp bị từ chối, kể cả `--apply --apply`.
 * - Chỉ nhận dạng `--flag value`; dạng `--flag=value` bị từ chối.
 * - Hai mode flag khác nhau luôn mâu thuẫn (`--apply --check`, `--preview --apply`, ...).
 * - Không nhận đối số vị trí.
 */
export function parseArgs(argv: readonly string[]): DeployRequest {
    const values = new Map<ValueFlag, string>();
    let modeFlag: ModeFlag | undefined;

    const tokens = argv[Symbol.iterator]();
    for (let step = tokens.next(); !step.done; step = tokens.next()) {
        const token = step.value;

        if (isModeFlag(token)) {
            if (modeFlag === token) {
                throw new UsageError(`${token} was given more than once`);
            }
            if (modeFlag !== undefined) {
                throw new UsageError(`${modeFlag} and ${token} cannot be combined`);
            }
            modeFlag = token;
        } else if (isOneOf(VALUE_FLAGS, token)) {
            const next = tokens.next();
            if (next.done || next.value.startsWith("--")) {
                throw new UsageError(`${token} requires a value`);
            }
            if (values.has(token)) {
                throw new UsageError(`${token} was given more than once`);
            }
            values.set(token, next.value);
        } else if (token.startsWith("--")) {
            const hint = token.includes("=") ? " (write `--flag value`; the `--flag=value` form is not supported)" : "";
            throw new UsageError(`unknown flag ${quote(token)}${hint}`);
        } else {
            throw new UsageError(`unexpected argument ${quote(token)}`);
        }
    }

    const domain = values.get("--domain");
    if (domain === undefined) {
        throw new UsageError("--domain is required");
    }
    const env = values.get("--env");
    if (env === undefined) {
        throw new UsageError("--env is required");
    }
    const parallel = values.get("--parallel");

    return {
        mode: modeFlag === undefined ? "preview" : MODE_FLAGS[modeFlag],
        domain: parseDomain(domain),
        env: parseEnvironment(env),
        parallel: parallel === undefined ? DEFAULT_PARALLEL : parseParallel(parallel),
    };
}

// ---------------------------------------------------------------------------
// Policy: tách riêng khỏi parser. Parser nhận `prod`, policy mới quyết định có được apply hay không.
// ---------------------------------------------------------------------------

/**
 * Từ chối apply ở environment chưa có luồng approval. Gọi trước mọi operation.
 * Không suy ra quyền deploy prod chỉ vì người chạy gõ đúng tên.
 */
export function assertApplyAllowed(request: DeployRequest): void {
    if (request.mode === "apply" && !APPLY_ENVIRONMENTS.includes(request.env)) {
        throw new UsageError(
            `--apply is not allowed for env ${quote(request.env)} (allowed: ${APPLY_ENVIRONMENTS.join(", ")}); ` +
                "this CLI has no approval flow for it yet",
        );
    }
}

// ---------------------------------------------------------------------------
// Domain → thư mục Pulumi và tên stack. Lấy từ allowlist, không nối từ user input.
// ---------------------------------------------------------------------------

/** Gốc repo tính từ vị trí file này (src → deploy-cli → tools → repo), không phụ thuộc cwd. */
export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const DOMAIN_DIRS = {
    config: path.join("infra", "config"),
    worker: path.join("infra", "worker"),
} as const satisfies Record<Domain, string>;

const PULUMI_PROJECTS = {
    config: "platform-config",
    worker: "platform-worker",
} as const satisfies Record<Domain, string>;

export function domainsFor(selection: DomainSelection): readonly Domain[] {
    return selection === ALL ? DOMAINS : [selection];
}

export function isDomain(value: string): value is Domain {
    return isOneOf(DOMAINS, value);
}

/**
 * Đồ thị phụ thuộc của riêng các domain được chọn. Chọn một domain thì KHÔNG kéo theo dependency của nó:
 * `--domain worker` chạy đúng worker, giả định config đã được deploy (thiếu output thì preview báo lỗi rõ).
 */
export function graphFor(selection: DomainSelection): Record<string, readonly string[]> {
    const selected = domainsFor(selection);
    return Object.fromEntries(
        selected.map((domain) => [domain, DOMAIN_DEPENDENCIES[domain].filter((dependency) => selected.includes(dependency))]),
    );
}

/** Đường dẫn tuyệt đối của Pulumi project (nơi có Pulumi.yaml). */
export function workDirFor(domain: Domain, repoRoot: string = REPO_ROOT): string {
    return path.join(repoRoot, DOMAIN_DIRS[domain]);
}

/** Tên Pulumi project (trùng `name:` trong Pulumi.yaml); cũng là namespace của config, vd `platform-worker:environment`. */
export function projectFor(domain: Domain): string {
    return PULUMI_PROJECTS[domain];
}

/** Org của Pulumi Cloud lấy từ biến môi trường PULUMI_ORG (cùng quy ước với workflows), không hardcode vào source. */
export function requireOrg(env: Readonly<Record<string, string | undefined>>): string {
    const org = env.PULUMI_ORG;
    if (org === undefined || org === "") {
        throw new Error("PULUMI_ORG is not set (the Pulumi organization that owns the stacks)");
    }
    return org;
}

/** Tên stack đầy đủ `<org>/<project>/<stack>`. Org lấy từ ngoài (biến môi trường PULUMI_ORG), không hardcode. */
export function stackNameFor(org: string, domain: Domain, env: Environment): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(org)) {
        throw new Error(`invalid Pulumi organization name ${quote(org)}`);
    }
    return `${org}/${PULUMI_PROJECTS[domain]}/${env}`;
}
