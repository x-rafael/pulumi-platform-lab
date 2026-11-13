import { describe, expect, it } from "vitest";
import { DOMAIN_DEPENDENCIES } from "../src/config";
import {
    CycleError,
    type DependencyGraph,
    type SkipCause,
    UnknownDependencyError,
    deployOrder,
    deployWaves,
    runGraph,
    runWithLimit,
} from "../src/scheduler";

// ---- helpers: promise điều khiển được, không dùng sleep ----

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Nhường vòng lặp sự kiện để mọi microtask đang chờ chạy hết. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Mọi dependency của mỗi node đứng trước node đó trong `order`, và `order` đủ mọi node. */
function isTopological(order: readonly string[], graph: DependencyGraph): boolean {
    const index = new Map(order.map((node, i) => [node, i]));
    return (
        order.length === Object.keys(graph).length &&
        Object.entries(graph).every(([node, deps]) =>
            deps.every((dep) => (index.get(dep) ?? Number.POSITIVE_INFINITY) < (index.get(node) ?? -1)),
        )
    );
}

describe("deployOrder / deployWaves", () => {
    it("graph rỗng", () => {
        expect(deployOrder({})).toEqual([]);
        expect(deployWaves({})).toEqual([]);
    });

    it("một node", () => {
        expect(deployOrder({ a: [] })).toEqual(["a"]);
    });

    it("hai node phụ thuộc: dependency đứng trước, dù key khai báo sau", () => {
        expect(deployOrder({ worker: ["config"], config: [] })).toEqual(["config", "worker"]);
    });

    it("nhánh độc lập nằm cùng đợt, sắp theo tên", () => {
        expect(deployWaves({ b: [], a: [], c: ["a"] })).toEqual([["a", "b"], ["c"]]);
        expect(deployOrder({ b: [], a: [], c: ["a"] })).toEqual(["a", "b", "c"]);
    });

    it("hình thoi: a → (b, c) → d", () => {
        expect(deployWaves({ d: ["b", "c"], b: ["a"], c: ["a"], a: [] })).toEqual([["a"], ["b", "c"], ["d"]]);
    });

    it("dependency trùng được gộp, không phải lỗi", () => {
        expect(deployOrder({ a: [], b: ["a", "a"] })).toEqual(["a", "b"]);
    });

    it("dependency không tồn tại: lỗi nêu rõ node và dependency, không bỏ qua", () => {
        const order = () => deployOrder({ worker: ["config"] });
        expect(order).toThrow(UnknownDependencyError);
        expect(order).toThrow(/"worker" depends on unknown node "config"/);
    });

    it("kết quả không phụ thuộc thứ tự khai báo key", () => {
        const entries: Array<[string, string[]]> = [
            ["a", []],
            ["b", ["a"]],
            ["c", ["a"]],
            ["d", ["b", "c"]],
        ];
        const reversed = Object.fromEntries([...entries].reverse());
        expect(deployOrder(reversed)).toEqual(deployOrder(Object.fromEntries(entries)));
    });

    describe("vòng phụ thuộc", () => {
        it("hai node: báo chuỗi khép kín", () => {
            const order = () => deployOrder({ a: ["b"], b: ["a"] });
            expect(order).toThrow(CycleError);
            expect(order).toThrow(/dependency cycle: a -> b -> a/);
        });

        it("tự phụ thuộc chính mình", () => {
            expect(() => deployOrder({ a: ["a"] })).toThrow(/dependency cycle: a -> a/);
        });

        it("vòng ba node", () => {
            try {
                deployOrder({ a: ["b"], b: ["c"], c: ["a"] });
                expect.unreachable("phải throw");
            } catch (error) {
                expect(error).toBeInstanceOf(CycleError);
                expect((error as CycleError).cycle).toEqual(["a", "b", "c", "a"]);
            }
        });

        it("node chỉ phụ thuộc vào vòng không bị đổ lỗi; thứ tự thiếu node không bao giờ được trả", () => {
            // z phụ thuộc a nhưng không nằm trong vòng; x độc lập và xếp được.
            const graph = { a: ["b"], b: ["a"], z: ["a"], x: [] };
            try {
                deployOrder(graph);
                expect.unreachable("phải throw");
            } catch (error) {
                expect((error as CycleError).cycle).toEqual(["a", "b", "a"]);
            }
        });
    });

    it("phản ví dụ: sắp theo SỐ dependency cho thứ tự sai, đi theo cạnh graph thì đúng", () => {
        const graph = { a: ["b"], b: ["c", "d"], c: [], d: [] };
        const naive = Object.keys(graph).sort((x, y) => (graph[x as keyof typeof graph]?.length ?? 0) - (graph[y as keyof typeof graph]?.length ?? 0));

        expect(naive).toEqual(["c", "d", "a", "b"]);
        expect(isTopological(naive, graph)).toBe(false); // a đứng trước b dù a cần b xong trước

        expect(deployOrder(graph)).toEqual(["c", "d", "b", "a"]);
        expect(isTopological(deployOrder(graph), graph)).toBe(true);
    });

    it("graph thật của CLI hợp lệ: không vòng, không node lạ, config trước worker", () => {
        const order = deployOrder(DOMAIN_DEPENDENCIES);
        expect(isTopological(order, DOMAIN_DEPENDENCIES)).toBe(true);
        expect(order.indexOf("config")).toBeLessThan(order.indexOf("worker"));
    });
});

