import { type Runner, runOrThrow } from "./exec.ts";
import { PROJECT } from "./validate.ts";

export interface StackEntry {
  /** Tên ngắn, đã bỏ phần org/project nếu CLI in ra dạng đầy đủ. */
  name: string;
  url?: string;
  resourceCount?: number;
}

/** Phân tích output của `pulumi stack ls --json`. Thuần hàm. */
export function parseStackList(json: string): StackEntry[] {
  const data: unknown = JSON.parse(json);
  if (!Array.isArray(data)) throw new Error("Unexpected `pulumi stack ls --json` output");
  return data.map((raw: unknown) => {
    const e = raw as { name?: unknown; url?: unknown; resourceCount?: unknown };
    if (typeof e.name !== "string") throw new Error("Stack entry without a name");
    return {
      name: e.name.split("/").pop() as string,
      url: typeof e.url === "string" ? e.url : undefined,
      resourceCount: typeof e.resourceCount === "number" ? e.resourceCount : undefined,
    };
  });
}

/** Tag tuỳ chỉnh của stack; bỏ các tag hệ thống `pulumi:*` và `vcs:*` (reaper không đọc chúng). */
export function parseStackTags(json: string): Record<string, string> {
  const data: unknown = JSON.parse(json);
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("Unexpected stack tag output");
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith("pulumi:") || key.startsWith("vcs:")) continue;
    if (typeof value === "string") tags[key] = value;
  }
  return tags;
}

/** Số resource trong `pulumi stack export` (không tính gì khác). */
export function countResources(exportJson: string): number {
  const data = JSON.parse(exportJson) as { deployment?: { resources?: unknown } };
  const resources = data.deployment?.resources;
  if (resources === undefined) return 0;
  if (!Array.isArray(resources)) throw new Error("Unexpected stack export output");
  return resources.length;
}

export interface PulumiContext {
  runner: Runner;
  /** Thư mục project Pulumi (infra/worker). */
  cwd: string;
  org: string;
}

const NON_INTERACTIVE = ["--non-interactive"] as const;

function pulumi(ctx: PulumiContext, args: readonly string[], stream = false) {
  return runOrThrow(ctx.runner, "pulumi", [...args, ...NON_INTERACTIVE], {
    cwd: ctx.cwd,
    env: { PULUMI_SKIP_UPDATE_CHECK: "true" },
    stream,
  });
}

/**
 * Liệt kê stack của đúng org và project (không dựa vào cwd). Thất bại ở bước này phải dừng cả luồng:
 * lỗi xác thực/backend KHÔNG có nghĩa là "stack chưa tồn tại", nên không được rơi sang `stack init`.
 */
export function listStacks(ctx: PulumiContext): StackEntry[] {
  const out = pulumi(ctx, ["stack", "ls", "--json", "--organization", ctx.org, "--project", PROJECT]);
  return parseStackList(out.stdout);
}

/** Stack có tồn tại không; nếu CLI trả URL thì URL cũng phải đúng org/project/stack. */
export function stackExists(stacks: readonly StackEntry[], ctx: PulumiContext, shortName: string): boolean {
  const entry = stacks.find((s) => s.name === shortName);
  if (entry === undefined) return false;
  if (entry.url !== undefined && !entry.url.endsWith(`/${ctx.org}/${PROJECT}/${shortName}`)) {
    throw new Error(`Stack ${shortName} has an unexpected URL (not ${ctx.org}/${PROJECT}): refusing to continue`);
  }
  return true;
}

export const readTags = (ctx: PulumiContext, full: string) =>
  parseStackTags(pulumi(ctx, ["stack", "tag", "ls", "--stack", full, "--json"]).stdout);
export const setTag = (ctx: PulumiContext, full: string, name: string, value: string) =>
  void pulumi(ctx, ["stack", "tag", "set", name, value, "--stack", full]);
export const setConfig = (ctx: PulumiContext, full: string, key: string, value: string) =>
  void pulumi(ctx, ["config", "set", key, value, "--stack", full]);
export const initStack = (ctx: PulumiContext, full: string) => void pulumi(ctx, ["stack", "init", full]);
export const selectStack = (ctx: PulumiContext, full: string) => void pulumi(ctx, ["stack", "select", full]);
export const previewStack = (ctx: PulumiContext, full: string) =>
  void pulumi(ctx, ["preview", "--stack", full, "--diff", "--refresh"], true);
export const upStack = (ctx: PulumiContext, full: string) =>
  void pulumi(ctx, ["up", "--stack", full, "--yes", "--refresh", "--skip-preview"], true);
/**
 * KHÔNG dùng --force: nếu còn resource sót thì phải để lỗi nổi lên, không che đi.
 * `--refresh` làm cho lần thử lại idempotent: nếu lần trước AWS đã xoá một resource nhưng Pulumi chưa kịp ghi nhận
 * (vd. event source mapping), refresh đọc lại thực tế và bỏ nó khỏi state, thay vì gọi Delete lên thứ không còn tồn tại
 * (IAM đánh giá lời gọi đó với Resource "*", nên sẽ AccessDenied; xem docs/ci-access.md). Không cần nới quyền xoá.
 */
export const destroyStack = (ctx: PulumiContext, full: string) =>
  void pulumi(ctx, ["destroy", "--stack", full, "--yes", "--refresh"], true);
export const exportResourceCount = (ctx: PulumiContext, full: string) =>
  countResources(pulumi(ctx, ["stack", "export", "--stack", full]).stdout);
export const removeStack = (ctx: PulumiContext, full: string) => void pulumi(ctx, ["stack", "rm", full, "--yes"]);
