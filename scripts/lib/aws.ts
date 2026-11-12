import { type Runner, type RunResult, runOrThrow } from "./exec.ts";
import { physicalNamesForStack, prStackName } from "./validate.ts";

export type ResourceKind = "lambda" | "sqs" | "logs" | "iam";
export type Presence = "present" | "absent";

/**
 * Chỉ MÃ LỖI "không tồn tại" thật mới tính là đã xoá. Mọi lỗi khác (AccessDenied, throttling, mạng…) ném ra:
 * nếu coi mọi lỗi là "không còn" thì thiếu quyền đọc sẽ bị báo nhầm là dọn sạch (cùng kiểu "pass giả" với ca âm của STS).
 */
const NOT_FOUND_MARKERS: Record<Exclude<ResourceKind, "logs">, readonly string[]> = {
  lambda: ["ResourceNotFoundException"],
  sqs: ["AWS.SimpleQueueService.NonExistentQueue", "QueueDoesNotExist"],
  iam: ["NoSuchEntity"],
};

export function classifyLookup(kind: ResourceKind, name: string, result: RunResult): Presence {
  if (kind === "logs") {
    if (result.status !== 0) {
      throw new Error(`Cannot determine whether log group ${name} exists (exit ${result.status}): ${result.stderr.trim().slice(0, 200)}`);
    }
    let matches: unknown;
    try {
      matches = JSON.parse(result.stdout);
    } catch {
      throw new Error(`Unreadable describe-log-groups output for ${name}`);
    }
    if (!Array.isArray(matches)) throw new Error(`Unexpected describe-log-groups output for ${name}`);
    return matches.length === 0 ? "absent" : "present";
  }
  if (result.status === 0) return "present";
  if (NOT_FOUND_MARKERS[kind].some((marker) => result.stderr.includes(marker))) return "absent";
  throw new Error(`Cannot determine whether ${kind} ${name} exists (exit ${result.status}): ${result.stderr.trim().slice(0, 200)}`);
}

interface Lookup {
  kind: ResourceKind;
  name: string;
  args: string[];
}

export function lookupsFor(stack: string): Lookup[] {
  const n = physicalNamesForStack(stack);
  return [
    { kind: "lambda", name: n.functionName, args: ["lambda", "get-function", "--function-name", n.functionName] },
    { kind: "sqs", name: n.sourceQueue, args: ["sqs", "get-queue-url", "--queue-name", n.sourceQueue] },
    { kind: "sqs", name: n.dlq, args: ["sqs", "get-queue-url", "--queue-name", n.dlq] },
    {
      kind: "logs",
      name: n.logGroup,
      args: [
        "logs", "describe-log-groups", "--log-group-name-prefix", n.logGroup,
        "--query", `logGroups[?logGroupName=='${n.logGroup}'].logGroupName`, "--output", "json",
      ],
    },
    { kind: "iam", name: n.role, args: ["iam", "get-role", "--role-name", n.role] },
  ];
}

export interface PresenceReport {
  kind: ResourceKind;
  name: string;
  presence: Presence;
}

/** Hỏi AWS (bằng role của CI) xem 5 resource của một stack còn không. Ném nếu có lỗi không phân loại được. */
export function checkStackResources(stack: string, runner: Runner): PresenceReport[] {
  return lookupsFor(stack).map(({ kind, name, args }) => {
    const result = runner("aws", [...args, "--no-cli-pager"], { env: { AWS_PAGER: "" } });
    return { kind, name, presence: classifyLookup(kind, name, result) };
  });
}

/** Như `checkStackResources` cho stack PR `pr-<n>`. */
export const checkPrResources = (pr: number, runner: Runner): PresenceReport[] =>
  checkStackResources(prStackName(pr), runner);

/** Dòng log của handler: {"status":"processed","eventId":"...","messageId":"..."} */
export function isProcessed(logText: string, eventId: string): boolean {
  return logText.includes('"status":"processed"') && logText.includes(eventId);
}

export interface SmokeDeps {
  runner: Runner;
  sleep: (ms: number) => void;
  nowMs: () => number;
  attempts?: number;
  intervalMs?: number;
}

/**
 * Smoke test: gửi message hợp lệ với eventId duy nhất vào source queue, đợi dòng log "processed" của đúng eventId.
 * --start-time chặn dòng log cũ làm test qua nhầm. Không in URL của queue (chứa account ID).
 */
export function smokeTest(pr: number, eventId: string, deps: SmokeDeps): number {
  const { runner, sleep, nowMs, attempts = 24, intervalMs = 5000 } = deps;
  const n = physicalNamesForStack(prStackName(pr));
  const queueUrl = runOrThrow(runner, "aws", [
    "sqs", "get-queue-url", "--queue-name", n.sourceQueue, "--query", "QueueUrl", "--output", "text",
  ]).stdout.trim();
  const startMs = nowMs();
  runOrThrow(runner, "aws", [
    "sqs", "send-message", "--queue-url", queueUrl,
    "--message-body", JSON.stringify({ eventId, action: "process", forceFail: false }),
    "--query", "MessageId", "--output", "text",
  ]);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const out = runner("aws", [
      "logs", "filter-log-events", "--log-group-name", n.logGroup, "--start-time", String(startMs),
      "--filter-pattern", `"${eventId}"`, "--query", "events[].message", "--output", "text",
    ]);
    if (out.status === 0 && isProcessed(out.stdout, eventId)) return attempt;
    sleep(intervalMs);
  }
  throw new Error(`eventId=${eventId} not seen as processed within ${(attempts * intervalMs) / 1000}s`);
}
