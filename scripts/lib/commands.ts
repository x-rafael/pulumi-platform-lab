import { checkPrResources, smokeTest } from "./aws.ts";
import type { Runner } from "./exec.ts";
import { dispatchDestroy, fetchPr } from "./github.ts";
import {
  type PulumiContext, destroyStack, exportResourceCount, initStack, listStacks, previewStack, readTags,
  removeStack, selectStack, setConfig, setTag, stackExists, upStack,
} from "./pulumi.ts";
import { type Decision, decideReap } from "./reaper.ts";
import {
  PROJECT, PURPOSE_TAG_VALUE, computeExpiresAt, fullStackName, parseExpiresAt, physicalNames, prNumberFromStackName,
  prStackName,
} from "./validate.ts";

export interface Env {
  org: string;
  repository: string;
  region: string;
}

export interface Deps {
  runner: Runner;
  env: Env;
  /** Thư mục project Pulumi (infra/worker). */
  workerDir: string;
  now: () => Date;
  sleep: (ms: number) => void;
  log: (line: string) => void;
  /** Ghi markdown vào job summary (chỉ tên và thời hạn; KHÔNG ghi ARN/URL vì chúng chứa account ID). */
  summary: (markdown: string) => void;
  /** eventId cho smoke test (duy nhất theo run). */
  eventId: (pr: number) => string;
}

const ctxOf = (deps: Deps): PulumiContext => ({ runner: deps.runner, cwd: deps.workerDir, org: deps.env.org });

function tryParseExpiresAt(value: string | undefined): string | undefined {
  try {
    return parseExpiresAt(value);
  } catch {
    return undefined;
  }
}

/** Tạo hoặc cập nhật đúng một stack `pr-<n>` cho PR đang mở, rồi smoke test. */
export function up(deps: Deps, pr: number, expiresAtOverride?: string): number {
  const { env, log } = deps;
  const ctx = ctxOf(deps);
  const short = prStackName(pr);
  const full = fullStackName(env.org, pr);

  // 1. PR phải còn mở và nằm trong repo này. Không xác minh được thì không deploy (không cấp credentials khi mơ hồ).
  const info = fetchPr(env.repository, pr, deps.runner);
  if (info.kind !== "found") {
    log(`ERROR: cannot verify PR #${pr} (${info.kind}); refusing to deploy`);
    return 1;
  }
  if (info.headRepository !== env.repository) {
    log(`ERROR: PR #${pr} head is not in ${env.repository} (fork or deleted repository); no credentials for unreviewed forks`);
    return 1;
  }
  if (info.state !== "open") {
    log(`SKIP: PR #${pr} is ${info.state}; nothing to deploy`);
    deps.summary(`### PR environment ${short}\nSkipped: PR #${pr} is ${info.state}.\n`);
    return 0;
  }

  // 2. Stack đã có chưa? `stack ls` lỗi thì ném: lỗi xác thực/backend KHÔNG có nghĩa là "chưa có stack", không được rơi sang init.
  const exists = stackExists(listStacks(ctx), ctx, short);
  let existingTags: Record<string, string> = {};
  if (exists) {
    selectStack(ctx, full);
    existingTags = readTags(ctx, full);
    const foreign =
      (existingTags.Repository !== undefined && existingTags.Repository !== env.repository) ||
      (existingTags.Purpose !== undefined && existingTags.Purpose !== PURPOSE_TAG_VALUE);
    if (foreign) {
      log(`ERROR: stack ${short} exists but its tags say it belongs to something else; refusing to touch it`);
      return 1;
    }
    log(`Stack ${short} exists: updating`);
  } else {
    initStack(ctx, full);
    log(`Stack ${short} did not exist: created`);
  }

  // 3. TTL tính từ lúc tạo: push thêm commit KHÔNG kéo dài. Stack đã có hạn hợp lệ thì giữ nguyên.
  const kept = tryParseExpiresAt(existingTags.ExpiresAt);
  const expiresAt = kept ?? (expiresAtOverride !== undefined ? parseExpiresAt(expiresAtOverride) : computeExpiresAt(deps.now()));
  log(kept !== undefined ? `Keeping existing ExpiresAt ${expiresAt}` : `ExpiresAt ${expiresAt}`);

  // 4. Metadata: tag của stack nằm trên Pulumi Cloud (nguồn cho reaper); config nằm ở file local nên phải dựng lại MỖI lần.
  const tags: Record<string, string> = {
    Purpose: PURPOSE_TAG_VALUE, ManagedBy: "Pulumi", Repository: env.repository, PR: String(pr), ExpiresAt: expiresAt,
  };
  for (const [name, value] of Object.entries(tags)) setTag(ctx, full, name, value);
  setConfig(ctx, full, "aws:region", env.region);
  setConfig(ctx, full, "environment", "dev");
  setConfig(ctx, full, "prNumber", String(pr));
  setConfig(ctx, full, "expiresAt", expiresAt);
  setConfig(ctx, full, "repository", env.repository);

  // 5. preview, up, smoke test.
  previewStack(ctx, full);
  upStack(ctx, full);
  const eventId = deps.eventId(pr);
  const poll = smokeTest(pr, eventId, { runner: deps.runner, sleep: deps.sleep, nowMs: () => deps.now().getTime() });
  log(`OK: eventId=${eventId} processed (poll ${poll})`);

  const names = physicalNames(pr);
  deps.summary(
    `### PR environment \`${short}\` ${exists ? "updated" : "created"}\n` +
      `| | |\n| --- | --- |\n| Function | \`${names.functionName}\` |\n| Queue | \`${names.sourceQueue}\` |\n` +
      `| Smoke test | eventId \`${eventId}\` processed (poll ${poll}) |\n| ExpiresAt (UTC) | \`${expiresAt}\` |\n`,
  );
  return 0;
}

