import * as pulumi from "@pulumi/pulumi";
import { LambdaWorker } from "./components/LambdaWorker";
import { parseConfigStack, resolveMessagePrefix } from "./components/messagePrefix";
import { SERVICE_NAME, loadWorkerArgs } from "./components/workerConfig";

// Caller chỉ tạo worker (queue + DLQ + Lambda + mapping). Không tạo ALB/Fargate.
// Stack `dev`/`test`/`prod` hoặc `pr-<n>`; tên vật lý chứa tên stack (xem LambdaWorker).
const config = new pulumi.Config();
const args = loadWorkerArgs(config, pulumi.getStack());

// `configStack` (tuỳ chọn) là tên đầy đủ của stack platform-config. Có thì đọc `messagePrefix` của nó qua
// StackReference (stack đó phải được deploy trước); không có (vd. stack PR) thì dùng prefix mặc định của lab.
// Worker không tạo lại SSM parameter: project platform-config sở hữu nó.
const messagePrefix = resolveMessagePrefix(parseConfigStack(config.get("configStack"), args.environment));
const worker = new LambdaWorker(SERVICE_NAME, { ...args, functionEnvironment: { MESSAGE_PREFIX: messagePrefix } });

export const queueUrl = worker.queueUrl;
export const queueArn = worker.queueArn;
export const dlqUrl = worker.dlqUrl;
export const dlqArn = worker.dlqArn;
export const functionName = worker.functionName;
export const logGroupName = worker.logGroupName;
export const eventSourceMappingId = worker.eventSourceMappingId;
