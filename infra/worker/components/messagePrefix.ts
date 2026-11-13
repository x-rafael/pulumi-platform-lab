import * as pulumi from "@pulumi/pulumi";
import type { Environment } from "./validation";

/**
 * Prefix mặc định khi stack không khai báo `configStack` (stack PR vẫn độc lập, dọn được theo vòng đời đã viết).
 * Trùng giá trị mà project platform-config publish, nhưng đây là hằng số của worker, không phải đọc từ SSM.
 */
export const DEFAULT_MESSAGE_PREFIX = "lab";

/** Tên output của platform-config mà worker đọc. Đổi tên ở một bên thì phải đổi bên kia. */
export const MESSAGE_PREFIX_OUTPUT = "messagePrefix";

/** `<org>/platform-config/<stack>`: project phải là platform-config, org là tên Pulumi hợp lệ. */
const CONFIG_STACK_PATTERN = /^([A-Za-z0-9][A-Za-z0-9_-]*)\/platform-config\/(dev|test|prod)$/;

/**
 * Kiểm tra config `configStack` (tuỳ chọn). Từ chối tên sai định dạng, trỏ nhầm sang project khác (vd. chính
 * stack của worker), và trỏ sang environment khác: worker dev đọc config của prod là lỗi cấu hình, không đoán.
 */
export function parseConfigStack(value: string | undefined, environment: Environment): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = CONFIG_STACK_PATTERN.exec(value);
  if (match === null) {
    throw new Error(
      `Invalid config "configStack": ${JSON.stringify(value)} (must look like <org>/platform-config/<stack>)`,
    );
  }
  if (match[2] !== environment) {
    throw new Error(
      `Invalid config "configStack": ${JSON.stringify(value)} is the ${match[2]} config stack ` +
        `but this worker's environment is "${environment}"`,
    );
  }
  return value;
}

/**
 * Output của stack khác có kiểu `any`: kiểm tra lúc chạy. Không in giá trị trong lỗi (output có thể là secret),
 * chỉ nêu kiểu nhận được.
 */
export function requireMessagePrefix(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    const got = typeof value === "string" ? "an empty string" : `a ${value === null ? "null" : typeof value}`;
    throw new Error(`Output "${MESSAGE_PREFIX_OUTPUT}" of the config stack must be a non-empty string, got ${got}`);
  }
  return value;
}

/**
 * Prefix cho Lambda: mặc định của lab khi không có `configStack`, ngược lại đọc output của stack đó qua
 * StackReference. StackReference chỉ ĐỌC output; nó không deploy stack kia, nên stack config phải được deploy trước
 * (deploy CLI điều phối thứ tự). Output thiếu thì Pulumi báo lỗi ngay ở preview, không tự bịa giá trị.
 */
export function resolveMessagePrefix(configStack: string | undefined): pulumi.Input<string> {
  if (configStack === undefined) {
    return DEFAULT_MESSAGE_PREFIX;
  }
  const reference = new pulumi.StackReference("platform-config", { name: configStack });
  return reference.requireOutput(MESSAGE_PREFIX_OUTPUT).apply(requireMessagePrefix);
}
