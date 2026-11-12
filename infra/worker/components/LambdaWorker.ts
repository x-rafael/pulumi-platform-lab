import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import {
  DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
  QueueWithDlq,
  type QueueWithDlqArgs,
} from "./QueueWithDlq";
import { ENVIRONMENTS, type Environment, requireInteger, requireTags } from "./validation";

/**
 * Worker: SQS source queue (+ DLQ) → event source mapping → Lambda handler.
 *
 * Lambda service poll queue rồi invoke handler; SQS không gọi một HTTP endpoint.
 * Handler (handlers/worker.ts) trả partial batch response, nên mapping bật
 * ReportBatchItemFailures: record tốt không bị retry cùng record lỗi.
 *
 * Defaults của lab: timeout 10s, memory 128 MiB, batchSize 1, batching window 0,
 * log retention 7 ngày, runtime nodejs22.x, code từ `./dist` (chạy Pulumi từ project root).
 *
 * Tên vật lý (function, log group, source queue, DLQ) có chứa tên stack nên `dev` và `pr-12`
 * không trùng nhau trong cùng account/region.
 */
export interface LambdaWorkerArgs extends Omit<QueueWithDlqArgs, "physicalName"> {
  /** Gắn vào tên vật lý; do caller (index.ts) lấy từ `pulumi.getStack()`. */
  stack: string;
  /** Gắn vào tag `Environment`; stack ↔ environment do caller (index.ts) kiểm tra. */
  environment: Environment;
  /** Mặc định 10; Lambda cho 1–900. */
  timeoutSeconds?: number;
  /** Mặc định 128 (MiB); Lambda cho 128–10240. */
  memorySizeMiB?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 10;
const DEFAULT_MEMORY_MIB = 128;
const BATCH_SIZE = 1;
const BATCHING_WINDOW_SECONDS = 0;
const LOG_RETENTION_DAYS = 7;

const LAMBDA_ASSUME_ROLE = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
});

type ResolvedArgs = LambdaWorkerArgs &
  Required<Pick<LambdaWorkerArgs, "timeoutSeconds" | "memorySizeMiB" | "visibilityTimeoutSeconds">>;

function resolveArgs(name: string, args: LambdaWorkerArgs): ResolvedArgs {
  const resolved: ResolvedArgs = {
    ...args,
    timeoutSeconds: args.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    memorySizeMiB: args.memorySizeMiB ?? DEFAULT_MEMORY_MIB,
    visibilityTimeoutSeconds: args.visibilityTimeoutSeconds ?? DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
  };

  if (!ENVIRONMENTS.some((e) => e === resolved.environment)) {
    throw new Error(
      `Invalid environment: ${JSON.stringify(resolved.environment)} (must be "dev", "test" or "prod")`,
    );
  }
  requireInteger("timeoutSeconds", resolved.timeoutSeconds, 1, 900);
  requireInteger("memorySizeMiB", resolved.memorySizeMiB, 128, 10_240);
  requireTags(resolved.tags);

  // API yêu cầu visibility timeout >= function timeout. AWS khuyến nghị
  // 6 × timeout + batching window; default của lab (60 >= 6 × 10 + 0) thoả khuyến nghị.
  if (resolved.visibilityTimeoutSeconds < resolved.timeoutSeconds) {
    throw new Error(
      `Invalid visibilityTimeoutSeconds: ${resolved.visibilityTimeoutSeconds} (must be >= timeoutSeconds ${resolved.timeoutSeconds})`,
    );
  }

  // Stack nằm trong tên vật lý: rỗng sẽ để lại hậu tố "-" và tên không còn phân biệt được stack.
  if (!/^[A-Za-z0-9_-]+$/.test(resolved.stack)) {
    throw new Error(`Invalid stack: ${JSON.stringify(resolved.stack)} (non-empty; letters, digits, - or _)`);
  }
  const functionName = `${name}-${resolved.stack}`;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(functionName)) {
    throw new Error(`Invalid function name: ${JSON.stringify(functionName)} (1-64 chars: letters, digits, - or _)`);
  }
  return resolved;
}

export class LambdaWorker extends pulumi.ComponentResource {
  public readonly queueUrl: pulumi.Output<string>;
  public readonly queueArn: pulumi.Output<string>;
  public readonly dlqUrl: pulumi.Output<string>;
  public readonly dlqArn: pulumi.Output<string>;
  public readonly functionName: pulumi.Output<string>;
  public readonly logGroupName: pulumi.Output<string>;
  public readonly eventSourceMappingId: pulumi.Output<string>;

