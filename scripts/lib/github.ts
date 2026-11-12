import { type Runner, runOrThrow } from "./exec.ts";
import type { PrInfo } from "./reaper.ts";

/** Phân tích JSON của `GET /repos/{repo}/pulls/{n}`. Thuần hàm. */
export function parsePrResponse(json: string): PrInfo {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { kind: "lookup-failed", detail: "unreadable response from GitHub" };
  }
  if (typeof data !== "object" || data === null) return { kind: "lookup-failed", detail: "unexpected response from GitHub" };
  const pr = data as { state?: unknown; merged?: unknown; head?: { repo?: { full_name?: unknown } | null } };
  if (pr.state !== "open" && pr.state !== "closed") return { kind: "lookup-failed", detail: `unexpected PR state ${JSON.stringify(pr.state)}` };
  const headRepo = pr.head?.repo?.full_name;
  return {
    kind: "found",
    state: pr.state,
    merged: pr.merged === true,
    headRepository: typeof headRepo === "string" ? headRepo : null,
  };
}

/** Tra cứu PR. 404 → not-found; mọi lỗi khác (mạng, quyền, rate limit) → lookup-failed. Không bao giờ ném. */
export function fetchPr(repository: string, pr: number, runner: Runner): PrInfo {
  const result = runner("gh", ["api", `repos/${repository}/pulls/${pr}`]);
  if (result.status === 0) return parsePrResponse(result.stdout);
  if (/HTTP 404|Not Found/i.test(result.stderr + result.stdout)) return { kind: "not-found" };
  return { kind: "lookup-failed", detail: `gh exited ${result.status}: ${result.stderr.trim().slice(0, 120)}` };
}

/** Giao việc dọn một PR cho workflow riêng, để nó chạy trong đúng concurrency group của PR đó. */
export function dispatchDestroy(repository: string, pr: number, runner: Runner): void {
  runOrThrow(runner, "gh", [
    "workflow", "run", "pr-env-destroy.yml", "--repo", repository, "--ref", "main", "-f", `pr=${pr}`,
  ]);
}
