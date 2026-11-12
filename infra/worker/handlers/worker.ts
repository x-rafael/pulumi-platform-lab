import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";

/** Payload hợp lệ: {"eventId":"day2-ok-001","action":"process","forceFail":false} */
export interface WorkerMessage {
  eventId: string;
  action: "process";
  forceFail: boolean;
}

/**
 * Parse và validate body của một record. `JSON.parse` trả `unknown`: không tin kiểu cho tới
 * khi kiểm tra từng trường. Throw Error nêu rõ trường sai.
 */
export function parseMessage(body: string): WorkerMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new Error("Invalid message: body is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid message: body must be a JSON object");
  }
  const { eventId, action, forceFail } = raw as Record<string, unknown>;
  if (typeof eventId !== "string" || eventId.trim() === "") {
    throw new Error("Invalid message: eventId must be a non-empty string");
  }
  if (action !== "process") {
    throw new Error(`Invalid message: action must be "process", got ${JSON.stringify(action)}`);
  }
  if (forceFail !== undefined && typeof forceFail !== "boolean") {
    throw new Error("Invalid message: forceFail must be a boolean when present");
  }
  return { eventId, action, forceFail: forceFail ?? false };
}

/**
 * Xử lý từng record riêng; record lỗi vào `batchItemFailures` thay vì throw cả batch.
 * Event source mapping phải bật ReportBatchItemFailures để Lambda áp dụng kết quả này.
 *
 * Lab chỉ ghi log. Nếu có side effect thật (thu tiền, ghi đơn hàng), SQS có thể giao lặp,
 * nên cần cơ chế idempotency: `eventId` một mình chưa phải là cơ chế đó.
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    let eventId: string | undefined;
    try {
      const message = parseMessage(record.body);
      eventId = message.eventId;
      // Nhánh cố ý tạo lỗi của lab; không dùng cho payload production.
      if (message.forceFail) {
        throw new Error(`forceFail requested for ${message.eventId}`);
      }
      console.log(
        JSON.stringify({ status: "processed", eventId, messageId: record.messageId }),
      );
    } catch (error) {
      logFailure(record, eventId, error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}

// Không ghi nguyên body (có thể chứa dữ liệu nhạy cảm); chỉ độ dài và lý do lỗi.
function logFailure(record: SQSRecord, eventId: string | undefined, error: unknown): void {
  console.error(
    JSON.stringify({
      status: "failed",
      eventId,
      messageId: record.messageId,
      receiveCount: record.attributes?.ApproximateReceiveCount,
      bodyLength: record.body.length,
      revision: "pr-env-update-test",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}
