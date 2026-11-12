import { spawnSync } from "node:child_process";

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Chuyển stdout/stderr thẳng ra log (lệnh dài như `pulumi up`); khi đó stdout/stderr trả về rỗng. */
  stream?: boolean;
}

/** Bộ chạy lệnh có thể thay bằng bản giả trong test. */
export type Runner = (file: string, args: readonly string[], opts?: RunOptions) => RunResult;

/**
 * Chạy lệnh bằng argv, KHÔNG qua shell: giá trị từ ngoài (số PR, tên stack) không bao giờ được diễn giải như lệnh,
 * và không có tiêu đề/nội dung PR nào được đưa vào đây.
 */
export const run: Runner = (file, args, opts = {}) => {
  const result = spawnSync(file, args as string[], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
    stdio: opts.stream ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`Cannot run ${file}: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/** Như `run` nhưng ném lỗi khi lệnh thất bại. Không dùng cho lệnh mà thất bại là thông tin cần phân loại. */
export function runOrThrow(runner: Runner, file: string, args: readonly string[], opts?: RunOptions): RunResult {
  const result = runner(file, args, opts);
  if (result.status !== 0) {
    const detail = result.stderr.trim().split("\n").slice(-3).join(" | ");
    throw new Error(`${file} ${args.slice(0, 3).join(" ")} failed (exit ${result.status})${detail ? `: ${detail}` : ""}`);
  }
  return result;
}
