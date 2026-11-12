/**
 * Validate và dựng tên cho vòng đời PR environment. Thuần hàm: không chạy lệnh nào.
 *
 * Mọi giá trị vào từ ngoài (số PR, org, repo, thời điểm) đều được kiểm tra ở đây trước khi dùng. Tên stack KHÔNG bao giờ
 * nhận từ PR: nó luôn được dựng từ allowlist org + project cố định + `pr-<số nguyên dương>`.
 */

/** Allowlist: chỉ org và repo này được phép. Đổi org/repo thì phải sửa ở đây có chủ đích. */
export const ORG_ALLOWLIST: readonly string[] = ["x-rafael-org"];
export const REPOSITORY_ALLOWLIST: readonly string[] = ["x-rafael/pulumi-platform-lab"];
export const PROJECT = "platform-worker";
/** Tiền tố tên vật lý của worker (infra/worker: SERVICE_NAME). Mẫu tên phải khớp LambdaWorker. */
export const SERVICE_PREFIX = "platform-worker";
export const TTL_HOURS = 24;
export const PURPOSE_TAG_VALUE = "pr-environment";

const PR_NUMBER_PATTERN = /^[1-9][0-9]{0,8}$/;
const STACK_NAME_PATTERN = /^pr-([1-9][0-9]{0,8})$/;
/** ISO-8601 UTC bắt buộc có `Z`; không nhận offset, không nhận giờ local. */
const EXPIRES_AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-[0-9]$/;

export function parsePrNumber(value: string | undefined): number {
  if (value === undefined || !PR_NUMBER_PATTERN.test(value)) {
    throw new Error(
      `Invalid PR number: ${JSON.stringify(value)} (must be a positive integer without leading zeros, up to 9 digits)`,
    );
  }
  return Number(value);
}

/** Trả về dạng chuẩn hoá (`toISOString()`), để tag và config cùng một định dạng. Quá khứ vẫn hợp lệ. */
export function parseExpiresAt(value: string | undefined): string {
  const m = value === undefined ? null : EXPIRES_AT_PATTERN.exec(value);
  if (m === null) {
    throw new Error(`Invalid expiresAt: ${JSON.stringify(value)} (must be ISO-8601 UTC ending in "Z")`);
  }
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [
    number, number, number, number, number, number,
  ];
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
    throw new Error(`Invalid expiresAt: ${JSON.stringify(value)} (not a real calendar date/time)`);
  }
  return date.toISOString();
}

/** Tính trong script (không dùng `date -d`, khác nhau giữa macOS và runner Linux). Luôn UTC. */
export function computeExpiresAt(now: Date, hours: number = TTL_HOURS): string {
  return new Date(now.getTime() + hours * 3_600_000).toISOString();
}

export function prStackName(pr: number): string {
  return `pr-${pr}`;
}

/** `pr-12` → 12; mọi tên khác (`dev`, `prod`, `pr-012`, `PR-12`, `constructor`…) → undefined. */
export function prNumberFromStackName(name: string): number | undefined {
  const m = STACK_NAME_PATTERN.exec(name);
  return m === null ? undefined : Number(m[1]);
}

function requireAllowed(kind: string, value: string | undefined, allowlist: readonly string[]): string {
  if (value === undefined || !allowlist.includes(value)) {
    throw new Error(`${kind} ${JSON.stringify(value)} is not in the allowlist (${allowlist.join(", ")})`);
  }
  return value;
}

export const requireOrg = (value: string | undefined): string => requireAllowed("Pulumi org", value, ORG_ALLOWLIST);
export const requireRepository = (value: string | undefined): string =>
  requireAllowed("Repository", value, REPOSITORY_ALLOWLIST);

export function requireRegion(value: string | undefined): string {
  if (value === undefined || !REGION_PATTERN.test(value)) {
    throw new Error(`Invalid AWS region: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Tên stack đầy đủ `org/project/pr-<n>`, dựng từ allowlist; không nhận chuỗi tuỳ ý. */
export function fullStackName(org: string, pr: number): string {
  return `${requireOrg(org)}/${PROJECT}/${prStackName(pr)}`;
}

/** Tên stack mà script biết kiểm tra: `dev`, `prod` hoặc `pr-<n>`. Mọi tên khác bị từ chối. */
export function parseKnownStackName(name: string | undefined): string {
  if (name === "dev" || name === "prod" || (name !== undefined && prNumberFromStackName(name) !== undefined)) return name;
  throw new Error(`Unknown stack ${JSON.stringify(name)}: expected dev, prod or pr-<positive integer>`);
}

/** Tên stack đầy đủ cho dev/prod/pr-<n> (đã qua allowlist org). */
export function fullStackNameFor(org: string, stack: string): string {
  return `${requireOrg(org)}/${PROJECT}/${parseKnownStackName(stack)}`;
}

/** Tên vật lý mà worker tạo cho một stack (xem infra/worker/components/LambdaWorker.ts). */
export function physicalNamesForStack(stack: string) {
  const base = `${SERVICE_PREFIX}-${parseKnownStackName(stack)}`;
  return {
    functionName: base,
    sourceQueue: `${base}-queue`,
    dlq: `${base}-dlq`,
    logGroup: `/aws/lambda/${base}`,
    role: `${base}-role`,
  };
}

/** Tên vật lý mà worker tạo cho một PR stack. */
export const physicalNames = (pr: number) => physicalNamesForStack(prStackName(pr));
