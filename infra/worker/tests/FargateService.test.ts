import { beforeAll, describe, expect, test, vi } from "vitest";
import type { FargateService, FargateServiceArgs } from "../components/FargateService.js";
import { FAKE_REGION, type MockRuntime, resolveOutput, setupMocks } from "./mocks.js";

/*
 * Chặng 2: các test bảo vệ contract mà FargateService gửi xuống provider.
 *
 * Không kiểm tra được bằng mocks (xem source, hoặc kiểm chứng ở integration):
 *   - ResourceOptions: `parent: this`, `dependsOn: [listener, policyAttachment]`,
 *     `ignoreChanges: ["desiredCount"]` của ECS service (components/FargateService.ts).
 *   - AWS có chấp nhận cấu hình, IAM có đủ quyền, subnet có route hay không.
 */

const T = {
  cluster: "aws:ecs/cluster:Cluster",
  logGroup: "aws:cloudwatch/logGroup:LogGroup",
  role: "aws:iam/role:Role",
  attachment: "aws:iam/rolePolicyAttachment:RolePolicyAttachment",
  sg: "aws:ec2/securityGroup:SecurityGroup",
  alb: "aws:lb/loadBalancer:LoadBalancer",
  tg: "aws:lb/targetGroup:TargetGroup",
  listener: "aws:lb/listener:Listener",
  taskDef: "aws:ecs/taskDefinition:TaskDefinition",
  service: "aws:ecs/service:Service",
  scalingTarget: "aws:appautoscaling/target:Target",
  scalingPolicy: "aws:appautoscaling/policy:Policy",
} as const;

const TAGS = { Service: "api", Environment: "dev", ManagedBy: "Pulumi" };
const CIDR = "203.0.113.10/32";

const baseArgs: FargateServiceArgs = {
  vpcId: "vpc-1",
  albSubnetIds: ["subnet-a", "subnet-b"],
  taskSubnetIds: ["subnet-a"],
  image: "nginx:alpine",
  allowedIngressCidrs: [CIDR],
  tags: TAGS,
};

let runtime: MockRuntime;
let FargateServiceCtor: typeof FargateService;

beforeAll(async () => {
  // Mocks trước, rồi mới import module tạo resource.
  runtime = setupMocks();
  ({ FargateService: FargateServiceCtor } = await import("../components/FargateService.js"));
});

/** Tên con theo quy ước `${name}-<hậu tố>` của component. */
const childNames = (n: string) => ({
  cluster: `${n}-cluster`,
  logs: `${n}-logs`,
  execRole: `${n}-exec-role`,
  execPolicy: `${n}-exec-policy`,
  taskRole: `${n}-task-role`,
  albSg: `${n}-alb-sg`,
  taskSg: `${n}-task-sg`,
  alb: `${n}-alb`,
  tg: `${n}-tg`,
  listener: `${n}-listener`,
  task: `${n}-task`,
  service: `${n}-service`,
  scalingTarget: `${n}-scaling-target`,
  scalingPolicy: `${n}-cpu-policy`,
});

/**
 * Tạo service rồi chờ tới khi MỌI resource con đã đăng ký (điều kiện cụ thể, không đoán giờ).
 * Mỗi lần gọi dùng logical name khác nhau để không trùng URN.
 */
async function build(n: string, overrides: Partial<FargateServiceArgs> = {}) {
  const svc = new FargateServiceCtor(n, { ...baseArgs, ...overrides });
  const c = childNames(n);
  const expected: [string, string][] = [
    [T.cluster, c.cluster],
    [T.logGroup, c.logs],
    [T.role, c.execRole],
    [T.attachment, c.execPolicy],
    [T.role, c.taskRole],
    [T.sg, c.albSg],
    [T.sg, c.taskSg],
    [T.alb, c.alb],
    [T.tg, c.tg],
    [T.listener, c.listener],
    [T.taskDef, c.task],
    [T.service, c.service],
    [T.scalingTarget, c.scalingTarget],
    [T.scalingPolicy, c.scalingPolicy],
  ];
  await vi.waitFor(() => {
    for (const [type, name] of expected) {
      expect(
        runtime.ofType(type).some((r) => r.name === name),
        `${type} "${name}" chưa đăng ký`,
      ).toBe(true);
    }
  });
  return { svc, c };
}

/** Một service dùng chung cho nhóm test chỉ đọc (không đổi args). */
let shared: Awaited<ReturnType<typeof build>>;
beforeAll(async () => {
  shared = await build("fx");
});

const reg = (type: string, name: string) => runtime.one(type, name);

