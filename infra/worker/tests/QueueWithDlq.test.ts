import { beforeAll, describe, expect, test, vi } from "vitest";
import type { QueueWithDlq, QueueWithDlqArgs } from "../components/QueueWithDlq.js";
import { FAKE_ACCOUNT, FAKE_REGION, type MockRuntime, resolveOutput, setupMocks } from "./mocks.js";

const QUEUE = "aws:sqs/queue:Queue";
const TAGS = { Service: "worker", Environment: "dev", ManagedBy: "Pulumi" };

let runtime: MockRuntime;
let Ctor: typeof QueueWithDlq;

beforeAll(async () => {
  runtime = setupMocks();
  ({ QueueWithDlq: Ctor } = await import("../components/QueueWithDlq.js"));
});

async function build(n: string, args: Partial<QueueWithDlqArgs> = {}) {
  const q = new Ctor(n, { tags: TAGS, ...args });
  await vi.waitFor(() => {
    expect(runtime.ofType(QUEUE).map((r) => r.name)).toEqual(
      expect.arrayContaining([`${n}-dlq`, `${n}-queue`]),
    );
  });
  return {
    q,
    source: runtime.one(QUEUE, `${n}-queue`),
    dlq: runtime.one(QUEUE, `${n}-dlq`),
  };
}

describe("QueueWithDlq defaults", () => {
  test("redrive trỏ đúng ARN của DLQ (không phải của source) với maxReceiveCount 5", async () => {
    const { source, dlq } = await build("q-default");
    const redrive = JSON.parse(source.inputs.redrivePolicy as string);
    expect(redrive).toEqual({ deadLetterTargetArn: dlq.state.arn, maxReceiveCount: 5 });
    expect(redrive.deadLetterTargetArn).not.toBe(source.state.arn);
  });

  test("cả hai queue bật SQS-managed encryption", async () => {
    const { source, dlq } = await build("q-sse");
    expect(source.inputs.sqsManagedSseEnabled).toBe(true);
    expect(dlq.inputs.sqsManagedSseEnabled).toBe(true);
  });

  test("retention: source 86.400s, DLQ 1.209.600s và dài hơn source", async () => {
    const { source, dlq } = await build("q-retention");
    expect(source.inputs.messageRetentionSeconds).toBe(86_400);
    expect(dlq.inputs.messageRetentionSeconds).toBe(1_209_600);
    expect(dlq.inputs.messageRetentionSeconds).toBeGreaterThan(source.inputs.messageRetentionSeconds);
  });

  test("visibility timeout 60s ở source; DLQ không có redrive", async () => {
    const { source, dlq } = await build("q-visibility");
    expect(source.inputs.visibilityTimeoutSeconds).toBe(60);
    expect(dlq.inputs.redrivePolicy).toBeUndefined();
  });

  test("là Standard queue (không FIFO)", async () => {
    const { source, dlq } = await build("q-standard");
    expect(source.inputs.fifoQueue).toBeUndefined();
    expect(dlq.inputs.fifoQueue).toBeUndefined();
  });

  test("cả hai queue có đủ tags", async () => {
    const { source, dlq } = await build("q-tags");
    expect(source.inputs.tags).toEqual(TAGS);
    expect(dlq.inputs.tags).toEqual(TAGS);
  });
});

describe("QueueWithDlq overrides", () => {
  test("tham số của caller đi tới provider", async () => {
    const { source } = await build("q-custom", {
      visibilityTimeoutSeconds: 120,
      maxReceiveCount: 3,
      messageRetentionSeconds: 3600,
    });
    expect(source.inputs.visibilityTimeoutSeconds).toBe(120);
    expect(source.inputs.messageRetentionSeconds).toBe(3600);
    expect(JSON.parse(source.inputs.redrivePolicy as string).maxReceiveCount).toBe(3);
  });
});

