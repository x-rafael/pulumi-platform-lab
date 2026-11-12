import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

/**
 * Contract của component FargateService (chặng 3-4).
 *
 * Tên logical resource nằm ở tham số `name` của constructor, không lặp trong args.
 * ID/image dùng `pulumi.Input` để nhận output của resource khác;
 * tuning parameters dùng số thường để kiểm tra ngay lúc khởi tạo.
 *
 * Defaults dự kiến (áp dụng bằng `??` trước khi validate):
 *   containerPort = 80
 *   cpu = 256, memory = 512
 *   desiredCount = 1, minCapacity = 1, maxCapacity = 2
 *   cpuTarget = 60
 *   assignPublicIp = false  (caller truyền true cho network public của lab)
 *
 * Validation dự kiến (throw Error nêu rõ tên trường và giá trị sai):
 *   - cpu/memory: đúng cặp hợp lệ như Bài 1 (256: 512/1024/2048; 512: 1024/2048/3072/4096)
 *   - containerPort: số nguyên 1–65535
 *   - desiredCount, minCapacity, maxCapacity: số nguyên và
 *     1 <= minCapacity <= desiredCount <= maxCapacity (không scale-to-zero)
 *   - cpuTarget: > 0 và <= 100
 *   - albSubnetIds: ít nhất 2 subnet (khác AZ — chỉ kiểm tra được số lượng ở đây,
 *     AZ do caller đảm bảo); taskSubnetIds: ít nhất 1
 *   - allowedIngressCidrs: không rỗng
 *   - tags: có đủ các key Service, Environment, ManagedBy (kiểu Record không ép được key,
 *     nên kiểm tra lúc chạy)
 *   - validate chạy sau khi áp dụng defaults, không âm thầm đổi giá trị sai thành mặc định
 */
export interface FargateServiceArgs {
  /** VPC chứa ALB và tasks. Bắt buộc; component không tự đoán default VPC. */
  vpcId: pulumi.Input<string>;
  /** Subnet cho ALB; cần ít nhất hai subnet ở hai AZ khác nhau. */
  albSubnetIds: pulumi.Input<string>[];
  /** Subnet cho Fargate tasks. */
  taskSubnetIds: pulumi.Input<string>[];
  /** Image Linux có HTTP server và ghi log ra stdout/stderr. */
  image: pulumi.Input<string>;
  /** CIDR được phép vào ALB, ví dụ public IP của bạn dạng "x.x.x.x/32". */
  allowedIngressCidrs: string[];

  /** Mặc định 80. */
  containerPort?: number;
  /** Mặc định 256. */
  cpu?: number;
  /** Mặc định 512 (MiB). */
  memory?: number;
  /** Mặc định 1. */
  desiredCount?: number;
  /** Mặc định 1. */
  minCapacity?: number;
  /** Mặc định 2. */
  maxCapacity?: number;
  /** Mục tiêu CPU trung bình (%), mặc định 60. */
  cpuTarget?: number;
  /** Mặc định false; caller chọn true khi tasks nằm ở public subnet của lab. */
  assignPublicIp?: boolean;
  /** Bắt buộc; phải có Service, Environment, ManagedBy (xem buildTags ở Bài 2). */
  tags: Record<string, string>;
}

const REQUIRED_TAGS = ["Service", "Environment", "ManagedBy"] as const;

const VALID_MEMORY_BY_CPU: Record<number, readonly number[]> = {
  256: [512, 1024, 2048],
  512: [1024, 2048, 3072, 4096],
};

/** Args sau khi áp dụng defaults: các trường có default không còn optional. */
type ResolvedArgs = Required<FargateServiceArgs>;

