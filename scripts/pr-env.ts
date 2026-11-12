/**
 * Vòng đời PR environment.
 *
 *   node scripts/pr-env.ts up --pr 12 [--expires-at <ISO-8601 UTC>]
 *   node scripts/pr-env.ts destroy --pr 12
 *   node scripts/pr-env.ts reap [--dry-run]
 *
 * Biến môi trường: PULUMI_ORG (allowlist), GITHUB_REPOSITORY (allowlist), AWS_REGION (mặc định ap-southeast-1),
 * GH_TOKEN (gh), GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT (đặt eventId), GITHUB_STEP_SUMMARY (tuỳ chọn).
 * Số PR đến từ sự kiện/input của workflow qua tham số; không bao giờ dùng tiêu đề hay nội dung PR.
 * Day 5 sẽ chuyển phần điều phối này sang Pulumi Automation API.
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Deps, type Env, destroy, reap, up } from "./lib/commands.ts";
import { run } from "./lib/exec.ts";
import { parsePrNumber, requireOrg, requireRegion, requireRepository } from "./lib/validate.ts";

const USAGE = `usage:
  pr-env up --pr <n> [--expires-at <ISO-8601 UTC>]
  pr-env destroy --pr <n>
  pr-env reap [--dry-run]`;

function loadEnv(): Env {
  return {
    org: requireOrg(process.env.PULUMI_ORG),
    repository: requireRepository(process.env.GITHUB_REPOSITORY),
    region: requireRegion(process.env.AWS_REGION ?? "ap-southeast-1"),
  };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function buildDeps(env: Env): Deps {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  return {
    runner: run,
    env,
    workerDir: resolve(import.meta.dirname, "..", "infra", "worker"),
    now: () => new Date(),
    sleep: sleepSync,
    log: (line) => console.log(line),
    summary: (markdown) => {
      if (summaryFile) appendFileSync(summaryFile, `${markdown}\n`);
    },
    eventId: (pr) => {
      const runId = process.env.GITHUB_RUN_ID;
      const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
      return runId ? `ci-pr${pr}-${runId}-${attempt}` : `ci-pr${pr}-${Date.now()}`;
    },
  };
}

function main(argv: string[]): number {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      pr: { type: "string" },
      "expires-at": { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  const [command, ...extra] = positionals;
  if (extra.length > 0) throw new Error(`Unexpected arguments: ${extra.join(" ")}`);

  switch (command) {
    case "up": {
      const pr = parsePrNumber(values.pr);
      return up(buildDeps(loadEnv()), pr, values["expires-at"]);
    }
    case "destroy": {
      const pr = parsePrNumber(values.pr);
      return destroy(buildDeps(loadEnv()), pr);
    }
    case "reap":
      return reap(buildDeps(loadEnv()), values["dry-run"] === true);
    default:
      console.error(USAGE);
      return 2;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
