import { expect, test } from "vitest";

// Cố ý sai để chứng minh ruleset `protect-main` chặn merge khi `unit` đỏ. PR chứa file này KHÔNG được merge.
test("deliberate failure (ruleset demo)", () => {
  expect(1 + 1).toBe(3);
});
