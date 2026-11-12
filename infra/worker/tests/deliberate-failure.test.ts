import { expect, test } from "vitest";

// Cố ý sai để chứng minh một test lỗi làm check `unit` đỏ và job `preview` không được chạy
// (không cấp credentials cho code chưa qua test). PR chứa file này KHÔNG được merge.
test("deliberate failure (Chặng 2 demo)", () => {
  expect(1 + 1).toBe(3);
});
