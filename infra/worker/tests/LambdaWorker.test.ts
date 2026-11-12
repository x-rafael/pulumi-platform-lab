import { beforeAll, describe, expect, test, vi } from "vitest";
import type { LambdaWorker, LambdaWorkerArgs } from "../components/LambdaWorker.js";
import { type MockRuntime, resolveOutput, setupMocks } from "./mocks.js";

/*
 * Không kiểm tra được bằng mocks: `dependsOn` (function đợi log group + logs policy; mapping
 * đợi sqs policy), `parent: this`, và đường dẫn của FileArchive("./dist") (mock chỉ cho biết
 * input là một archive). Review ở components/LambdaWorker.ts; xác nhận thật ở integration
 * (Chặng 4: mapping `Enabled`, message được xử lý).
 */

const T = {
  queue: "aws:sqs/queue:Queue",
  role: "aws:iam/role:Role",
  rolePolicy: "aws:iam/rolePolicy:RolePolicy",
  logGroup: "aws:cloudwatch/logGroup:LogGroup",
  fn: "aws:lambda/function:Function",
  mapping: "aws:lambda/eventSourceMapping:EventSourceMapping",
} as const;

const TAGS = { Service: "worker", Environment: "dev", ManagedBy: "Pulumi" };
const BASE: LambdaWorkerArgs = { environment: "dev", stack: "dev", tags: TAGS };

let runtime: MockRuntime;
let Ctor: typeof LambdaWorker;

beforeAll(async () => {
  runtime = setupMocks();
  ({ LambdaWorker: Ctor } = await import("../components/LambdaWorker.js"));
});

const names = (n: string) => ({
  source: `${n}-queues-queue`,
  dlq: `${n}-queues-dlq`,
  role: `${n}-role`,
  sqsPolicy: `${n}-sqs-policy`,
  logsPolicy: `${n}-logs-policy`,
  logs: `${n}-logs`,
  fn: `${n}-fn`,
  mapping: `${n}-mapping`,
});

async function build(n: string, args: Partial<LambdaWorkerArgs> = {}) {
  const w = new Ctor(n, { ...BASE, ...args });
  const c = names(n);
  await vi.waitFor(() => {
    const have = new Set(runtime.registrations.map((r) => r.name));
    for (const name of Object.values(c)) expect(have.has(name), `${name} chưa đăng ký`).toBe(true);
  });
  return { w, c };
}

let shared: Awaited<ReturnType<typeof build>>;
beforeAll(async () => {
  shared = await build("wk");
});

const reg = (type: string, name: string) => runtime.one(type, name);
const policyOf = (name: string) =>
  JSON.parse(reg(T.rolePolicy, name).inputs.policy as string) as {
    Statement: Array<{ Effect: string; Action: string[]; Resource: string }>;
  };

describe("nối queue → mapping → function", () => {
  test("mapping đọc đúng source queue (không phải DLQ) và đúng function", () => {
    const m = reg(T.mapping, shared.c.mapping).inputs;
    expect(m.eventSourceArn).toBe(reg(T.queue, shared.c.source).state.arn);
    expect(m.eventSourceArn).not.toBe(reg(T.queue, shared.c.dlq).state.arn);
    expect(m.functionName).toBe(reg(T.fn, shared.c.fn).state.name);
  });

  test("mapping: batchSize 1, window 0, bật ReportBatchItemFailures", () => {
    const m = reg(T.mapping, shared.c.mapping).inputs;
    expect(m.batchSize).toBe(1);
    expect(m.maximumBatchingWindowInSeconds).toBe(0);
    expect(m.functionResponseTypes).toEqual(["ReportBatchItemFailures"]);
  });

  test("source queue có redrive sang DLQ của chính component", () => {
    const redrive = JSON.parse(reg(T.queue, shared.c.source).inputs.redrivePolicy as string);
    expect(redrive.deadLetterTargetArn).toBe(reg(T.queue, shared.c.dlq).state.arn);
  });
});

describe("IAM", () => {
  test("role tin cậy lambda.amazonaws.com", () => {
    const trust = JSON.parse(reg(T.role, shared.c.role).inputs.assumeRolePolicy as string);
    expect(trust.Statement).toHaveLength(1);
    expect(trust.Statement[0]).toMatchObject({
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    });
  });

  test("policy SQS chỉ đọc đúng source queue, không '*', không DLQ", () => {
    const { Statement } = policyOf(shared.c.sqsPolicy);
    expect(Statement).toHaveLength(1);
    expect(Statement[0].Effect).toBe("Allow");
    expect([...Statement[0].Action].sort()).toEqual([
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ReceiveMessage",
    ]);
    expect(Statement[0].Resource).toBe(reg(T.queue, shared.c.source).state.arn);
    expect(Statement[0].Resource).not.toBe(reg(T.queue, shared.c.dlq).state.arn);
    expect(Statement[0].Resource).not.toContain("*");
  });

  test("policy logs chỉ có CreateLogStream/PutLogEvents trên log group của function", () => {
    const { Statement } = policyOf(shared.c.logsPolicy);
    expect(Statement).toHaveLength(1);
    expect([...Statement[0].Action].sort()).toEqual(["logs:CreateLogStream", "logs:PutLogEvents"]);
    expect(Statement[0].Resource).toBe(`${reg(T.logGroup, shared.c.logs).state.arn}:*`);
  });

  test("hai policy gắn vào role của component", () => {
    const roleName = reg(T.role, shared.c.role).state.name;
    expect(reg(T.rolePolicy, shared.c.sqsPolicy).inputs.role).toBe(roleName);
    expect(reg(T.rolePolicy, shared.c.logsPolicy).inputs.role).toBe(roleName);
    expect(reg(T.fn, shared.c.fn).inputs.role).toBe(reg(T.role, shared.c.role).state.arn);
  });
});

