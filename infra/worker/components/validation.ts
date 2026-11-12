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

/** Kiểu Record không ép được key, nên kiểm tra lúc chạy. */
export function requireTags(tags: Record<string, string>): void {
  for (const key of REQUIRED_TAGS) {
    const value = tags[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`Invalid tags.${key}: ${JSON.stringify(value)} (must be a non-empty string)`);
    }
  }
}