/** Dọn stack `pr-<n>`: chỉ khi tag khớp và PR đã đóng hoặc TTL hết hạn (kiểm lại ở đây, sau khi đã có lượt chạy). */
export function destroy(deps: Deps, pr: number): number {
  const { env, log } = deps;
  const ctx = ctxOf(deps);
  const short = prStackName(pr);
  const full = fullStackName(env.org, pr);

  const info = fetchPr(env.repository, pr, deps.runner); // không bao giờ ném
  const stacks = listStacks(ctx); // lỗi thì ném, giữ nguyên mọi thứ
  if (!stackExists(stacks, ctx, short)) {
    // Không init stack mới trong nhánh dọn. Stack không còn: chỉ cần chắc không còn resource mồ côi trên AWS.
    const orphans = checkPrResources(pr, deps.runner).filter((r) => r.presence === "present");
    if (orphans.length > 0) {
      log(`ERROR: stack ${short} does not exist but AWS still has: ${orphans.map((o) => `${o.kind}:${o.name}`).join(", ")}`);
      return 1;
    }
    log(`Nothing to destroy: stack ${short} does not exist and AWS has none of its resources`);
    deps.summary(`### PR environment \`${short}\`\nNothing to destroy (stack and AWS resources already absent).\n`);
    return 0;
  }

  selectStack(ctx, full);
  const tags = readTags(ctx, full);
  const decision = decideReap({ stackName: short, tags, repository: env.repository, now: deps.now(), pr: info });
  log(`Decision for ${short}: ${decision.action} (${decision.reason})`);
  if (decision.action === "exclude") return 1; // tag không khớp: từ chối, không xoá
  if (decision.action === "keep") {
    deps.summary(`### PR environment \`${short}\`\nKept: ${decision.reason}.\n`);
    return 0; // PR được mở lại/cập nhật trong lúc chờ lượt chạy
  }

  // Checkout mới không có Pulumi.<stack>.yaml: destroy mặc định không chạy chương trình nhưng provider vẫn cần region.
  setConfig(ctx, full, "aws:region", env.region);
  destroyStack(ctx, full); // thất bại → ném → giữ nguyên state để thử lại, không rm

  const remaining = exportResourceCount(ctx, full);
  if (remaining > 0) {
    log(`ERROR: ${remaining} resources remain in stack ${short}; not removing the stack`);
    return 1;
  }
  const present = checkPrResources(pr, deps.runner).filter((r) => r.presence === "present");
  if (present.length > 0) {
    log(`ERROR: AWS still has ${present.map((o) => `${o.kind}:${o.name}`).join(", ")}; not removing the stack`);
    return 1;
  }
  removeStack(ctx, full); // chỉ sau khi destroy thành công và stack rỗng; không dùng --force
  log(`OK: ${short} destroyed, verified empty on Pulumi and AWS, stack removed`);
  deps.summary(
    `### PR environment \`${short}\` destroyed\nReason: ${decision.reason}. Verified: 0 resources in the stack; function, 2 queues, log group and role absent on AWS.\n`,
  );
  return 0;
}

