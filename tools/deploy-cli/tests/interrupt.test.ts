import { describe, expect, it } from "vitest";
import { EXIT } from "../src/config";
import { createInterruptHandler } from "../src/interrupt";

function setup() {
    const calls: string[] = [];
    const logs: string[] = [];
    const handler = createInterruptHandler({
        requestStop: () => calls.push("stop"),
        log: (line) => logs.push(line),
        exitNow: (code) => calls.push(`exit:${code}`),
    });
    return { handler, calls, logs };
}

describe("createInterruptHandler", () => {
    it("chưa có Ctrl-C nào: không làm gì", () => {
        const { calls, logs } = setup();
        expect(calls).toEqual([]);
        expect(logs).toEqual([]);
    });

    it("lần đầu: yêu cầu dừng nhẹ nhàng, KHÔNG thoát, và nói rõ không rollback", () => {
        const { handler, calls, logs } = setup();
        handler();

        expect(calls).toEqual(["stop"]);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain("starting nothing new");
        expect(logs[0]).toContain("nothing is rolled back");
    });

    it("lần hai: thoát ngay với 130 kèm cảnh báo về update có thể dang dở", () => {
        const { handler, calls, logs } = setup();
        handler();
        handler();

        expect(calls).toEqual(["stop", `exit:${EXIT.INTERRUPTED}`]);
        expect(EXIT.INTERRUPTED).toBe(130);
        expect(logs[1]).toContain("half applied");
        expect(logs[1]).toContain("pulumi stack history");
    });

    it("từ lần ba: bỏ qua, không dừng hay thoát lần nữa", () => {
        const { handler, calls } = setup();
        handler();
        handler();
        handler();
        handler();
        expect(calls).toEqual(["stop", "exit:130"]);
    });
});