function requireInteger(field: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${field}: ${value} (must be an integer from ${min} to ${max})`);
  }
}

// Áp dụng defaults bằng `??` (để 0 không bị đổi âm thầm), rồi validate.
function resolveArgs(args: FargateServiceArgs): ResolvedArgs {
  const resolved: ResolvedArgs = {
    ...args,
    containerPort: args.containerPort ?? 80,
    cpu: args.cpu ?? 256,
    memory: args.memory ?? 512,
    desiredCount: args.desiredCount ?? 1,
    minCapacity: args.minCapacity ?? 1,
    maxCapacity: args.maxCapacity ?? 2,
    cpuTarget: args.cpuTarget ?? 60,
    assignPublicIp: args.assignPublicIp ?? false,
  };

  const allowedMemory = VALID_MEMORY_BY_CPU[resolved.cpu];
  if (allowedMemory === undefined) {
    throw new Error(
      `Invalid cpu: ${resolved.cpu} (supported: ${Object.keys(VALID_MEMORY_BY_CPU).join(", ")})`,
    );
  }
  if (!allowedMemory.includes(resolved.memory)) {
    throw new Error(
      `Invalid memory: ${resolved.memory} for cpu ${resolved.cpu} (supported: ${allowedMemory.join(", ")})`,
    );
  }

  requireInteger("containerPort", resolved.containerPort, 1, 65535);
  requireInteger("minCapacity", resolved.minCapacity, 1, Number.MAX_SAFE_INTEGER);
  requireInteger("desiredCount", resolved.desiredCount, 1, Number.MAX_SAFE_INTEGER);
  requireInteger("maxCapacity", resolved.maxCapacity, 1, Number.MAX_SAFE_INTEGER);
  if (
    !(resolved.minCapacity <= resolved.desiredCount && resolved.desiredCount <= resolved.maxCapacity)
  ) {
    throw new Error(
      `Invalid capacity: need minCapacity <= desiredCount <= maxCapacity, got ${resolved.minCapacity}, ${resolved.desiredCount}, ${resolved.maxCapacity}`,
    );
  }

  if (!(resolved.cpuTarget > 0 && resolved.cpuTarget <= 100)) {
    throw new Error(`Invalid cpuTarget: ${resolved.cpuTarget} (must be > 0 and <= 100)`);
  }

  if (resolved.albSubnetIds.length < 2) {
    throw new Error(`Invalid albSubnetIds: got ${resolved.albSubnetIds.length}, need at least 2`);
  }
  if (resolved.taskSubnetIds.length < 1) {
    throw new Error("Invalid taskSubnetIds: need at least 1");
  }
  if (resolved.allowedIngressCidrs.length < 1) {
    throw new Error("Invalid allowedIngressCidrs: need at least 1 CIDR");
  }

  for (const key of REQUIRED_TAGS) {
    const value = resolved.tags[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`Invalid tags.${key}: ${JSON.stringify(value)} (must be a non-empty string)`);
    }
  }

  return resolved;
}

const ECS_TASKS_ASSUME_ROLE = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "ecs-tasks.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
});

const EXECUTION_POLICY_ARN =
  "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy";

export class FargateService extends pulumi.ComponentResource {
  public readonly clusterName: pulumi.Output<string>;
  public readonly logGroupName: pulumi.Output<string>;
  public readonly url: pulumi.Output<string>;
  public readonly targetGroupArn: pulumi.Output<string>;

  private readonly cluster: aws.ecs.Cluster;
  private readonly logGroup: aws.cloudwatch.LogGroup;
  private readonly executionRole: aws.iam.Role;
  private readonly taskRole: aws.iam.Role;
  private readonly albSecurityGroup: aws.ec2.SecurityGroup;
  private readonly taskSecurityGroup: aws.ec2.SecurityGroup;
  private readonly loadBalancer: aws.lb.LoadBalancer;
  private readonly targetGroup: aws.lb.TargetGroup;
  private readonly listener: aws.lb.Listener;
  private readonly taskDefinition: aws.ecs.TaskDefinition;
  private readonly executionPolicyAttachment: aws.iam.RolePolicyAttachment;
  private readonly service: aws.ecs.Service;

  private readonly scalingTarget: aws.appautoscaling.Target;
  private readonly scalingPolicy: aws.appautoscaling.Policy;

  public readonly serviceName: pulumi.Output<string>;

  constructor(name: string, args: FargateServiceArgs, opts?: pulumi.ComponentResourceOptions) {
    super("lab:components:FargateService", name, {}, opts);

    const config = resolveArgs(args);
    const child = { parent: this };

    // 4A: cluster và log group
    this.cluster = new aws.ecs.Cluster(`${name}-cluster`, { tags: config.tags }, child);

    this.logGroup = new aws.cloudwatch.LogGroup(
      `${name}-logs`,
      { retentionInDays: 7, tags: config.tags },
      child,
    );

    // Execution role: ECS agent dùng để kéo image và đẩy log.
    this.executionRole = new aws.iam.Role(
      `${name}-exec-role`,
      { assumeRolePolicy: ECS_TASKS_ASSUME_ROLE, tags: config.tags },
      child,
    );

    this.executionPolicyAttachment = new aws.iam.RolePolicyAttachment(
      `${name}-exec-policy`,
      { role: this.executionRole.name, policyArn: EXECUTION_POLICY_ARN },
      child,
    );

    // Task role: quyền cho code trong container; chưa cấp quyền ứng dụng nào.
    this.taskRole = new aws.iam.Role(
      `${name}-task-role`,
      { assumeRolePolicy: ECS_TASKS_ASSUME_ROLE, tags: config.tags },
      child,
    );

    // 4B: security groups. Rules khai báo inline trong SG (không trộn với resource rules riêng).
    // Egress cho phép mọi IPv4 outbound: lựa chọn đơn giản của lab để kéo image,
    // gửi logs và health check; production nên siết lại.
    const allowAllEgress = [
      { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
    ];

    this.albSecurityGroup = new aws.ec2.SecurityGroup(
      `${name}-alb-sg`,
      {
        vpcId: config.vpcId,
        description: "ALB: HTTP 80 from allowed CIDRs",
        ingress: [
          {
            protocol: "tcp",
            fromPort: 80,
            toPort: 80,
            cidrBlocks: config.allowedIngressCidrs,
          },
        ],
        egress: allowAllEgress,
        tags: config.tags,
      },
      child,
    );

    // Task chỉ nhận traffic từ ALB SG, không mở port trực tiếp cho Internet.
    this.taskSecurityGroup = new aws.ec2.SecurityGroup(
      `${name}-task-sg`,
      {
        vpcId: config.vpcId,
        description: "Tasks: container port from ALB SG only",
        ingress: [
          {
            protocol: "tcp",
            fromPort: config.containerPort,
            toPort: config.containerPort,
            securityGroups: [this.albSecurityGroup.id],
          },
        ],
        egress: allowAllEgress,
        tags: config.tags,
      },
      child,
    );

    // 4B: ALB, target group, listener
    this.loadBalancer = new aws.lb.LoadBalancer(
      `${name}-alb`,
      {
        loadBalancerType: "application",
        internal: false,
        securityGroups: [this.albSecurityGroup.id],
        subnets: config.albSubnetIds,
        tags: config.tags,
      },
      child,
    );

    // targetType "ip" vì Fargate dùng awsvpc; ECS service tự đăng ký IP của task.
    this.targetGroup = new aws.lb.TargetGroup(
      `${name}-tg`,
      {
        vpcId: config.vpcId,
        protocol: "HTTP",
        port: config.containerPort,
        targetType: "ip",
        healthCheck: { path: "/", matcher: "200" },
        tags: config.tags,
      },
      child,
    );

    this.listener = new aws.lb.Listener(
      `${name}-listener`,
      {
        loadBalancerArn: this.loadBalancer.arn,
        port: 80,
        protocol: "HTTP",
        defaultActions: [{ type: "forward", targetGroupArn: this.targetGroup.arn }],
        tags: config.tags,
      },
      child,
    );

    // 4C: task definition
    const region = aws.getRegionOutput({}, { parent: this }).region;

    this.taskDefinition = new aws.ecs.TaskDefinition(
      `${name}-task`,
      {
        // family là tên vật lý bắt buộc; thêm stack để dev/prod cùng account+region không dùng chung.
        family: `${name}-${pulumi.getStack()}-task`,
        requiresCompatibilities: ["FARGATE"],
        networkMode: "awsvpc",
        // Provider yêu cầu chuỗi ở cấp task.
        cpu: String(config.cpu),
        memory: String(config.memory),
        executionRoleArn: this.executionRole.arn,
        taskRoleArn: this.taskRole.arn,
        // image và log group name có thể là Output nên dùng jsonStringify.
        containerDefinitions: pulumi.jsonStringify([
          {
            name: "app",
            image: config.image,
            essential: true,
            portMappings: [
              { containerPort: config.containerPort, protocol: "tcp" },
            ],
            logConfiguration: {
              logDriver: "awslogs",
              options: {
                "awslogs-group": this.logGroup.name,
                "awslogs-region": region,
                "awslogs-stream-prefix": "app",
              },
            },
          },
        ]),
        tags: config.tags,
      },
      child,
    );

    // 4D: ECS service. Task definition tồn tại một mình thì chưa có task nào chạy.
    this.service = new aws.ecs.Service(
      `${name}-service`,
      {
        cluster: this.cluster.arn,
        taskDefinition: this.taskDefinition.arn,
        launchType: "FARGATE",
        desiredCount: config.desiredCount,
        networkConfiguration: {
          subnets: config.taskSubnetIds,
          securityGroups: [this.taskSecurityGroup.id],
          assignPublicIp: config.assignPublicIp,
        },
        loadBalancers: [
          {
            targetGroupArn: this.targetGroup.arn,
            containerName: "app",
            containerPort: config.containerPort,
          },
        ],
        healthCheckGracePeriodSeconds: 60,
        deploymentCircuitBreaker: { enable: true, rollback: true },
        waitForSteadyState: true,
        tags: config.tags,
      },
      {
        ...child,
        // Pulumi đặt desiredCount ban đầu, autoscaler quản lý khi vận hành.
        // ignoreChanges dùng giá trị trong state: chạy `pulumi up --refresh` ở lần update sau.
        ignoreChanges: ["desiredCount"],
        // Tham chiếu ARN chưa đảm bảo listener và policy attachment đã sẵn sàng.
        dependsOn: [this.listener, this.executionPolicyAttachment],
      },
    );

    // 4E: autoscaling. Dùng tên cluster/service (không dùng ARN) trong resourceId.
    this.scalingTarget = new aws.appautoscaling.Target(
      `${name}-scaling-target`,
      {
        resourceId: pulumi.interpolate`service/${this.cluster.name}/${this.service.name}`,
        serviceNamespace: "ecs",
        scalableDimension: "ecs:service:DesiredCount",
        minCapacity: config.minCapacity,
        maxCapacity: config.maxCapacity,
        tags: config.tags,
      },
      child,
    );

    this.scalingPolicy = new aws.appautoscaling.Policy(
      `${name}-cpu-policy`,
      {
        policyType: "TargetTrackingScaling",
        resourceId: this.scalingTarget.resourceId,
        scalableDimension: this.scalingTarget.scalableDimension,
        serviceNamespace: this.scalingTarget.serviceNamespace,
        targetTrackingScalingPolicyConfiguration: {
          predefinedMetricSpecification: {
            predefinedMetricType: "ECSServiceAverageCPUUtilization",
          },
          targetValue: config.cpuTarget,
          scaleOutCooldown: 60,
          scaleInCooldown: 120,
        },
      },
      child,
    );

    this.serviceName = this.service.name;
    this.clusterName = this.cluster.name;
    this.logGroupName = this.logGroup.name;
    this.url = pulumi.interpolate`http://${this.loadBalancer.dnsName}`;
    this.targetGroupArn = this.targetGroup.arn;

    this.registerOutputs({
      clusterName: this.clusterName,
      serviceName: this.serviceName,
      logGroupName: this.logGroupName,
      url: this.url,
      targetGroupArn: this.targetGroupArn,
    });
  }
}
