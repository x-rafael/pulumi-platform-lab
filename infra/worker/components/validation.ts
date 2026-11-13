/** Helper validation dùng chung cho các component của worker. Không import Pulumi/AWS. */

/** Danh sách environment duy nhất của lab; mọi nơi khác suy ra từ đây. */
export const ENVIRONMENTS = ["dev", "test", "prod"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const REQUIRED_TAGS = ["Service", "Environment", "ManagedBy"] as const;

export function requireInteger(field: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${field}: ${value} (must be an integer from ${min} to ${max})`);
  }
}

/**
 * Tên biến môi trường của Lambda: bắt đầu bằng chữ, chỉ gồm chữ/số/gạch dưới, tối thiểu 2 ký tự. Tiền tố `AWS_LAMBDA_`
 * bị Lambda dành riêng cho runtime; chặn sớm để lỗi lộ ra ở unit test thay vì lúc `pulumi up`.
 */
export function requireEnvironmentVariableNames(names: readonly string[]): void {
  for (const name of names) {
    if (!/^[A-Za-z][A-Za-z0-9_]+$/.test(name) || name.startsWith("AWS_LAMBDA_")) {
      throw new Error(
        `Invalid functionEnvironment name: ${JSON.stringify(name)} ` +
          "(start with a letter, then letters/digits/underscore, at least 2 chars, not reserved AWS_LAMBDA_*)",
      );
    }
  }
}

/** Kiểu Record không ép được key, nên kiểm tra lúc chạy. */
export function requireTags(tags: Record<string, string>): void {
  for (const key of REQUIRED_TAGS) {
    const value = tags[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`Invalid tags.${key}: ${JSON.stringify(value)} (must be a non-empty string)`);
    }
  }
}
