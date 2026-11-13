// Phân loại kết quả preview. Hàm thuần, không import Pulumi: test được mà không cần SDK hay AWS.

/** Số lượng theo từng loại operation, ví dụ `{ same: 8, create: 3 }`. `OpMap` của SDK gán được vào kiểu này. */
export type ChangeSummary = Readonly<Record<string, number | undefined>>;

/**
 * Operations mà `--apply` chấp nhận. Mọi operation khác có count dương đều bị chặn, kể cả loại mà SDK thêm sau này:
 * danh sách cho phép (không phải danh sách cấm) nên operation mới không lọt qua một cách ngầm.
 *
 * Rơi ra ngoài danh sách này: delete, replace, create-replacement, delete-replaced, read-replacement,
 * discard, discard-replaced, remove-pending-replace, import, import-replacement.
 *
 * Giới hạn: `changeSummary` chỉ có số đếm, không biết resource nào. Nên policy không phân biệt được replace của
 * queue (mất message) với replace vô hại; nó chặn tất cả, và việc xoá/thay thế có chủ đích phải làm ngoài `--apply`.
 */
export const APPLY_ALLOWED_OPERATIONS: readonly string[] = ["same", "create", "update", "read", "refresh"];

/**
 * Gate chặt của `--check`: mọi operation khác `same` có count dương đều là thay đổi cần xem xét, sắp theo tên.
 *
 * Chặt hơn gate của `--apply` có chủ đích: `read` và `refresh` được apply chấp nhận nhưng check vẫn báo, vì check
 * trả lời "thế giới có đúng như code mô tả không", còn apply trả lời "có an toàn để chạy tiếp không". `read` không
 * nhất thiết là thay đổi AWS; nếu sau này cần cho qua (vd. StackReference ở chặng 3) thì thêm allowlist có giải
 * thích và tests sau khi quan sát summary thật, không cho qua ngầm.
 */
export function unexpectedOperations(summary: ChangeSummary): string[] {
    return Object.entries(summary)
        .filter(([operation, count]) => operation !== "same" && (count ?? 0) > 0)
        .map(([operation]) => operation)
        .sort();
}

/** Operations trong summary mà `--apply` không được tự chạy (count > 0), sắp theo tên để kết quả ổn định. */
export function blockedApplyOperations(summary: ChangeSummary): string[] {
    return Object.entries(summary)
        .filter(([operation, count]) => (count ?? 0) > 0 && !APPLY_ALLOWED_OPERATIONS.includes(operation))
        .map(([operation]) => operation)
        .sort();
}
