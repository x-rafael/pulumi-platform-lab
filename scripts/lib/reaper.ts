import { PURPOSE_TAG_VALUE, parseExpiresAt, prNumberFromStackName } from "./validate.ts";

/** Kết quả tra cứu PR trên GitHub. `not-found` và `lookup-failed` KHÔNG bao giờ đủ để xoá một mình. */
export type PrInfo =
  | { kind: "found"; state: "open" | "closed"; merged: boolean; headRepository: string | null }
  | { kind: "not-found" }
  | { kind: "lookup-failed"; detail: string };

export interface Decision {
  action: "clean" | "keep" | "exclude";
  reason: string;
  /** Có khi tag ExpiresAt hợp lệ. */
  expiresAt?: string;
}

export interface DecideInput {
  /** Tên ngắn của stack (`pr-12`, `dev`…). */
  stackName: string;
  /** Tag của stack trên Pulumi Cloud (nguồn sự thật cho reaper vì config nằm ở file local). */
  tags: Readonly<Record<string, string>>;
  repository: string;
  now: Date;
  /** Chỉ cần khi tên stack hợp lệ; `undefined` nghĩa là chưa tra cứu. */
  pr: PrInfo | undefined;
}

/**
 * Bảng quyết định duy nhất cho cả reaper lẫn `destroy` (cùng một logic, không có hai bản lệch nhau).
 *
 *  - exclude: KHÔNG thuộc phạm vi dọn (tên không phải pr-<n>, thiếu/sai metadata, TTL không hợp lệ). Không bao giờ xoá.
 *  - clean:   PR đã đóng, hoặc TTL đã hết hạn.
 *  - keep:    còn hạn và PR đang mở (hoặc không xác minh được PR nhưng TTL chưa hết).
 *
 * Quy tắc an toàn: không xoá dựa trên thông tin mơ hồ. Tra cứu GitHub lỗi/không thấy PR + TTL chưa hết → giữ.
 */
export function decideReap(input: DecideInput): Decision {
  const { stackName, tags, repository, now, pr } = input;

  const number = prNumberFromStackName(stackName);
  if (number === undefined) {
    return { action: "exclude", reason: `name "${stackName}" is not pr-<positive integer>` };
  }
  if (tags.Purpose !== PURPOSE_TAG_VALUE) {
    return { action: "exclude", reason: `tag Purpose is ${JSON.stringify(tags.Purpose)}, expected "${PURPOSE_TAG_VALUE}"` };
  }
  if (tags.ManagedBy !== "Pulumi") {
    return { action: "exclude", reason: `tag ManagedBy is ${JSON.stringify(tags.ManagedBy)}, expected "Pulumi"` };
  }
  if (tags.Repository !== repository) {
    return { action: "exclude", reason: `tag Repository is ${JSON.stringify(tags.Repository)}, expected "${repository}"` };
  }
  if (tags.PR !== String(number)) {
    return { action: "exclude", reason: `tag PR is ${JSON.stringify(tags.PR)}, expected "${number}" (from the stack name)` };
  }
  let expiresAt: string;
  try {
    expiresAt = parseExpiresAt(tags.ExpiresAt);
  } catch {
    return { action: "exclude", reason: `tag ExpiresAt ${JSON.stringify(tags.ExpiresAt)} is missing or not a valid UTC timestamp` };
  }

  const expired = now.getTime() >= new Date(expiresAt).getTime();
  const prClosed = pr?.kind === "found" && pr.state === "closed";

  if (prClosed) {
    return { action: "clean", reason: `PR #${number} is closed${expired ? " and the TTL has expired" : ""}`, expiresAt };
  }
  if (expired) {
    return { action: "clean", reason: `TTL expired at ${expiresAt}`, expiresAt };
  }
  if (pr === undefined || pr.kind === "lookup-failed") {
    const detail = pr?.kind === "lookup-failed" ? `: ${pr.detail}` : "";
    return { action: "keep", reason: `PR state could not be verified${detail}, and the TTL is valid until ${expiresAt}`, expiresAt };
  }
  if (pr.kind === "not-found") {
    return { action: "keep", reason: `PR #${number} was not found, and the TTL is valid until ${expiresAt}`, expiresAt };
  }
  return { action: "keep", reason: `PR #${number} is open and the TTL is valid until ${expiresAt}`, expiresAt };
}
