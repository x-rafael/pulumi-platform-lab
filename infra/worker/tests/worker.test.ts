import type { SQSEvent, SQSRecord } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from "vitest";
import { handler, parseMessage } from "../handlers/worker.js";

function record(messageId: string, body: string): SQSRecord {
  return {
    messageId,
    receiptHandle: `rh-${messageId}`,
    body,
    attributes: {
      ApproximateReceiveCount: "1",
      SentTimestamp: "0",
      SenderId: "AIDAEXAMPLE",
      ApproximateFirstReceiveTimestamp: "0",
    },
    messageAttributes: {},
    md5OfBody: "",
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:ap-southeast-1:123456789012:q",
    awsRegion: "ap-southeast-1",
  };
}

const event = (...records: SQSRecord[]): SQSEvent => ({ Records: records });
const good = (id: string) => JSON.stringify({ eventId: id, action: "process", forceFail: false });

let log: MockInstance<typeof console.log>;
let err: MockInstance<typeof console.error>;

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  err = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const logged = (spy: MockInstance<typeof console.log>) =>
  spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

describe("handler", () => {
  test("record tốt: không có failure, log processed với eventId và messageId", async () => {
    const res = await handler(event(record("m-1", good("day2-ok-001"))));
    expect(res).toEqual({ batchItemFailures: [] });
    expect(logged(log)).toEqual([{ status: "processed", eventId: "day2-ok-001", messageId: "m-1" }]);
    expect(err).not.toHaveBeenCalled();
  });

  test("forceFail omitted được coi là false", async () => {
    const res = await handler(event(record("m-1", JSON.stringify({ eventId: "e1", action: "process" }))));
    expect(res.batchItemFailures).toEqual([]);
  });

  test("JSON hỏng: trả messageId của record, không throw", async () => {
    const res = await handler(event(record("m-bad", "{not json")));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: "m-bad" }]);
    expect(logged(err)[0]).toMatchObject({
      status: "failed",
      messageId: "m-bad",
      error: expect.stringContaining("not valid JSON"),
    });
  });

  test("thiếu eventId → failure", async () => {
    const res = await handler(event(record("m-2", JSON.stringify({ action: "process" }))));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: "m-2" }]);
    expect(logged(err)[0].error).toContain("eventId");
  });

  test("forceFail:true → failure và log có eventId để chẩn đoán", async () => {
    const body = JSON.stringify({ eventId: "day2-fail-001", action: "process", forceFail: true });
    const res = await handler(event(record("m-3", body)));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: "m-3" }]);
    expect(logged(err)[0]).toMatchObject({ status: "failed", eventId: "day2-fail-001", messageId: "m-3" });
    expect(log).not.toHaveBeenCalled();
  });

  test("batch trộn tốt/xấu: chỉ trả messageId của record lỗi, record tốt vẫn được xử lý", async () => {
    const res = await handler(
      event(
        record("m-a", good("a")),
        record("m-b", "oops"),
        record("m-c", good("c")),
        record("m-d", JSON.stringify({ eventId: "d", action: "process", forceFail: true })),
      ),
    );
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: "m-b" }, { itemIdentifier: "m-d" }]);
    expect(logged(log).map((l) => l.eventId)).toEqual(["a", "c"]);
  });

  test("không ghi nguyên body vào log lỗi", async () => {
    await handler(event(record("m-x", JSON.stringify({ eventId: "secret-1", action: "bad", pii: "SSN-123" }))));
    expect(JSON.stringify(err.mock.calls)).not.toContain("SSN-123");
  });

  test("batch rỗng → không failure", async () => {
    expect(await handler(event())).toEqual({ batchItemFailures: [] });
  });
});

describe("parseMessage", () => {
  test.each([
    ["body là mảng", "[]", "JSON object"],
    ["body là null", "null", "JSON object"],
    ["body là chuỗi", '"hi"', "JSON object"],
    ["eventId là số", '{"eventId":1,"action":"process"}', "eventId"],
    ["eventId rỗng", '{"eventId":"  ","action":"process"}', "eventId"],
    ["action sai", '{"eventId":"e","action":"delete"}', "action"],
    ["thiếu action", '{"eventId":"e"}', "action"],
    ["forceFail là chuỗi", '{"eventId":"e","action":"process","forceFail":"true"}', "forceFail"],
  ])("%s → throw", (_label, body, fragment) => {
    expect(() => parseMessage(body)).toThrow(fragment);
  });

  test("payload hợp lệ", () => {
    expect(parseMessage(good("x"))).toEqual({ eventId: "x", action: "process", forceFail: false });
  });
});
