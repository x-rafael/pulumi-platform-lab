import type { Deps } from "../lib/commands.ts";
import type { RunResult, Runner } from "../lib/exec.ts";

export const ORG = "x-rafael-org";
export const REPO = "x-rafael/pulumi-platform-lab";
export const NOW = new Date("2026-11-12T12:00:00.000Z");

export interface Call {
  file: string;
  args: string[];
  text: string;
}

export type Responder = (file: string, args: string[]) => Partial<RunResult> | undefined;

/** Runner giả: ghi lại mọi lệnh; responder đầu tiên trả giá trị khác undefined thì thắng; mặc định thành công, output rỗng. */
export function fakeRunner(...responders: Responder[]): { runner: Runner; calls: Call[]; has: (needle: string) => boolean } {
  const calls: Call[] = [];
  const runner: Runner = (file, args) => {
    const argv = [...args];
    calls.push({ file, args: argv, text: `${file} ${argv.join(" ")}` });
    for (const responder of responders) {
      const hit = responder(file, argv);
      if (hit !== undefined) return { status: 0, stdout: "", stderr: "", ...hit };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { runner, calls, has: (needle) => calls.some((c) => c.text.includes(needle)) };
}

export const on = (needle: string, result: Partial<RunResult>): Responder => (file, args) =>
  `${file} ${args.join(" ")}`.includes(needle) ? result : undefined;

export const prJson = (state: "open" | "closed", headRepo: string | null = REPO) =>
  JSON.stringify({ state, merged: false, head: { repo: headRepo === null ? null : { full_name: headRepo } } });

export const stackListJson = (names: string[]) =>
  JSON.stringify(names.map((name) => ({ name, url: `https://app.pulumi.com/${ORG}/platform-worker/${name}`, resourceCount: 11 })));

export const tagsJson = (tags: Record<string, string>) =>
  JSON.stringify({ "pulumi:project": "platform-worker", "vcs:owner": "x-rafael", ...tags });

export const goodTags = (pr: number, expiresAt: string, extra: Record<string, string> = {}) => ({
  Purpose: "pr-environment", ManagedBy: "Pulumi", Repository: REPO, PR: String(pr), ExpiresAt: expiresAt, ...extra,
});

/** AWS không còn resource nào (đúng các mã "không tồn tại" thật). */
export const awsAllAbsent: Responder[] = [
  on("aws lambda get-function", { status: 254, stderr: "An error occurred (ResourceNotFoundException) when calling the GetFunction operation" }),
  on("aws sqs get-queue-url", { status: 254, stderr: "An error occurred (AWS.SimpleQueueService.NonExistentQueue) when calling the GetQueueUrl operation" }),
  on("aws logs describe-log-groups", { status: 0, stdout: "[]" }),
  on("aws iam get-role", { status: 254, stderr: "An error occurred (NoSuchEntity) when calling the GetRole operation" }),
];

export function makeDeps(runner: Runner, overrides: Partial<Deps> = {}): Deps & { logs: string[]; summaries: string[] } {
  const logs: string[] = [];
  const summaries: string[] = [];
  return {
    runner,
    env: { org: ORG, repository: REPO, region: "ap-southeast-1" },
    workerDir: "/work/infra/worker",
    now: () => NOW,
    sleep: () => {},
    log: (line) => void logs.push(line),
    summary: (md) => void summaries.push(md),
    eventId: (pr) => `ci-test-${pr}`,
    ...overrides,
    logs,
    summaries,
  };
}