describe("Lambda function", () => {
  test("runtime nodejs22.x, handler worker.handler, timeout 10s, memory 128", () => {
    const fn = reg(T.fn, shared.c.fn).inputs;
    expect(fn.runtime).toBe("nodejs22.x");
    expect(fn.handler).toBe("worker.handler");
    expect(fn.timeout).toBe(10);
    expect(fn.memorySize).toBe(128);
  });

  test("code là một archive (đường dẫn ./dist xem ở review)", () => {
    expect(reg(T.fn, shared.c.fn).inputs.code).toMatchObject({ __pulumiArchive: true });
  });

  test("tên function chứa environment; log group = /aws/lambda/<functionName>", () => {
    const fnName = reg(T.fn, shared.c.fn).inputs.name as string;
    expect(fnName).toBe("wk-dev");
    const logs = reg(T.logGroup, shared.c.logs).inputs;
    expect(logs.name).toBe(`/aws/lambda/${fnName}`);
    expect(logs.retentionInDays).toBe(7);
  });

  test("visibility timeout (60) >= 6 × timeout (10) + batching window (0)", () => {
    const fn = reg(T.fn, shared.c.fn).inputs;
    const m = reg(T.mapping, shared.c.mapping).inputs;
    const visibility = reg(T.queue, shared.c.source).inputs.visibilityTimeoutSeconds as number;
    expect(visibility).toBeGreaterThanOrEqual(6 * fn.timeout + m.maximumBatchingWindowInSeconds);
  });

  test("tags đi tới các resource hỗ trợ tags", () => {
    for (const [type, name] of [
      [T.role, shared.c.role],
      [T.logGroup, shared.c.logs],
      [T.fn, shared.c.fn],
      [T.mapping, shared.c.mapping],
      [T.queue, shared.c.source],
      [T.queue, shared.c.dlq],
    ] as const) {
      expect(reg(type, name).inputs.tags, `${type} ${name}`).toEqual(TAGS);
    }
  });
});

describe("outputs", () => {
  test("bảy output lấy từ đúng resource", async () => {
    const { w, c } = shared;
    const values = {
      queueUrl: await resolveOutput(w.queueUrl),
      queueArn: await resolveOutput(w.queueArn),
      dlqUrl: await resolveOutput(w.dlqUrl),
      dlqArn: await resolveOutput(w.dlqArn),
      functionName: await resolveOutput(w.functionName),
      logGroupName: await resolveOutput(w.logGroupName),
      eventSourceMappingId: await resolveOutput(w.eventSourceMappingId),
    };
    expect(values).toEqual({
      queueUrl: reg(T.queue, c.source).state.url,
      queueArn: reg(T.queue, c.source).state.arn,
      dlqUrl: reg(T.queue, c.dlq).state.url,
      dlqArn: reg(T.queue, c.dlq).state.arn,
      functionName: reg(T.fn, c.fn).state.name,
      logGroupName: reg(T.logGroup, c.logs).state.name,
      eventSourceMappingId: reg(T.mapping, c.mapping).id,
    });
    for (const v of Object.values(values)) expect(v).toBeTruthy();
    expect(new Set(Object.values(values)).size).toBe(7);
  });
});

describe("caller overrides và environment test", () => {
  test("environment test đổi tên function và log group; tham số đi tới provider", async () => {
    const { c } = await build("wk-t", {
      environment: "test",
      stack: "test",
      timeoutSeconds: 20,
      memorySizeMiB: 256,
      visibilityTimeoutSeconds: 150,
      maxReceiveCount: 2,
    });
    const fn = reg(T.fn, c.fn).inputs;
    expect(fn.name).toBe("wk-t-test");
    expect([fn.timeout, fn.memorySize]).toEqual([20, 256]);
    expect(reg(T.logGroup, c.logs).inputs.name).toBe("/aws/lambda/wk-t-test");
    const source = reg(T.queue, c.source).inputs;
    expect(source.visibilityTimeoutSeconds).toBe(150);
    expect(JSON.parse(source.redrivePolicy as string).maxReceiveCount).toBe(2);
  });
});