describe("runWithLimit", () => {
    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
        "limit %s bị từ chối trước khi gọi bất kỳ task nào",
        async (limit) => {
            let called = 0;
            const task = async () => {
                called++;
            };
            await expect(runWithLimit([task, task], limit)).rejects.toThrow(RangeError);
            expect(called).toBe(0);
        },
    );

    it("không task: trả mảng rỗng", async () => {
        await expect(runWithLimit([], 3)).resolves.toEqual([]);
    });

    it("task chỉ được gọi khi có slot; số task đang chạy không vượt limit", async () => {
        const gates = [deferred(), deferred(), deferred(), deferred(), deferred()];
        let active = 0;
        let peak = 0;
        const started: number[] = [];
        const tasks = gates.map((gate, i) => async () => {
            started.push(i);
            active++;
            peak = Math.max(peak, active);
            await gate.promise;
            active--;
            return i;
        });

        const all = runWithLimit(tasks, 2);
        await flush();
        expect(started).toEqual([0, 1]); // task 2..4 chưa được gọi vì chưa có slot

        gates[0]?.resolve();
        await flush();
        expect(started).toEqual([0, 1, 2]);

        gates[1]?.resolve();
        gates[2]?.resolve();
        await flush();
        expect(started).toEqual([0, 1, 2, 3, 4]);

        gates[3]?.resolve();
        gates[4]?.resolve();
        await expect(all).resolves.toEqual([0, 1, 2, 3, 4]);
        expect(peak).toBe(2);
    });

    it("kết quả theo thứ tự đầu vào dù hoàn thành ngược thứ tự", async () => {
        const gates = [deferred(), deferred(), deferred()];
        const tasks = gates.map((gate, i) => async () => {
            await gate.promise;
            return `task-${i}`;
        });

        const all = runWithLimit(tasks, 3);
        await flush();
        gates[2]?.resolve();
        gates[1]?.resolve();
        gates[0]?.resolve();
        await expect(all).resolves.toEqual(["task-0", "task-1", "task-2"]);
    });

    it("limit lớn hơn số task vẫn chạy hết", async () => {
        await expect(runWithLimit([async () => 1, async () => 2], 10)).resolves.toEqual([1, 2]);
    });

    it("lỗi: không nhận task mới, và ĐỢI task đang chạy xong rồi mới reject", async () => {
        const slow = deferred();
        const failing = deferred();
        const started: string[] = [];
        let slowFinished = false;

        const tasks = [
            async () => {
                started.push("slow");
                await slow.promise;
                slowFinished = true;
                return "slow";
            },
            async () => {
                started.push("failing");
                await failing.promise;
                throw new Error("boom");
            },
            async () => {
                started.push("never");
                return "never";
            },
        ];

        let settled: "pending" | "rejected" | "resolved" = "pending";
        let error: unknown;
        const all = runWithLimit(tasks, 2).then(
            () => {
                settled = "resolved";
            },
            (e: unknown) => {
                settled = "rejected";
                error = e;
            },
        );

        await flush();
        failing.resolve(); // task thứ hai lỗi, task chậm vẫn đang chạy
        await flush();
        expect(settled).toBe("pending"); // chưa reject vì còn task đang chạy dở
        expect(started).toEqual(["slow", "failing"]); // task thứ ba KHÔNG được bắt đầu

        slow.resolve();
        await all;
        expect(settled).toBe("rejected");
        expect((error as Error).message).toBe("boom");
        expect(slowFinished).toBe(true); // công việc đã bắt đầu được chạy tới cùng
        expect(started).not.toContain("never");
    });

    it("task throw đồng bộ cũng được coi là lỗi, không để các lane còn lại treo", async () => {
        const started: number[] = [];
        const tasks = [
            () => {
                started.push(0);
                throw new Error("sync boom");
            },
            async () => {
                started.push(1);
                return 1;
            },
        ];
        await expect(runWithLimit(tasks, 1)).rejects.toThrow("sync boom");
        expect(started).toEqual([0]);
    });
});