describe("ECS task definition", () => {
  test("Fargate + awsvpc, cpu/memory là chuỗi '256'/'512'", () => {
    const task = reg(T.taskDef, shared.c.task);
    expect(task.inputs.requiresCompatibilities).toContain("FARGATE");
    expect(task.inputs.networkMode).toBe("awsvpc");
    expect(task.inputs.cpu).toBe("256");
    expect(task.inputs.memory).toBe("512");
  });

  test("execution role và task role nối đúng role tương ứng, không đảo", () => {
    const task = reg(T.taskDef, shared.c.task);
    expect(task.inputs.executionRoleArn).toBe(reg(T.role, shared.c.execRole).state.arn);
    expect(task.inputs.taskRoleArn).toBe(reg(T.role, shared.c.taskRole).state.arn);
    expect(task.inputs.executionRoleArn).not.toBe(task.inputs.taskRoleArn);
  });

  test("family có tên service và stack (tránh dùng chung giữa stacks)", () => {
    expect(reg(T.taskDef, shared.c.task).inputs.family).toBe("fx-dev-task");
  });
});

describe("Container definition", () => {
  const containers = () =>
    JSON.parse(reg(T.taskDef, shared.c.task).inputs.containerDefinitions as string) as Array<
      Record<string, any>
    >;

  test("image, port và tên container đúng", () => {
    const [app, ...rest] = containers();
    expect(rest).toHaveLength(0);
    expect(app.name).toBe("app");
    expect(app.image).toBe("nginx:alpine");
    expect(app.essential).toBe(true);
    expect(app.portMappings).toEqual([{ containerPort: 80, protocol: "tcp" }]);
  });

  test("awslogs trỏ đúng log group do component tạo và đúng region", () => {
    const [app] = containers();
    expect(app.logConfiguration.logDriver).toBe("awslogs");
    expect(app.logConfiguration.options).toEqual({
      "awslogs-group": reg(T.logGroup, shared.c.logs).state.name,
      "awslogs-region": FAKE_REGION,
      "awslogs-stream-prefix": "app",
    });
  });
});

describe("Security groups", () => {
  test("task SG chỉ nhận từ ALB SG, không có CIDR Internet", () => {
    const ingress = reg(T.sg, shared.c.taskSg).inputs.ingress as Array<Record<string, any>>;
    expect(ingress).toHaveLength(1);
    expect(ingress[0].securityGroups).toEqual([reg(T.sg, shared.c.albSg).id]);
    expect(ingress[0].cidrBlocks ?? []).toEqual([]);
    expect(ingress[0].ipv6CidrBlocks ?? []).toEqual([]);
    expect(JSON.stringify(ingress)).not.toContain("0.0.0.0/0");
    expect(ingress[0]).toMatchObject({ protocol: "tcp", fromPort: 80, toPort: 80 });
  });

  test("ALB SG mở port 80 đúng CIDR của fixture", () => {
    const ingress = reg(T.sg, shared.c.albSg).inputs.ingress as Array<Record<string, any>>;
    expect(ingress).toHaveLength(1);
    expect(ingress[0]).toMatchObject({
      protocol: "tcp",
      fromPort: 80,
      toPort: 80,
      cidrBlocks: [CIDR],
    });
  });

  test("hai SG nằm trong VPC của caller", () => {
    expect(reg(T.sg, shared.c.albSg).inputs.vpcId).toBe("vpc-1");
    expect(reg(T.sg, shared.c.taskSg).inputs.vpcId).toBe("vpc-1");
  });
});

describe("Load balancer", () => {
  test("target group dùng targetType ip và port của container", () => {
    const tg = reg(T.tg, shared.c.tg);
    expect(tg.inputs.targetType).toBe("ip");
    expect(tg.inputs.port).toBe(80);
    expect(tg.inputs.protocol).toBe("HTTP");
    expect(tg.inputs.vpcId).toBe("vpc-1");
  });

  test("ALB dùng ALB SG và hai subnet của caller", () => {
    const alb = reg(T.alb, shared.c.alb);
    expect(alb.inputs.securityGroups).toEqual([reg(T.sg, shared.c.albSg).id]);
    expect(alb.inputs.subnets).toEqual(["subnet-a", "subnet-b"]);
    expect(alb.inputs.internal).toBe(false);
  });

  test("listener forward tới đúng ALB và target group", () => {
    const listener = reg(T.listener, shared.c.listener);
    expect(listener.inputs.loadBalancerArn).toBe(reg(T.alb, shared.c.alb).state.arn);
    expect(listener.inputs.defaultActions).toEqual([
      { type: "forward", targetGroupArn: reg(T.tg, shared.c.tg).state.arn },
    ]);
  });
});

