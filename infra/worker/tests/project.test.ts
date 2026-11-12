import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { SERVICE_NAME } from "../components/workerConfig.js";
import { MOCK_PROJECT } from "./mocks.js";

// Test chạy từ infra/worker (cùng giả định với FileArchive("./dist") của LambdaWorker).
const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

// Config namespace của Pulumi = `name` trong Pulumi.yaml. Nếu mocks/tests dùng tên khác,
// `config.get("environment")` trả undefined và lỗi chỉ lộ ra ở nơi khác; kiểm tra ở đây cho rõ.
test("tên project thống nhất: Pulumi.yaml, package.json, SERVICE_NAME, mock project", () => {
  const pulumiName = /^name:\s*(\S+)\s*$/m.exec(read("Pulumi.yaml"))?.[1];
  const packageName = (JSON.parse(read("package.json")) as { name: string }).name;
  const lockName = (JSON.parse(read("package-lock.json")) as { name: string }).name;

  expect(pulumiName).toBe("platform-worker");
  expect(new Set([pulumiName, packageName, lockName, SERVICE_NAME, MOCK_PROJECT]).size).toBe(1);
});
