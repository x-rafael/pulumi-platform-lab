import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { requireInteger, requireTags } from "./validation";

/**
 * Source queue + dead-letter queue (DLQ) cho worker.
 *
 * Defaults của lab:
 *   visibilityTimeoutSeconds = 60       (message tạm ẩn sau mỗi lần nhận, không phải thời gian lưu)
 *   maxReceiveCount          = 5        (số lần nhận thất bại trước khi chuyển sang DLQ)
 *   messageRetentionSeconds  = 86_400   (source: 1 ngày)
 *   DLQ retention            = 1_209_600 (14 ngày, dài hơn source vì tính từ lúc message vào source queue)
 *
 * Cả hai queue bật SQS-managed encryption rõ ràng. Redrive dùng DLQ của chính source queue,
 * không phải Lambda async DLQ.
 */
export interface QueueWithDlqArgs {
  /** Bắt buộc; phải có Service, Environment, ManagedBy. */
  tags: Record<string, string>;
  /** Mặc định 60; AWS cho 0–43200. */
  visibilityTimeoutSeconds?: number;
  /** Mặc định 5; AWS cho 1–1000. */
  maxReceiveCount?: number;
  /** Mặc định 86400; AWS cho 60–1209600. */
  messageRetentionSeconds?: number;
  /**
   * Tên vật lý cơ sở. Có thì source = `<physicalName>-queue`, DLQ = `<physicalName>-dlq`
   * (caller đưa tên stack vào đây để các stack không trùng nhau). Không có thì Pulumi tự đặt tên.
   * Lưu ý SQS: sau khi xoá queue phải đợi ≥ 60 giây mới tạo lại được queue cùng tên.
   */
  physicalName?: string;
}

export const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 60;
export const DEFAULT_MAX_RECEIVE_COUNT = 5;
export const DEFAULT_RETENTION_SECONDS = 86_400;
export const DLQ_RETENTION_SECONDS = 1_209_600;

type ResolvedArgs = Required<Omit<QueueWithDlqArgs, "physicalName">> & Pick<QueueWithDlqArgs, "physicalName">;

/** SQS: tên queue tối đa 80 ký tự [A-Za-z0-9_-]; chừa chỗ cho hậu tố "-queue" (6 ký tự). */
const PHYSICAL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,74}$/;

function resolveArgs(args: QueueWithDlqArgs): ResolvedArgs {
  const resolved: ResolvedArgs = {
    ...args,
    visibilityTimeoutSeconds: args.visibilityTimeoutSeconds ?? DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
    maxReceiveCount: args.maxReceiveCount ?? DEFAULT_MAX_RECEIVE_COUNT,
    messageRetentionSeconds: args.messageRetentionSeconds ?? DEFAULT_RETENTION_SECONDS,
  };
  requireInteger("visibilityTimeoutSeconds", resolved.visibilityTimeoutSeconds, 0, 43_200);
  requireInteger("maxReceiveCount", resolved.maxReceiveCount, 1, 1000);
  requireInteger("messageRetentionSeconds", resolved.messageRetentionSeconds, 60, DLQ_RETENTION_SECONDS);
  requireTags(resolved.tags);
  if (resolved.physicalName !== undefined && !PHYSICAL_NAME_PATTERN.test(resolved.physicalName)) {
    throw new Error(
      `Invalid physicalName: ${JSON.stringify(resolved.physicalName)} (1-74 chars: letters, digits, - or _)`,
    );
  }
  return resolved;
}

export class QueueWithDlq extends pulumi.ComponentResource {
  public readonly queueUrl: pulumi.Output<string>;
  public readonly queueArn: pulumi.Output<string>;
  public readonly dlqUrl: pulumi.Output<string>;
  public readonly dlqArn: pulumi.Output<string>;

  private readonly dlq: aws.sqs.Queue;
  private readonly queue: aws.sqs.Queue;

  constructor(name: string, args: QueueWithDlqArgs, opts?: pulumi.ComponentResourceOptions) {
    super("lab:components:QueueWithDlq", name, {}, opts);

    const config = resolveArgs(args);
    const child = { parent: this };

    // Tạo DLQ trước vì redrivePolicy của source cần ARN của nó.
    this.dlq = new aws.sqs.Queue(
      `${name}-dlq`,
      {
        name: config.physicalName === undefined ? undefined : `${config.physicalName}-dlq`,
        sqsManagedSseEnabled: true,
        messageRetentionSeconds: DLQ_RETENTION_SECONDS,
        tags: config.tags,
      },
      child,
    );

    this.queue = new aws.sqs.Queue(
      `${name}-queue`,
      {
        name: config.physicalName === undefined ? undefined : `${config.physicalName}-queue`,
        sqsManagedSseEnabled: true,
        visibilityTimeoutSeconds: config.visibilityTimeoutSeconds,
        messageRetentionSeconds: config.messageRetentionSeconds,
        redrivePolicy: pulumi.jsonStringify({
          deadLetterTargetArn: this.dlq.arn,
          maxReceiveCount: config.maxReceiveCount,
        }),
        tags: config.tags,
      },
      child,
    );

    this.queueUrl = this.queue.url;
    this.queueArn = this.queue.arn;
    this.dlqUrl = this.dlq.url;
    this.dlqArn = this.dlq.arn;

    this.registerOutputs({
      queueUrl: this.queueUrl,
      queueArn: this.queueArn,
      dlqUrl: this.dlqUrl,
      dlqArn: this.dlqArn,
    });
  }
}
