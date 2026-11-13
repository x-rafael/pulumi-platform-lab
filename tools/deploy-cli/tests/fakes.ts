import type { ChangeSummary } from "../src/changes";
import type { Domain } from "../src/config";
import type {
    OperationOptions,
    RunnerDeps,
    StackOpener,
    StackSession,
    StackTarget,
    UpOutcome,
} from "../src/runner";

// Bản giả của adapter: ghi lại thứ tự gọi để test xác nhận QUYẾT ĐỊNH (có gọi `up` hay không, refresh hay không,
// domain nào chạy trước domain nào), không xác nhận cách SDK được gọi.

export const ORG = "example-org";

export interface FakeBehavior {
    config?: Record<string, string | undefined>;
    previewSummary?: ChangeSummary;
    previewError?: unknown;
    up?: Partial<UpOutcome>;
    upError?: unknown;
    selectError?: unknown;
    backendUrl?: string;
    user?: string;
    /** Giữ `select` lại tới khi promise này resolve (để kiểm tra thứ tự bắt đầu giữa các domain). */
    selectGate?: Promise<unknown>;
    /** Giữ `preview` lại tới khi promise này resolve (để đo số thao tác chạy cùng lúc). */
    previewGate?: Promise<unknown>;
}

export interface FakeOptions extends FakeBehavior {
    /** Ghi đè hành vi cho từng domain; phần còn lại dùng hành vi chung ở trên. */
    byDomain?: Partial<Record<Domain, FakeBehavior>>;
}

export interface Fake {
    opener: StackOpener;
    /** Thứ tự mọi lời gọi: `select:<stack>`, `readConfig`, `preview:refresh=<bool>`, `up:refresh=<bool>`. */
    events: string[];
    /** Cùng thứ tự nhưng có tên domain: `<domain>:select`, `<domain>:preview`, `<domain>:up`. */
    domainEvents: string[];
    selected: StackTarget[];
    /** Số preview/up chạy cùng lúc nhiều nhất đã quan sát được. */
    peakConcurrency(): number;
    count(prefix: string): number;
}

const DEFAULT_CONFIG: Record<string, string | undefined> = {
    "platform-worker:environment": "dev",
    "platform-config:environment": "dev",
    "aws:region": "ap-southeast-1",
};

export function makeFake(options: FakeOptions = {}): Fake {
    const events: string[] = [];
    const domainEvents: string[] = [];
    const selected: StackTarget[] = [];
    let active = 0;
    let peak = 0;

    const track = async <T>(work: () => Promise<T>): Promise<T> => {
        active++;
        peak = Math.max(peak, active);
        try {
            return await work();
        } finally {
            active--;
        }
    };

    // `cancel` không nằm trong interface StackSession (CLI cố ý không có đường nào để cancel): fake vẫn có nó để test
    // chứng minh không ai gọi, dù lock hay Ctrl-C.
    const sessionFor = (domain: Domain, behavior: FakeBehavior): StackSession & { cancel(): Promise<void> } => ({
        async cancel() {
            events.push(`cancel:${domain}`);
        },
        backendUrl: behavior.backendUrl ?? "https://backend.example",
        user: behavior.user ?? "tester",
        async readConfig(keys) {
            events.push("readConfig");
            const config = behavior.config ?? DEFAULT_CONFIG;
            return Object.fromEntries(keys.map((key) => [key, config[key]]));
        },
        preview: (operation: OperationOptions) =>
            track(async () => {
                events.push(`preview:refresh=${operation.refresh}`);
                domainEvents.push(`${domain}:preview`);
                operation.onOutput("<preview output>\n");
                await behavior.previewGate;
                if (behavior.previewError !== undefined) {
                    throw behavior.previewError;
                }
                return { changeSummary: behavior.previewSummary ?? { create: 11 } };
            }),
        up: (operation: OperationOptions) =>
            track(async () => {
                events.push(`up:refresh=${operation.refresh}`);
                domainEvents.push(`${domain}:up`);
                operation.onOutput("<up output>\n");
                if (behavior.upError !== undefined) {
                    throw behavior.upError;
                }
                return {
                    updateResult: "succeeded",
                    changeSummary: { create: 11 },
                    outputs: {},
                    ...behavior.up,
                };
            }),
    });

    const opener: StackOpener = {
        async select(target) {
            const behavior: FakeBehavior = { ...options, ...options.byDomain?.[target.domain] };
            events.push(`select:${target.stackName}`);
            domainEvents.push(`${target.domain}:select`);
            selected.push(target);
            await behavior.selectGate;
            if (behavior.selectError !== undefined) {
                throw behavior.selectError;
            }
            return sessionFor(target.domain, behavior);
        },
    };

    return {
        opener,
        events,
        domainEvents,
        selected,
        peakConcurrency: () => peak,
        count: (prefix) => events.filter((e) => e.startsWith(prefix)).length,
    };
}

export interface FakeDeps {
    deps: RunnerDeps;
    logs: string[];
    progress: string[];
}

/** Đồng hồ giả trả lần lượt các giá trị; hết thì giữ giá trị cuối. */
export function clock(...values: number[]): () => number {
    let index = 0;
    return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

export function makeDeps(fake: Fake, now: () => number = clock(0)): FakeDeps {
    const logs: string[] = [];
    const progress: string[] = [];
    return {
        logs,
        progress,
        deps: {
            opener: fake.opener,
            now,
            // log cũng đi vào events để test thứ tự "in thông tin trước operation".
            log: (line) => {
                logs.push(line);
                fake.events.push(`log:${line}`);
            },
            progress: (chunk) => progress.push(chunk),
        },
    };
}

/** Promise điều khiển được: test quyết định lúc nào một thao tác giả được phép tiếp tục. */
export interface Deferred<T = void> {
    promise: Promise<T>;
    resolve(value: T): void;
}

export function deferred<T = void>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

/** Nhường vòng lặp sự kiện để mọi microtask đang chờ chạy hết (không dùng sleep). */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
