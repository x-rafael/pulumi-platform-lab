import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import {
  MESSAGE_PREFIX_VALUE,
  SERVICE_NAME,
  assertStackMatchesEnvironment,
  messagePrefixParameterName,
  parseEnvironment,
} from "./params";

// Project này chỉ sở hữu cấu hình không bí mật dùng chung. Worker đọc output `messagePrefix` qua StackReference
// và không tạo lại parameter. Pulumi không tự deploy stack này khi deploy worker: thứ tự do deploy CLI điều phối.
const config = new pulumi.Config();
const environment = parseEnvironment(config.get("environment"));
assertStackMatchesEnvironment(pulumi.getStack(), environment);

const tags = { Service: SERVICE_NAME, Environment: environment, ManagedBy: "Pulumi" };

const messagePrefixParameter = new aws.ssm.Parameter("message-prefix", {
  name: messagePrefixParameterName(environment),
  type: aws.ssm.ParameterType.String,
  // `value` luôn bị Pulumi đánh dấu sensitive; `insecureValue` thì không. Dữ liệu này không bí mật, và nếu
  // output là secret thì stack nào tham chiếu cũng nhận secret (khó đọc log, khó debug).
  insecureValue: MESSAGE_PREFIX_VALUE,
  description: "Non-secret message prefix shared with workers (Pulumi platform lab)",
  tags,
});

export const messagePrefix = messagePrefixParameter.insecureValue;