describe("ECS service", () => {
  test("nối đúng cluster, task definition, target group, container name/port", () => {
    const svc = reg(T.service, shared.c.service).inputs;
    expect(svc.cluster).toBe(reg(T.cluster, shared.c.cluster).state.arn);
    expect(svc.taskDefinition).toBe(reg(T.taskDef, shared.c.task).state.arn);
    expect(svc.launchType).toBe("FARGATE");
    expect(svc.loadBalancers).toEqual([
      {
        targetGroupArn: reg(T.tg, shared.c.tg).state.arn,
        containerName: "app",
        containerPort: 80,
      },
    ]);
    const [app] = JSON.parse(
      reg(T.taskDef, shared.c.task).inputs.containerDefinitions as string,
    ) as Array<Record<string, any>>;
    expect(svc.loadBalancers[0].containerName).toBe(app.name);
    expect(svc.loadBalancers[0].containerPort).toBe(app.portMappings[0].containerPort);
  });

  test("network: task subnet, task SG (không phải ALB SG), assignPublicIp mặc định false", () => {
    const net = reg(T.service, shared.c.service).inputs.networkConfiguration;
    expect(net.subnets).toEqual(["subnet-a"]);
    expect(net.securityGroups).toEqual([reg(T.sg, shared.c.taskSg).id]);
    expect(net.securityGroups).not.toContain(reg(T.sg, shared.c.albSg).id);
    expect(net.assignPublicIp).toBe(false);
  });

  test("assignPublicIp=true đi qua tới provider", async () => {
    const { c } = await build("pub", { assignPublicIp: true });
    expect(reg(T.service, c.service).inputs.networkConfiguration.assignPublicIp).toBe(true);
  });
});

describe("Autoscaling", () => {
  test("resourceId dạng service/<clusterName>/<serviceName>, không dùng ARN", () => {
    const target = reg(T.scalingTarget, shared.c.scalingTarget).inputs;
    const clusterName = reg(T.cluster, shared.c.cluster).state.name;
    const serviceName = reg(T.service, shared.c.service).state.name;
    expect(target.resourceId).toBe(`service/${clusterName}/${serviceName}`);
    expect(target.resourceId).not.toContain("arn:");
    expect(target.serviceNamespace).toBe("ecs");
    expect(target.scalableDimension).toBe("ecs:service:DesiredCount");
  });

  test("min 1, max 2; policy theo dõi CPU ở mức 60", () => {
    const target = reg(T.scalingTarget, shared.c.scalingTarget).inputs;
    expect(target.minCapacity).toBe(1);
    expect(target.maxCapacity).toBe(2);
    const policy = reg(T.scalingPolicy, shared.c.scalingPolicy).inputs;
    expect(policy.policyType).toBe("TargetTrackingScaling");
    expect(policy.resourceId).toBe(target.resourceId);
    expect(policy.targetTrackingScalingPolicyConfiguration.targetValue).toBe(60);
    expect(
      policy.targetTrackingScalingPolicyConfiguration.predefinedMetricSpecification
        .predefinedMetricType,
    ).toBe("ECSServiceAverageCPUUtilization");
  });

  test("tham số capacity/cpuTarget của caller đi tới provider", async () => {
    const { c } = await build("scale", {
      desiredCount: 2,
      minCapacity: 2,
      maxCapacity: 4,
      cpuTarget: 75,
    });
    const target = reg(T.scalingTarget, c.scalingTarget).inputs;
    expect([target.minCapacity, target.maxCapacity]).toEqual([2, 4]);
    expect(
      reg(T.scalingPolicy, c.scalingPolicy).inputs.targetTrackingScalingPolicyConfiguration
        .targetValue,
    ).toBe(75);
    expect(reg(T.service, c.service).inputs.desiredCount).toBe(2);
  });
});

describe("Log retention và tags", () => {
  test("log group giữ log 7 ngày", () => {
    expect(reg(T.logGroup, shared.c.logs).inputs.retentionInDays).toBe(7);
  });

  test("các resource hỗ trợ tags đều có đủ Service/Environment/ManagedBy", () => {
    const c = shared.c;
    const tagged: [string, string][] = [
      [T.cluster, c.cluster],
      [T.logGroup, c.logs],
      [T.role, c.execRole],
      [T.role, c.taskRole],
      [T.sg, c.albSg],
      [T.sg, c.taskSg],
      [T.alb, c.alb],
      [T.tg, c.tg],
      [T.listener, c.listener],
      [T.taskDef, c.task],
      [T.service, c.service],
      [T.scalingTarget, c.scalingTarget],
    ];
    for (const [type, name] of tagged) {
      expect(reg(type, name).inputs.tags, `${type} ${name}`).toEqual(TAGS);
    }
    // Policy attachment và scaling policy không có thuộc tính tags, nên không assert.
  });
});

