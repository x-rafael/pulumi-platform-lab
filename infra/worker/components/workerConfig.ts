import type * as pulumi from "@pulumi/pulumi";
import type { LambdaWorkerArgs } from "./LambdaWorker";
import { ENVIRONMENTS, type Environment } from "./validation";

export type { Environment };

/** Tên service dùng cho logical name, tag `Service` và (cùng với stack) tên vật lý. */
export const SERVICE_NAME = "platform-worker";

/**
 * Stack cố định ↔ đúng một environment. Dùng Map (không dùng object literal) để tên như
 * `constructor` hay `__proto__` không "khớp" nhờ prototype. Không đoán bằng `includes("prod")`.
 */
const ENVIRONMENT_BY_STACK: ReadonlyMap<string, Environment> = new Map<string, Environment>([
  ["dev", "dev"],
  ["test", "test"],
  ["prod", "prod"],
]);

/** `pr-<số nguyên dương>`, không số 0 đứng đầu, tối đa 9 chữ số (luôn là số nguyên an toàn). */
const PR_STACK_PATTERN = /^pr-([1-9][0-9]{0,8})$/;
const PR_NUMBER_PATTERN = /^[1-9][0-9]{0,8}$/;
/** ISO-8601 UTC bắt buộc có `Z`; không nhận offset, không nhận giờ local. */
const EXPIRES_AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** Environment mà mọi PR stack dùng. */
export const PR_STACK_ENVIRONMENT: Environment = "dev";

export interface StackIdentity {
  environment: Environment;
  /** Chỉ có với stack `pr-<n>`. */
  prNumber: number | undefined;
}

/** Union `dev | test | prod`: giá trị ngoài danh sách bị từ chối, không đoán. */
export function parseEnvironment(value: string | undefined): Environment {
  const found = ENVIRONMENTS.find((e) => e === value);
  if (found !== undefined) return found;
  throw new Error(
    `Invalid config "environment": ${JSON.stringify(value)} (must be "dev", "test" or "prod"; set with: pulumi config set environment dev)`,
  );
}

/** Stack → environment (và số PR nếu là `pr-<n>`); stack lạ bị từ chối. */
export function resolveStack(stack: string): StackIdentity {
  const fixed = ENVIRONMENT_BY_STACK.get(stack);
  if (fixed !== undefined) return { environment: fixed, prNumber: undefined };

  const pr = PR_STACK_PATTERN.exec(stack);
  if (pr !== null) return { environment: PR_STACK_ENVIRONMENT, prNumber: Number(pr[1]) };

  throw new Error(
    `Unknown stack "${stack}": expected one of ${[...ENVIRONMENT_BY_STACK.keys()].join(", ")}, or pr-<positive integer>`,
  );
}

export function assertStackMatchesEnvironment(stack: string, environment: Environment): void {
  const { environment: expected } = resolveStack(stack);
  if (expected !== environment) {
    throw new Error(`Stack "${stack}" must use environment "${expected}", got "${environment}"`);
  }
}

/**
 * Đọc số PR dạng chuỗi rồi kiểm tra bằng regex: `Config.getNumber` dùng parseFloat nên
 * "12abc" hay "1e2" vẫn lọt qua.
 */
export function parsePrNumber(value: string | undefined): number {
  if (value === undefined || !PR_NUMBER_PATTERN.test(value)) {
    throw new Error(
      `Invalid config "prNumber": ${JSON.stringify(value)} (must be a positive integer without leading zeros, up to 9 digits)`,
    );
  }
  return Number(value);
}

/**
 * Thời điểm hết hạn của PR stack: ISO-8601 UTC có `Z`. Trả về dạng chuẩn hoá
 * (`toISOString()`) để tag và reaper đọc cùng một định dạng. Quá khứ vẫn hợp lệ:
 * stack hết hạn có chủ đích là cách kiểm chứng reaper.
 */
export function parseExpiresAt(value: string | undefined): string {
  const m = value === undefined ? null : EXPIRES_AT_PATTERN.exec(value);
  if (m === null) {
    throw new Error(
      `Invalid config "expiresAt": ${JSON.stringify(value)} (must be ISO-8601 UTC ending in "Z", e.g. 2026-11-13T10:00:00Z)`,
    );
  }
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const millis = m[7] === undefined ? 0 : Number(m[7].padEnd(3, "0"));
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis));
  // Date.UTC tự "cuộn" giá trị ngoài miền (31/02, 24:00, giây 60); so lại từng thành phần để bắt.
  const roundTrips =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second;
  if (!roundTrips) {
    throw new Error(`Invalid config "expiresAt": ${JSON.stringify(value)} (not a real calendar date/time)`);
  }
  return date.toISOString();
}

/** `OWNER/REPO` của GitHub; chỉ dùng làm tag để reaper biết stack thuộc repo nào. */
export function parseRepository(value: string): string {
  if (!REPOSITORY_PATTERN.test(value)) {
    throw new Error(`Invalid config "repository": ${JSON.stringify(value)} (must look like OWNER/REPO)`);
  }
  return value;
}

/**
 * Metadata của PR stack. Stack thường (`dev`, `test`, `prod`) không được mang các key này,
 * để một stack cố định không bao giờ trông giống stack PR đối với reaper.
 */
function loadPrTags(config: pulumi.Config, stack: string, stackPrNumber: number | undefined): Record<string, string> {
  const rawPr = config.get("prNumber");
  const rawExpires = config.get("expiresAt");
  const rawRepository = config.get("repository");

  if (stackPrNumber === undefined) {
    const present = [
      ["prNumber", rawPr],
      ["expiresAt", rawExpires],
      ["repository", rawRepository],
    ]
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    if (present.length > 0) {
      throw new Error(
        `Config ${present.map((k) => `"${k}"`).join(", ")} is only allowed on pr-<number> stacks, not on stack "${stack}"`,
      );
    }
    return {};
  }

  const prNumber = parsePrNumber(rawPr);
  if (prNumber !== stackPrNumber) {
    throw new Error(`Config "prNumber" (${prNumber}) does not match stack "${stack}"`);
  }
  const tags: Record<string, string> = {
    Purpose: "pr-environment",
    PR: String(prNumber),
    ExpiresAt: parseExpiresAt(rawExpires),
  };
  if (rawRepository !== undefined) tags.Repository = parseRepository(rawRepository);
  return tags;
}

/**
 * Đọc config của caller. Tham số số dùng `getNumber`; khi không đặt thì để `undefined`
 * để component áp dụng default rồi validate (một nơi duy nhất giữ default).
 */
export function loadWorkerArgs(config: pulumi.Config, stack: string): LambdaWorkerArgs {
  const environment = parseEnvironment(config.get("environment"));
  assertStackMatchesEnvironment(stack, environment);
  const { prNumber } = resolveStack(stack);
  return {
    stack,
    environment,
    tags: {
      Service: SERVICE_NAME,
      Environment: environment,
      ManagedBy: "Pulumi",
      ...loadPrTags(config, stack, prNumber),
    },
    timeoutSeconds: config.getNumber("timeoutSeconds"),
    memorySizeMiB: config.getNumber("memorySizeMiB"),
    visibilityTimeoutSeconds: config.getNumber("visibilityTimeoutSeconds"),
    maxReceiveCount: config.getNumber("maxReceiveCount"),
    messageRetentionSeconds: config.getNumber("messageRetentionSeconds"),
  };
}