export interface ReapRow {
  stack: string;
  resourceCount?: number;
  decision: Decision;
}

/** Quét stack của project, quyết định từng stack; không dry-run thì giao việc dọn cho workflow riêng của từng PR. */
export function reap(deps: Deps, dryRun: boolean): number {
  const { env, log } = deps;
  const ctx = ctxOf(deps);
  const rows: ReapRow[] = [];
  let errors = 0;

  for (const entry of listStacks(ctx)) {
    const number = prNumberFromStackName(entry.name);
    if (number === undefined) {
      rows.push({ stack: entry.name, resourceCount: entry.resourceCount, decision: decideReap({ stackName: entry.name, tags: {}, repository: env.repository, now: deps.now(), pr: undefined }) });
      continue;
    }
    let tags: Record<string, string>;
    try {
      tags = readTags(ctx, fullStackName(env.org, number));
    } catch (error) {
      errors++;
      rows.push({ stack: entry.name, resourceCount: entry.resourceCount, decision: { action: "exclude", reason: `cannot read tags: ${(error as Error).message}` } });
      continue;
    }
    const pr = fetchPr(env.repository, number, deps.runner);
    rows.push({ stack: entry.name, resourceCount: entry.resourceCount, decision: decideReap({ stackName: entry.name, tags, repository: env.repository, now: deps.now(), pr }) });
  }

  log(`Reaper (${dryRun ? "DRY RUN" : "REAL"}) at ${deps.now().toISOString()}, project ${env.org}/${PROJECT}`);
  for (const row of rows) {
    log(`  ${row.decision.action.toUpperCase().padEnd(7)} ${row.stack.padEnd(10)} ${row.decision.reason}`);
  }

  const toClean = rows.filter((r) => r.decision.action === "clean");
  const dispatched: string[] = [];
  if (!dryRun) {
    for (const row of toClean) {
      try {
        dispatchDestroy(env.repository, prNumberFromStackName(row.stack) as number, deps.runner);
        dispatched.push(row.stack);
        log(`  dispatched cleanup workflow for ${row.stack}`);
      } catch (error) {
        errors++;
        log(`  ERROR dispatching cleanup for ${row.stack}: ${(error as Error).message}`);
      }
    }
  }

  deps.summary(
    `### PR environment reaper (${dryRun ? "dry run" : "real"})\n| Stack | Decision | Reason |\n| --- | --- | --- |\n` +
      rows.map((r) => `| \`${r.stack}\` | ${r.decision.action} | ${r.decision.reason} |`).join("\n") +
      `\n\nWould clean: ${toClean.length}${dryRun ? "" : `, dispatched: ${dispatched.length}`}.\n`,
  );
  return errors > 0 ? 1 : 0;
}
