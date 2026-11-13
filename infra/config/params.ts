/** Tên service: tag `Service`, và trùng `name` trong Pulumi.yaml (namespace config của Pulumi). */
export const SERVICE_NAME = "platform-config";

export const ENVIRONMENTS = ["dev", "test", "prod"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** Dữ liệu KHÔNG bí mật, dùng để học dependency giữa hai stack. Không đặt secret vào đây. */
export const MESSAGE_PREFIX_VALUE = "lab";

/** Stack cố định ↔ đúng một environment. Project này không có stack PR. */
const ENVIRONMENT_BY_STACK: ReadonlyMap<string, Environment> = new Map<string, Environment>([
  ["dev", "dev"],
  ["test", "test"],
  ["prod", "prod"],
]);

/** Union `dev | test | prod`: giá trị ngoài danh sách bị từ chối, không đoán. */
export function parseEnvironment(value: string | undefined): Environment {
  const found = ENVIRONMENTS.find((e) => e === value);
  if (found !== undefined) return found;
  throw new Error(
    `Invalid config "environment": ${JSON.stringify(value)} (must be "dev", "test" or "prod"; set with: pulumi config set environment dev)`,
  );
}

/** Stack lạ bị từ chối; stack phải đi cùng đúng environment của nó. */
export function assertStackMatchesEnvironment(stack: string, environment: Environment): void {
  const expected = ENVIRONMENT_BY_STACK.get(stack);
  if (expected === undefined) {
    throw new Error(`Unknown stack "${stack}": expected one of ${[...ENVIRONMENT_BY_STACK.keys()].join(", ")}`);
  }
  if (expected !== environment) {
    throw new Error(`Stack "${stack}" must use environment "${expected}", got "${environment}"`);
  }
}

/**
 * Tên SSM parameter, có environment trong đường dẫn để các environment không đè lên nhau.
 * Worker KHÔNG đọc parameter này trực tiếp: nó đọc output `messagePrefix` của stack này qua StackReference.
 */
export function messagePrefixParameterName(environment: Environment): string {
  return `/platform-lab/${environment}/message-prefix`;
}
