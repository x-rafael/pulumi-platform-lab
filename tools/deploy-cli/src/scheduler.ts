// Thứ tự phụ thuộc và giới hạn song song. Hàm thuần/async thuần: không import Pulumi, không chạm AWS.

/**
 * `graph[node]` là danh sách node phải xong TRƯỚC `node`. Ví dụ `{ worker: ["config"], config: [] }` nghĩa là
 * config chạy trước worker. Một node tồn tại khi nó là key của graph; dependency không phải key là lỗi.
 */
export type DependencyGraph = Readonly<Record<string, readonly string[]>>;

export class UnknownDependencyError extends Error {
    constructor(
        readonly node: string,
        readonly dependency: string,
    ) {
        super(`${JSON.stringify(node)} depends on unknown node ${JSON.stringify(dependency)}`);
        this.name = "UnknownDependencyError";
    }
}

export class CycleError extends Error {
    /** Chuỗi khép kín, ví dụ ["a", "b", "a"] nghĩa là a phụ thuộc b, b phụ thuộc a. */
    constructor(readonly cycle: readonly string[]) {
        super(`dependency cycle: ${cycle.join(" -> ")}`);
        this.name = "CycleError";
    }
}

/** Chuẩn hoá: bỏ dependency trùng, bắt dependency không tồn tại. */
function normalize(graph: DependencyGraph): Map<string, Set<string>> {
    const nodes = Object.keys(graph);
    const normalized = new Map<string, Set<string>>();
    for (const node of nodes) {
        const dependencies = new Set<string>();
        for (const dependency of graph[node] ?? []) {
            if (!Object.hasOwn(graph, dependency)) {
                throw new UnknownDependencyError(node, dependency);
            }
            dependencies.add(dependency);
        }
        normalized.set(node, dependencies);
    }
    return normalized;
}

/** Tìm một vòng trong các node còn lại: mỗi node chưa xếp được có ít nhất một dependency cũng chưa xếp được. */
function findCycle(dependencies: ReadonlyMap<string, ReadonlySet<string>>, remaining: ReadonlySet<string>): string[] {
    const path: string[] = [];
    const position = new Map<string, number>();
    let current: string | undefined = [...remaining].sort()[0];
    while (current !== undefined) {
        const seenAt = position.get(current);
        if (seenAt !== undefined) {
            return [...path.slice(seenAt), current];
        }
        position.set(current, path.length);
        path.push(current);
        current = [...(dependencies.get(current) ?? [])].filter((dependency) => remaining.has(dependency)).sort()[0];
    }
    throw new Error("internal error: no cycle found among nodes that could not be ordered");
}

/**
 * Chia graph thành các đợt: node vào đợt đầu tiên mà mọi dependency của nó đã nằm ở đợt trước.
 * Các node cùng đợt độc lập với nhau nên có thể chạy cùng lúc; trong đợt sắp theo tên để kết quả ổn định.
 * Có vòng thì throw CycleError, không bao giờ trả thứ tự thiếu node.
 */
export function deployWaves(graph: DependencyGraph): string[][] {
    const dependencies = normalize(graph);
    const remaining = new Set(dependencies.keys());
    const done = new Set<string>();
    const waves: string[][] = [];

    while (remaining.size > 0) {
        const wave = [...remaining]
            .filter((node) => [...(dependencies.get(node) ?? [])].every((dependency) => done.has(dependency)))
            .sort();
        if (wave.length === 0) {
            throw new CycleError(findCycle(dependencies, remaining));
        }
        for (const node of wave) {
            remaining.delete(node);
            done.add(node);
        }
        waves.push(wave);
    }
    return waves;
}

/**
 * Thứ tự phẳng thoả mọi ràng buộc. Lưu ý: sắp theo SỐ dependency KHÔNG đúng. Với
 * `{ a: ["b"], b: ["c", "d"], c: [], d: [] }` thì a (1 dependency) đứng trước b (2 dependency) dù a cần b xong trước.
 * Số dependency trực tiếp không nói gì về độ sâu của chuỗi phụ thuộc, nên phải đi theo cạnh của graph.
 */
export function deployOrder(graph: DependencyGraph): string[] {
    return deployWaves(graph).flat();
}

// ---------------------------------------------------------------------------
// Giới hạn song song
// ---------------------------------------------------------------------------

function assertLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError(`limit must be a positive integer, got ${String(limit)}`);
    }
}

/**
 * Chạy `tasks` với tối đa `limit` task cùng lúc. Task chỉ được gọi khi đã có slot.
 * Kết quả theo thứ tự đầu vào, không theo thứ tự hoàn thành.
 *
 * Khi một task lỗi: không nhận task mới, ĐỢI các task đã chạy xong rồi mới reject với lỗi đầu tiên
 * (không bỏ rơi công việc đang chạy giữa chừng). Lỗi đến sau lỗi đầu tiên không được báo ở đây; nơi cần biết
 * mọi kết quả (như runGraph) tự ghi nhận trong task trước khi throw.
 */
