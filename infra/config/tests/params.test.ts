import { describe, expect, test } from "vitest";
import {
  assertStackMatchesEnvironment,
  messagePrefixParameterName,
  parseEnvironment,
} from "../params.js";

describe("parseEnvironment", () => {
  test.each(["dev", "test", "prod"])("nhận %s", (value) => {
    expect(parseEnvironment(value)).toBe(value);
  });

  test.each([undefined, "", "Dev", "production", "pr-12", "constructor", "__proto__"])(
    "từ chối %j",
    (value) => {
      expect(() => parseEnvironment(value)).toThrow('Invalid config "environment"');
    },
  );
});

describe("assertStackMatchesEnvironment", () => {
  test.each(["dev", "test", "prod"] as const)("stack %s đi với environment %s", (name) => {
    expect(() => assertStackMatchesEnvironment(name, name)).not.toThrow();
  });

  test("stack dev với environment prod bị chặn", () => {
    expect(() => assertStackMatchesEnvironment("dev", "prod")).toThrow('Stack "dev" must use environment "dev"');
  });

  test.each(["pr-12", "staging", "", "constructor", "__proto__"])("stack lạ %j bị từ chối (project không có stack PR)", (name) => {
    expect(() => assertStackMatchesEnvironment(name, "dev")).toThrow("Unknown stack");
  });
});

describe("messagePrefixParameterName", () => {
  test("có environment trong đường dẫn để các environment không đè nhau", () => {
    expect(messagePrefixParameterName("dev")).toBe("/platform-lab/dev/message-prefix");
    expect(messagePrefixParameterName("prod")).toBe("/platform-lab/prod/message-prefix");
  });
});
