import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { SERVICE_NAME } from "../params.js";
import { MOCK_PROJECT } from "./mocks.js";

// Test chạy từ infra/config.
const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

// Config namespace của Pulumi = `name` trong Pulumi.yaml. Deploy CLI (tools/deploy-cli) cũng dựa vào đúng tên này
// để đọc `platform-config:environment` và dựng tên stack đầy đủ `<org>/platform-config/<stack>`.
test("tên project thống nhất: Pulumi.yaml, package.json, SERVICE_NAME, mock project", () => {
  const pulumiName = /^name:\s*(\S+)\s*$/m.exec(read("Pulumi.yaml"))?.[1];
  const packageName = (JSON.parse(read("package.json")) as { name: string }).name;
  const lockName = (JSON.parse(read("package-lock.json")) as { name: string }).name;

  expect(pulumiName).toBe("platform-config");
  expect(new Set([pulumiName, packageName, lockName, SERVICE_NAME, MOCK_PROJECT]).size).toBe(1);
});