describe("Public outputs", () => {
  test("đủ năm output, mỗi output lấy từ đúng resource", async () => {
    const { svc, c } = shared;
    const values = {
      clusterName: await resolveOutput(svc.clusterName),
      serviceName: await resolveOutput(svc.serviceName),
      logGroupName: await resolveOutput(svc.logGroupName),
      url: await resolveOutput(svc.url),
      targetGroupArn: await resolveOutput(svc.targetGroupArn),
    };
    expect(values).toEqual({
      clusterName: reg(T.cluster, c.cluster).state.name,
      serviceName: reg(T.service, c.service).state.name,
      logGroupName: reg(T.logGroup, c.logs).state.name,
      url: `http://${reg(T.alb, c.alb).state.dnsName}`,
      targetGroupArn: reg(T.tg, c.tg).state.arn,
    });
    expect(values.url).toBe("http://fx-alb.example.test");
    for (const v of Object.values(values)) expect(v).toBeTruthy();
    expect(new Set(Object.values(values)).size).toBe(5);
  });
});

describe("Validation", () => {
  const { ManagedBy: _omit, ...tagsWithoutManagedBy } = TAGS;

  const cases: [string, Partial<FargateServiceArgs>, string][] = [
    ["cpu 0", { cpu: 0 }, "Invalid cpu: 0"],
    ["cpu 512 với memory 512", { cpu: 512, memory: 512 }, "Invalid memory: 512 for cpu 512"],
    ["containerPort 0", { containerPort: 0 }, "Invalid containerPort: 0"],
    ["containerPort 65536", { containerPort: 65536 }, "Invalid containerPort: 65536"],
    ["containerPort 80.5", { containerPort: 80.5 }, "Invalid containerPort: 80.5"],
    ["minCapacity > desiredCount", { minCapacity: 2 }, "Invalid capacity"],
    ["desiredCount > maxCapacity", { desiredCount: 3 }, "Invalid capacity"],
    ["cpuTarget NaN", { cpuTarget: Number.NaN }, "Invalid cpuTarget: NaN"],
    ["cpuTarget 0", { cpuTarget: 0 }, "Invalid cpuTarget: 0"],
    ["cpuTarget 101", { cpuTarget: 101 }, "Invalid cpuTarget: 101"],
    ["một ALB subnet", { albSubnetIds: ["subnet-a"] }, "Invalid albSubnetIds: got 1"],
    ["không có task subnet", { taskSubnetIds: [] }, "Invalid taskSubnetIds"],
    ["CIDRs rỗng", { allowedIngressCidrs: [] }, "Invalid allowedIngressCidrs"],
    ["thiếu tag ManagedBy", { tags: tagsWithoutManagedBy }, "Invalid tags.ManagedBy"],
    ["tag ManagedBy chỉ có khoảng trắng", { tags: { ...TAGS, ManagedBy: "   " } }, "Invalid tags.ManagedBy"],
  ];

  test.each(cases.map(([label, override, message], i) => ({ i, label, override, message })))(
    "$label → throw",
    ({ i, override, message }) => {
      expect(() => new FargateServiceCtor(`bad-${i}`, { ...baseArgs, ...override })).toThrow(
        message,
      );
    },
  );

  test("input sai không tạo resource con nào", () => {
    const name = "bad-no-children";
    expect(() => new FargateServiceCtor(name, { ...baseArgs, cpu: 0 })).toThrow();
    expect(runtime.registrations.filter((r) => r.name.startsWith(`${name}-`))).toEqual([]);
  });

  test("giá trị hợp lệ ở biên không bị chặn", async () => {
    // Chặn quá tay cũng là bug: kiểm tra cặp cpu/memory và port ở biên.
    const { c } = await build("edge", {
      cpu: 512,
      memory: 4096,
      containerPort: 65535,
      desiredCount: 2,
      minCapacity: 2,
      maxCapacity: 2,
      cpuTarget: 100,
    });
    const task = reg(T.taskDef, c.task).inputs;
    expect([task.cpu, task.memory]).toEqual(["512", "4096"]);
  });
});
