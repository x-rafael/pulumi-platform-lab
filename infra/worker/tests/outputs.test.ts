import * as pulumi from "@pulumi/pulumi";
import { beforeAll, expect, test, vi } from "vitest";
import { type MockRuntime, resolveOutput, setupMocks } from "./mocks.js";

let runtime: MockRuntime;
let aws: typeof import("@pulumi/aws");

beforeAll(async () => {
  // Mocks trước, rồi mới import module tạo resource.
  runtime = setupMocks();
  aws = await import("@pulumi/aws");
});

// 1C: ví dụ tối thiểu nối assertion với Promise mà Vitest chờ.
test("builds the expected URL", async () => {
  const url = pulumi.interpolate`http://${pulumi.output("api.example.test")}`;
  await new Promise<void>((resolve, reject) => {
    url.apply((value) => {
      try {
        expect(value).toBe("http://api.example.test");
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
});

// Dùng mock thật: dnsName do mock ALB cung cấp, không phải hằng trong test.
test("ALB dnsName từ mock được nối thành URL", async () => {
  const alb = new aws.lb.LoadBalancer("api-alb", { subnets: ["s1", "s2"] });
  const url = pulumi.interpolate`http://${alb.dnsName}`;
  expect(await resolveOutput(url)).toBe("http://api-alb.example.test");
});

// Chờ registration bằng điều kiện cụ thể, không dùng setTimeout đoán giờ.
test("FargateService: chờ scaling policy đăng ký rồi mới assert", async () => {
  const { FargateService } = await import("../components/FargateService.js");
  const svc = new FargateService("wait-demo", {
    vpcId: "vpc-1",
    albSubnetIds: ["s1", "s2"],
    taskSubnetIds: ["s1"],
    image: "nginx",
    allowedIngressCidrs: ["1.2.3.4/32"],
    tags: { Service: "api", Environment: "dev", ManagedBy: "Pulumi" },
  });

  // Output public của service không đợi policy; chờ registration của chính nó.
  await vi.waitFor(() => {
    expect(runtime.ofType("aws:appautoscaling/policy:Policy").map((r) => r.name)).toContain(
      "wait-demo-cpu-policy",
    );
  });

  const policy = runtime.one("aws:appautoscaling/policy:Policy", "wait-demo-cpu-policy");
  expect(policy.inputs.targetTrackingScalingPolicyConfiguration.targetValue).toBe(60);
  expect(await resolveOutput(svc.url)).toBe("http://wait-demo-alb.example.test");
});
