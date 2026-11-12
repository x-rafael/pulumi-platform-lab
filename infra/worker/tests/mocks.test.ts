import { describe, expect, test } from "vitest";
import { buildMocks, FAKE_ACCOUNT, FAKE_REGION } from "./mocks.js";

// Gọi trực tiếp mocks (không qua engine) để kiểm tra chính helper.
function create(type: string, name: string, inputs: Record<string, any> = {}) {
  const { mocks, runtime } = buildMocks();
  const result = mocks.newResource({ type, name, inputs }) as {
    id: string;
    state: Record<string, any>;
  };
  return { result, runtime };
}

describe("mocks: newResource", () => {
  test("giữ nguyên inputs, ID ổn định và ghi registration", () => {
    const { result, runtime } = create("aws:ec2/securityGroup:SecurityGroup", "api-alb-sg", {
      vpcId: "vpc-1",
    });
    expect(result.id).toBe("api-alb-sg-id");
    expect(result.state.vpcId).toBe("vpc-1");
    expect(runtime.one("aws:ec2/securityGroup:SecurityGroup").inputs).toEqual({ vpcId: "vpc-1" });
  });

  test("ALB: dnsName theo name, ARN đúng dịch vụ và account giả", () => {
    const { result } = create("aws:lb/loadBalancer:LoadBalancer", "api-alb");
    expect(result.state.dnsName).toBe("api-alb.example.test");
    expect(result.state.arn).toMatch(
      new RegExp(`^arn:aws:elasticloadbalancing:${FAKE_REGION}:${FAKE_ACCOUNT}:loadbalancer/app/api-alb/`),
    );
  });

  test("giữ `name` có sẵn trong input thay vì ghi đè bằng logical name", () => {
    const { result } = create("aws:ecs/cluster:Cluster", "logical-name", { name: "physical-name" });
    expect(result.state.name).toBe("physical-name");
    expect(result.state.arn).toMatch(/:cluster\/physical-name$/);
  });

  test("các loại resource khác nhau không dùng chung một ARN", () => {
    const arns = [
      create("aws:ecs/cluster:Cluster", "x").result.state.arn,
      create("aws:lb/targetGroup:TargetGroup", "x").result.state.arn,
      create("aws:cloudwatch/logGroup:LogGroup", "x").result.state.arn,
      create("aws:ecs/service:Service", "x").result.state.arn,
      create("aws:lambda/function:Function", "x").result.state.arn,
    ];
    expect(new Set(arns).size).toBe(arns.length);
  });

  test("task definition có family, revision và ARN gắn với family", () => {
    const { result } = create("aws:ecs/taskDefinition:TaskDefinition", "api-task", {
      family: "api-dev-task",
    });
    expect(result.state.family).toBe("api-dev-task");
    expect(result.state.revision).toBe(1);
    expect(result.state.arn).toMatch(/:task-definition\/api-dev-task:1$/);
  });

  test("SQS queue: ID là URL; state có url, arn, name", () => {
    const { result } = create("aws:sqs/queue:Queue", "jobs");
    expect(result.id).toBe(`https://sqs.${FAKE_REGION}.amazonaws.com/${FAKE_ACCOUNT}/jobs`);
    expect(result.state).toMatchObject({
      url: result.id,
      name: "jobs",
      arn: `arn:aws:sqs:${FAKE_REGION}:${FAKE_ACCOUNT}:jobs`,
    });
  });
});

describe("mocks: call", () => {
  test("getRegion trả name và region", () => {
    const { mocks } = buildMocks();
    expect(mocks.call({ token: "aws:index/getRegion:getRegion", inputs: {} })).toEqual({
      name: FAKE_REGION,
      region: FAKE_REGION,
    });
  });

  test("lookup chưa mock báo lỗi nêu token", () => {
    const { mocks } = buildMocks();
    expect(() => mocks.call({ token: "aws:ec2/getVpc:getVpc", inputs: {} })).toThrow(
      /Unmocked invoke "aws:ec2\/getVpc:getVpc"/,
    );
  });
});