export async function runWithLimit<T>(tasks: ReadonlyArray<() => Promise<T>>, limit: number): Promise<T[]> {
    assertLimit(limit);

    const results = new Array<T>(tasks.length);
    let nextIndex = 0;
    let failed = false;
    let firstError: unknown;

    async function lane(): Promise<void> {
        while (!failed) {
            const index = nextIndex++;
            const task = tasks[index];
            if (task === undefined) {
                return;
            }
            try {
                results[index] = await task();
            } catch (error) {
                if (!failed) {
                    failed = true;
                    firstError = error;
                }
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, lane));
    if (failed) {
        throw firstError;
    }
    return results;
}

// ---------------------------------------------------------------------------
// Chạy graph theo đợt
// ---------------------------------------------------------------------------

export type SkipCause =
    /** Một dependency không đạt `isSatisfied` (đã lỗi, bị chặn, hoặc chính nó bị skip). */
    | { kind: "dependency"; node: string }
    /** failFast: một node trước đó không đạt, nên không bắt đầu node mới. */
    | { kind: "halted"; node: string };

export interface RunGraphOptions<R> {
    graph: DependencyGraph;
    /** Số node độc lập tối đa chạy cùng lúc. */
    limit: number;
    /**
     * true: sau node đầu tiên không đạt, không bắt đầu node mới (node đã chạy vẫn được đợi và ghi nhận).
     * false: node không phụ thuộc vào node hỏng vẫn tiếp tục.
     */
    failFast: boolean;
    /** Phải trả kết quả cho mọi thất bại dự kiến thay vì throw; throw nghĩa là lỗi lập trình và làm hỏng cả lượt. */
    run(node: string): Promise<R>;
    /** Dependency này có cho phép node phụ thuộc vào nó chạy không. */
    isSatisfied(result: R): boolean;
    /** Kết quả cho node không được chạy. Phải KHÔNG đạt `isSatisfied` để skip lan xuống các node phụ thuộc. */
    skipped(node: string, cause: SkipCause, results: ReadonlyMap<string, R>): R;
}

class HaltRun extends Error {
    constructor(readonly node: string) {
        super(`run halted after ${node}`);
    }
}

/**
 * Chạy từng đợt của graph: một node chỉ được đưa vào hàng đợi khi MỌI dependency của nó đạt `isSatisfied`.
 * Đưa danh sách đã sort topo vào `Promise.all` sẽ vẫn chạy phụ thuộc cùng lúc; chạy theo đợt thì không.
 * Giới hạn: đợt sau chỉ bắt đầu khi đợt trước xong hẳn, nên một node chậm trong đợt trước làm trễ cả những node
 * ở đợt sau không phụ thuộc vào nó.
 */
export async function runGraph<R>(options: RunGraphOptions<R>): Promise<Map<string, R>> {
    assertLimit(options.limit);

    const dependencies = normalize(options.graph);
    const results = new Map<string, R>();
    let halted: string | undefined;

    for (const wave of deployWaves(options.graph)) {
        const runnable: string[] = [];

        for (const node of wave) {
            const blocker = [...(dependencies.get(node) ?? [])].sort().find((dependency) => {
                const result = results.get(dependency);
                return result === undefined || !options.isSatisfied(result);
            });
            if (blocker !== undefined) {
                // Lý do cụ thể (phụ thuộc vào node nào) hữu ích hơn lý do chung "đã dừng", nên được ưu tiên.
                results.set(node, options.skipped(node, { kind: "dependency", node: blocker }, results));
            } else if (halted !== undefined) {
                results.set(node, options.skipped(node, { kind: "halted", node: halted }, results));
            } else {
                runnable.push(node);
            }
        }

        try {
            await runWithLimit(
                runnable.map((node) => async () => {
                    const result = await options.run(node);
                    // Ghi nhận trước khi throw: runWithLimit chỉ trả lỗi đầu tiên.
                    results.set(node, result);
                    if (options.failFast && !options.isSatisfied(result)) {
                        throw new HaltRun(node);
                    }
                    return result;
                }),
                options.limit,
            );
        } catch (error) {
            if (!(error instanceof HaltRun)) {
                throw error;
            }
            halted = error.node;
        }

        // Node trong đợt chưa kịp bắt đầu vì failFast.
        for (const node of runnable) {
            if (!results.has(node) && halted !== undefined) {
                results.set(node, options.skipped(node, { kind: "halted", node: halted }, results));
            }
        }
    }
    return results;
}