describe("QueueWithDlq physicalName", () => {
  test("không truyền → để Pulumi tự đặt tên (không có input name)", async () => {
    const { source, dlq } = await build("q-auto");
    expect(source.inputs.name).toBeUndefined();
    expect(dlq.inputs.name).toBeUndefined();
  });

  test("truyền → source là <name>-queue, DLQ là <name>-dlq, URL theo tên đó", async () => {
    const { q, source, dlq } = await build("q-named", { physicalName: "svc-pr-12" });
    expect(source.inputs.name).toBe("svc-pr-12-queue");
    expect(dlq.inputs.name).toBe("svc-pr-12-dlq");
    expect(await resolveOutput(q.queueUrl)).toBe(
      `https://sqs.${FAKE_REGION}.amazonaws.com/${FAKE_ACCOUNT}/svc-pr-12-queue`,
    );
  });

  test("tên 74 ký tự (tối đa) hợp lệ: queue 80 ký tự", async () => {
    const { source } = await build("q-longest", { physicalName: "a".repeat(74) });
    expect((source.inputs.name as string).length).toBe(80);
  });

  test.each(["", "a".repeat(75), "has space", "dot.name", "a/b"])("từ chối physicalName %j", (physicalName) => {
    expect(() => new Ctor("q-bad-name", { tags: TAGS, physicalName })).toThrow("Invalid physicalName");
  });
});

describe("QueueWithDlq outputs", () => {
  test("bốn output lấy từ đúng queue, URL là ID của queue", async () => {
    const { q, source, dlq } = await build("q-out");
    const values = {
      queueUrl: await resolveOutput(q.queueUrl),
      queueArn: await resolveOutput(q.queueArn),
      dlqUrl: await resolveOutput(q.dlqUrl),
      dlqArn: await resolveOutput(q.dlqArn),
    };
    expect(values).toEqual({
      queueUrl: source.state.url,
      queueArn: source.state.arn,
      dlqUrl: dlq.state.url,
      dlqArn: dlq.state.arn,
    });
    expect(values.queueUrl).toBe(`https://sqs.${FAKE_REGION}.amazonaws.com/${FAKE_ACCOUNT}/q-out-queue`);
    expect(new Set(Object.values(values)).size).toBe(4);
  });
});

describe("QueueWithDlq validation", () => {
  const { ManagedBy: _omit, ...withoutManagedBy } = TAGS;
  const cases: [string, Partial<QueueWithDlqArgs>, string][] = [
    ["visibility -1", { visibilityTimeoutSeconds: -1 }, "Invalid visibilityTimeoutSeconds: -1"],
    ["visibility 43201", { visibilityTimeoutSeconds: 43_201 }, "Invalid visibilityTimeoutSeconds: 43201"],
    ["visibility 1.5", { visibilityTimeoutSeconds: 1.5 }, "Invalid visibilityTimeoutSeconds: 1.5"],
    ["maxReceiveCount 0", { maxReceiveCount: 0 }, "Invalid maxReceiveCount: 0"],
    ["maxReceiveCount 1001", { maxReceiveCount: 1001 }, "Invalid maxReceiveCount: 1001"],
    ["maxReceiveCount NaN", { maxReceiveCount: Number.NaN }, "Invalid maxReceiveCount: NaN"],
    ["retention 59", { messageRetentionSeconds: 59 }, "Invalid messageRetentionSeconds: 59"],
    ["retention 1209601", { messageRetentionSeconds: 1_209_601 }, "Invalid messageRetentionSeconds: 1209601"],
    ["thiếu tag Service", { tags: { Environment: "dev", ManagedBy: "Pulumi" } }, "Invalid tags.Service"],
    ["tag ManagedBy trống", { tags: { ...withoutManagedBy, ManagedBy: "  " } }, "Invalid tags.ManagedBy"],
  ];

  test.each(cases.map(([label, override, message], i) => ({ i, label, override, message })))(
    "$label → throw",
    ({ i, override, message }) => {
      expect(() => new Ctor(`q-bad-${i}`, { tags: TAGS, ...override })).toThrow(message);
    },
  );

  test("giá trị ở biên hợp lệ không bị chặn", async () => {
    const { source } = await build("q-edge", {
      visibilityTimeoutSeconds: 0,
      maxReceiveCount: 1000,
      messageRetentionSeconds: 1_209_600,
    });
    expect(source.inputs.visibilityTimeoutSeconds).toBe(0);
  });
});
