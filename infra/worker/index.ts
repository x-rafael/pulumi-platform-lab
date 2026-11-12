import * as pulumi from "@pulumi/pulumi";
import { LambdaWorker } from "./components/LambdaWorker";
import { SERVICE_NAME, loadWorkerArgs } from "./components/workerConfig";

// Caller chỉ tạo worker (queue + DLQ + Lambda + mapping). Không tạo ALB/Fargate.
// Stack `dev`/`test`/`prod` hoặc `pr-<n>`; tên vật lý chứa tên stack (xem LambdaWorker).
const args = loadWorkerArgs(new pulumi.Config(), pulumi.getStack());
const worker = new LambdaWorker(SERVICE_NAME, args);

export const queueUrl = worker.queueUrl;
export const queueArn = worker.queueArn;
export const dlqUrl = worker.dlqUrl;
export const dlqArn = worker.dlqArn;
export const functionName = worker.functionName;
export const logGroupName = worker.logGroupName;
export const eventSourceMappingId = worker.eventSourceMappingId;