describe("runGraph", () => {
    type Result = { node: string; ok: boolean; skipped?: SkipCause };

    function makeOptions(overrides: {
        graph: DependencyGraph;
        limit?: number;
        failFast?: boolean;
        run: (node: string) => Promise<Result>;
    }) {
        return {
            limit: 1,
            failFast: false,
            isSatisfied: (result: Result) => result.ok,
            skipped: (node: string, cause: SkipCause): Result => ({ node, ok: false, skipped: cause }),
            ...overrides,
        };
    }

    it("worker KHÔNG bắt đầu trước khi config xong, kể cả khi limit cho phép chạy song song", async () => {
        const configDone = deferred();
        const started: string[] = [];
        const finished: string[] = [];

        const running = runGraph(
            makeOptions({
                graph: { worker: ["config"], config: [] },
                limit: 8,
                run: async (node) => {
                    started.push(node);
                    if (node === "config") {
                        await configDone.promise;
                    }
                    finished.push(node);
                    return { node, ok: true };
                },
            }),
        );

        await flush();
        expect(started).toEqual(["config"]); // worker chưa được gọi dù còn slot
        configDone.resolve();
        const results = await running;

        expect(started).toEqual(["config", "worker"]);
        expect(finished).toEqual(["config", "worker"]);
        expect(results.get("worker")?.ok).toBe(true);
    });

    it("node độc lập cùng đợt: số node chạy cùng lúc không vượt limit", async () => {
        const nodes = ["a", "b", "c", "d"];
        const gates = new Map(nodes.map((n) => [n, deferred()]));
        let active = 0;
        let peak = 0;

        const running = runGraph(
            makeOptions({
                graph: Object.fromEntries(nodes.map((n) => [n, []])),
                limit: 2,
                run: async (node) => {
                    active++;
                    peak = Math.max(peak, active);
                    await gates.get(node)?.promise;
                    active--;
                    return { node, ok: true };
                },
            }),
        );

        await flush();
        expect(active).toBe(2);
        for (const node of nodes) {
            gates.get(node)?.resolve();
            await flush();
        }
        await running;
        expect(peak).toBe(2);
    });

    it("dependency không đạt: node phụ thuộc bị skip (kèm nguyên nhân) và skip lan xuống tiếp", async () => {
        const ran: string[] = [];
        const results = await runGraph(
            makeOptions({
                graph: { c: ["b"], b: ["a"], a: [] },
                run: async (node) => {
                    ran.push(node);
                    return { node, ok: false };
                },
            }),
        );

        expect(ran).toEqual(["a"]);
        expect(results.get("b")?.skipped).toEqual({ kind: "dependency", node: "a" });
        expect(results.get("c")?.skipped).toEqual({ kind: "dependency", node: "b" });
    });

    it("node không phụ thuộc vào node hỏng vẫn chạy khi failFast=false", async () => {
        const ran: string[] = [];
        const results = await runGraph(
            makeOptions({
                graph: { bad: [], child: ["bad"], independent: [] },
                failFast: false,
                run: async (node) => {
                    ran.push(node);
                    return { node, ok: node !== "bad" };
                },
            }),
        );

        expect(ran.sort()).toEqual(["bad", "independent"]);
        expect(results.get("independent")?.ok).toBe(true);
        expect(results.get("child")?.skipped).toEqual({ kind: "dependency", node: "bad" });
    });

    it("failFast: sau lỗi đầu tiên không bắt đầu node mới, nhưng node đang chạy vẫn được đợi và ghi nhận", async () => {
        const bad = deferred();
        const inFlight = deferred();
        const started: string[] = [];

        const running = runGraph(
            makeOptions({
                graph: { a: [], b: [], c: [], later: ["a"] },
                limit: 2,
                failFast: true,
                run: async (node) => {
                    started.push(node);
                    if (node === "a") {
                        await bad.promise;
                        return { node, ok: false };
                    }
                    await inFlight.promise;
                    return { node, ok: true };
                },
            }),
        );

        await flush();
        expect(started).toEqual(["a", "b"]);
        bad.resolve(); // a lỗi trong lúc b còn chạy
        await flush();
        inFlight.resolve();
        const results = await running;

        expect(started).toEqual(["a", "b"]); // c và later chưa bao giờ bắt đầu
        expect(results.get("b")?.ok).toBe(true); // b đang chạy: được đợi và ghi nhận
        expect(results.get("c")?.skipped).toEqual({ kind: "halted", node: "a" });
        // later phụ thuộc a (đã hỏng): lý do cụ thể "dependency" được ưu tiên hơn lý do chung "halted".
        expect(results.get("later")?.skipped).toEqual({ kind: "dependency", node: "a" });
    });

    it("run throw (lỗi lập trình) làm hỏng cả lượt thay vì bị nuốt", async () => {
        await expect(
            runGraph(
                makeOptions({
                    graph: { a: [] },
                    run: async () => {
                        throw new Error("bug");
                    },
                }),
            ),
        ).rejects.toThrow("bug");
    });

    it("limit không hợp lệ bị từ chối ngay cả khi không có node nào chạy", async () => {
        await expect(runGraph(makeOptions({ graph: {}, limit: 0, run: async (node) => ({ node, ok: true }) }))).rejects.toThrow(
            RangeError,
        );
    });

    it("graph có vòng: throw trước khi chạy bất kỳ node nào", async () => {
        let ran = 0;
        await expect(
            runGraph(
                makeOptions({
                    graph: { a: ["b"], b: ["a"] },
                    run: async (node) => {
                        ran++;
                        return { node, ok: true };
                    },
                }),
            ),
        ).rejects.toThrow(CycleError);
        expect(ran).toBe(0);
    });
});