  private readonly queues: QueueWithDlq;
  private readonly role: aws.iam.Role;
  private readonly sqsPolicy: aws.iam.RolePolicy;
  private readonly logsPolicy: aws.iam.RolePolicy;
  private readonly logGroup: aws.cloudwatch.LogGroup;
  private readonly fn: aws.lambda.Function;
  private readonly mapping: aws.lambda.EventSourceMapping;

  constructor(name: string, args: LambdaWorkerArgs, opts?: pulumi.ComponentResourceOptions) {
    super("lab:components:LambdaWorker", name, {}, opts);

    const config = resolveArgs(name, args);
    const child = { parent: this };
    const physicalName = `${name}-${config.stack}`;

    this.queues = new QueueWithDlq(
      `${name}-queues`,
      {
        physicalName,
        tags: config.tags,
        visibilityTimeoutSeconds: config.visibilityTimeoutSeconds,
        maxReceiveCount: args.maxReceiveCount,
        messageRetentionSeconds: args.messageRetentionSeconds,
      },
      child,
    );

    this.role = new aws.iam.Role(
      `${name}-role`,
      { assumeRolePolicy: LAMBDA_ASSUME_ROLE, tags: config.tags },
      child,
    );

    // Chỉ đọc đúng source queue (không "*", không DLQ).
    this.sqsPolicy = new aws.iam.RolePolicy(
      `${name}-sqs-policy`,
      {
        role: this.role.name,
        policy: pulumi.jsonStringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
              Resource: this.queues.queueArn,
            },
          ],
        }),
      },
      child,
    );

    // Tạo log group bằng IaC nên handler không cần logs:CreateLogGroup.
    this.logGroup = new aws.cloudwatch.LogGroup(
      `${name}-logs`,
      {
        name: `/aws/lambda/${physicalName}`,
        retentionInDays: LOG_RETENTION_DAYS,
        tags: config.tags,
      },
      child,
    );

    this.logsPolicy = new aws.iam.RolePolicy(
      `${name}-logs-policy`,
      {
        role: this.role.name,
        policy: pulumi.jsonStringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
              Resource: pulumi.interpolate`${this.logGroup.arn}:*`,
            },
          ],
        }),
      },
      child,
    );

    this.fn = new aws.lambda.Function(
      `${name}-fn`,
      {
        name: physicalName,
        runtime: aws.lambda.Runtime.NodeJS22dX,
        handler: "worker.handler",
        role: this.role.arn,
        code: new pulumi.asset.FileArchive("./dist"),
        timeout: config.timeoutSeconds,
        memorySize: config.memorySizeMiB,
        tags: config.tags,
      },
      {
        ...child,
        // Function đợi log group và quyền ghi log sẵn sàng.
        dependsOn: [this.logGroup, this.logsPolicy],
      },
    );

    this.mapping = new aws.lambda.EventSourceMapping(
      `${name}-mapping`,
      {
        eventSourceArn: this.queues.queueArn,
        functionName: this.fn.name,
        batchSize: BATCH_SIZE,
        maximumBatchingWindowInSeconds: BATCHING_WINDOW_SECONDS,
        functionResponseTypes: ["ReportBatchItemFailures"],
        tags: config.tags,
      },
      {
        ...child,
        // Mapping đợi policy đọc queue attach xong, tránh AccessDenied khi tạo.
        dependsOn: [this.sqsPolicy],
      },
    );

    this.queueUrl = this.queues.queueUrl;
    this.queueArn = this.queues.queueArn;
    this.dlqUrl = this.queues.dlqUrl;
    this.dlqArn = this.queues.dlqArn;
    this.functionName = this.fn.name;
    this.logGroupName = this.logGroup.name;
    this.eventSourceMappingId = this.mapping.id;

    this.registerOutputs({
      queueUrl: this.queueUrl,
      queueArn: this.queueArn,
      dlqUrl: this.dlqUrl,
      dlqArn: this.dlqArn,
      functionName: this.functionName,
      logGroupName: this.logGroupName,
      eventSourceMappingId: this.eventSourceMappingId,
    });
  }
}