describe("validation", () => {
  const cases: [string, Partial<LambdaWorkerArgs>, string][] = [
    ["timeout 0", { timeoutSeconds: 0 }, "Invalid timeoutSeconds: 0"],
    ["timeout 901", { timeoutSeconds: 901 }, "Invalid timeoutSeconds: 901"],
    ["memory 64", { memorySizeMiB: 64 }, "Invalid memorySizeMiB: 64"],
    ["memory 10241", { memorySizeMiB: 10_241 }, "Invalid memorySizeMiB: 10241"],
    ["visibility < timeout", { timeoutSeconds: 30, visibilityTimeoutSeconds: 20 }, "must be >= timeoutSeconds 30"],
    ["timeout 100 với visibility mặc định 60", { timeoutSeconds: 100 }, "must be >= timeoutSeconds 100"],
    ["thiếu tag Environment", { tags: { Service: "w", ManagedBy: "Pulumi" } }, "Invalid tags.Environment"],
    ["maxReceiveCount 0", { maxReceiveCount: 0 }, "Invalid maxReceiveCount: 0"],
  ];

  test.each(cases.map(([label, override, message], i) => ({ i, label, override, message })))(
    "$label → throw",
    ({ i, override, message }) => {
      expect(() => new Ctor(`wk-bad-${i}`, { ...BASE, ...override })).toThrow(message);
    },
  );

  test("tên function quá 64 ký tự hoặc ký tự lạ → throw", () => {
    // "x"×62 + "-dev" = 66 ký tự > 64.
    expect(() => new Ctor("x".repeat(62), BASE)).toThrow("Invalid function name");
    expect(() => new Ctor("has space", BASE)).toThrow("Invalid function name");
  });

  test("stack làm tên vượt 64 ký tự hoặc có ký tự lạ → throw", () => {
    expect(() => new Ctor("wk-bad-stack", { ...BASE, stack: "pr-" + "9".repeat(70) })).toThrow("Invalid function name");
    expect(() => new Ctor("wk-bad-stack", { ...BASE, stack: "pr 12" })).toThrow("Invalid stack");
    expect(() => new Ctor("wk-bad-stack", { ...BASE, stack: "" })).toThrow("Invalid stack");
  });

  test("environment ngoài dev|test|prod → throw", () => {
    const bad = { ...BASE, environment: "staging" } as unknown as LambdaWorkerArgs;
    expect(() => new Ctor("wk-bad-env", bad)).toThrow('must be "dev", "test" or "prod"');
  });

  test("input sai không tạo resource con nào", () => {
    expect(() => new Ctor("wk-nochild", { ...BASE, timeoutSeconds: 0 })).toThrow();
    expect(runtime.registrations.filter((r) => r.name.startsWith("wk-nochild-"))).toEqual([]);
  });
});

describe("tên vật lý chứa stack", () => {
  test("stack dev: function, log group, source queue và DLQ đều kết thúc bằng tên stack", () => {
    expect(reg(T.fn, shared.c.fn).inputs.name).toBe("wk-dev");
    expect(reg(T.logGroup, shared.c.logs).inputs.name).toBe("/aws/lambda/wk-dev");
    expect(reg(T.queue, shared.c.source).inputs.name).toBe("wk-dev-queue");
    expect(reg(T.queue, shared.c.dlq).inputs.name).toBe("wk-dev-dlq");
  });

  test("stack pr-12: bốn tên vật lý đổi theo stack, environment vẫn là dev và tags được giữ", async () => {
    const prTags = { ...TAGS, Purpose: "pr-environment", PR: "12", ExpiresAt: "2026-11-13T10:00:00.000Z" };
    const { c } = await build("wk-pr", { stack: "pr-12", tags: prTags });

    expect(reg(T.fn, c.fn).inputs.name).toBe("wk-pr-pr-12");
    expect(reg(T.logGroup, c.logs).inputs.name).toBe("/aws/lambda/wk-pr-pr-12");
    expect(reg(T.queue, c.source).inputs.name).toBe("wk-pr-pr-12-queue");
    expect(reg(T.queue, c.dlq).inputs.name).toBe("wk-pr-pr-12-dlq");
    expect(reg(T.fn, c.fn).inputs.tags).toEqual(prTags);
    expect(reg(T.queue, c.source).inputs.tags).toEqual(prTags);
    // Tên suy ra từ stack chứ không từ environment: environment ở đây là dev nhưng tên không có "-dev".
    expect(reg(T.fn, c.fn).inputs.name).not.toMatch(/-dev$/);
    // Va chạm thật giữa `dev` và `pr-12` (cùng logical name) được kiểm ở index.test.ts / index.pr.test.ts.
  });

  test("environment prod hợp lệ", async () => {
    const { c } = await build("wk-prod", { environment: "prod", stack: "prod" });
    expect(reg(T.fn, c.fn).inputs.name).toBe("wk-prod-prod");
    expect(reg(T.queue, c.source).inputs.name).toBe("wk-prod-prod-queue");
  });
});
