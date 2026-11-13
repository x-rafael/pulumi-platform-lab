import { describe, expect, it } from "vitest";
import { blockedApplyOperations, unexpectedOperations } from "../src/changes";

describe("unexpectedOperations (gate của --check)", () => {
    it("chỉ same: sạch", () => {
        expect(unexpectedOperations({ same: 11 })).toEqual([]);
    });

    it("summary rỗng: sạch", () => {
        expect(unexpectedOperations({})).toEqual([]);
    });

    it.each([
        "create",
        "update",
        "delete",
        "replace",
        "create-replacement",
        "delete-replaced",
        "import",
        "import-replacement",
        "read",
        "read-replacement",
        "refresh",
        "discard",
        "discard-replaced",
        "remove-pending-replace",
        "some-future-op",
    ])("%s đứng riêng bên cạnh same bị báo", (operation) => {
        expect(unexpectedOperations({ same: 8, [operation]: 1 })).toEqual([operation]);
    });

    it("count 0 hoặc undefined không tạo false positive", () => {
        expect(unexpectedOperations({ same: 8, update: 0, delete: undefined })).toEqual([]);
    });

    it("trả mọi operation, theo thứ tự tên ổn định", () => {
        expect(unexpectedOperations({ update: 2, create: 1, same: 5, delete: 1 })).toEqual(["create", "delete", "update"]);
    });

    it("chặt hơn gate của apply có chủ đích: read/refresh/update bị check báo nhưng apply cho qua", () => {
        const summary = { same: 8, read: 1, refresh: 1, update: 1 };
        expect(unexpectedOperations(summary)).toEqual(["read", "refresh", "update"]);
        expect(blockedApplyOperations(summary)).toEqual([]);
    });
});

describe("blockedApplyOperations", () => {
    it("summary chỉ có operations được phép thì không chặn gì", () => {
        expect(blockedApplyOperations({ same: 8, create: 3, update: 2, read: 1, refresh: 1 })).toEqual([]);
    });

    it("summary rỗng không chặn", () => {
        expect(blockedApplyOperations({})).toEqual([]);
    });

    // Mỗi operation nguy hiểm được thử riêng: không chỉ `delete`, mà cả các bước của replace.
    it.each([
        "delete",
        "replace",
        "create-replacement",
        "delete-replaced",
        "read-replacement",
        "discard",
        "discard-replaced",
        "remove-pending-replace",
        "import",
        "import-replacement",
    ])("chặn %s khi có cùng với operations hợp lệ", (operation) => {
        expect(blockedApplyOperations({ same: 8, create: 1, [operation]: 1 })).toEqual([operation]);
    });

    it("count 0 hoặc undefined không tạo false positive", () => {
        expect(blockedApplyOperations({ same: 8, delete: 0, replace: undefined })).toEqual([]);
    });

    it("operation lạ chưa từng thấy bị chặn mặc định (danh sách cho phép, không phải danh sách cấm)", () => {
        expect(blockedApplyOperations({ same: 1, "some-future-op": 2 })).toEqual(["some-future-op"]);
    });

    it("trả mọi operation bị chặn, theo thứ tự tên ổn định", () => {
        expect(blockedApplyOperations({ replace: 1, "delete-replaced": 1, delete: 2, create: 5 })).toEqual([
            "delete",
            "delete-replaced",
            "replace",
        ]);
    });
});
