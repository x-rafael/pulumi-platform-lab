import * as pulumi from "@pulumi/pulumi";

/**
 * Helper dùng chung cho unit tests: một lần `setMocks` duy nhất cho mỗi file test.
 *
 * Quy tắc:
 * - Gọi `setupMocks()` TRƯỚC khi import module tạo resource (dùng dynamic import).
 * - Không dùng `test.concurrent`: `registrations` là state chia sẻ của một runtime.
 * - Giá trị giả (account 123456789012, *.example.test) chỉ phục vụ unit tests.
 */

export const FAKE_ACCOUNT = "123456789012";
export const FAKE_REGION = "ap-southeast-1";
export const MOCK_PROJECT = "platform-worker";
export const MOCK_STACK = "dev";

/** Một resource mà chương trình đã đăng ký với (mock) engine. */
export interface Registration {
  type: string;
  name: string;
  /** Inputs đã resolve, đúng như provider sẽ nhận. */
  inputs: Record<string, any>;
  /** State (outputs) mà mock trả về cho resource này. */
  state: Record<string, any>;
  id: string | undefined;
}

export interface MockRuntime {
  registrations: Registration[];
  /** Tất cả registrations cùng `type`. */
  ofType(type: string): Registration[];
  /** Đúng một registration theo type (và name nếu truyền); lỗi nếu 0 hoặc >1. */
  one(type: string, name?: string): Registration;
  /** Xoá danh sách đã ghi (không reset runtime của Pulumi). */
  clear(): void;
}

const arn = (service: string, resource: string, region = FAKE_REGION): string =>
  `arn:aws:${service}:${region}:${FAKE_ACCOUNT}:${resource}`;

type Inputs = Record<string, any>;

/**
 * Outputs do provider tạo, theo đúng loại resource. Mỗi resource chỉ nhận các thuộc tính
 * computed của chính nó; ARN/DNS khác nhau theo type và theo name để lỗi nối dây lộ ra.
 * Nếu input đã có `name` (hoặc `family`) thì giữ nguyên, không ghi đè bằng logical name.
 */
const PROVIDER_OUTPUTS: Record<
  string,
  (name: string, inputs: Inputs) => { id?: string; state: Inputs }
> = {
  "aws:ecs/cluster:Cluster": (name, i) => {
    const n = i.name ?? name;
    return { state: { name: n, arn: arn("ecs", `cluster/${n}`) } };
  },
  "aws:iam/role:Role": (name, i) => {
    const n = i.name ?? name;
    return { state: { name: n, arn: `arn:aws:iam::${FAKE_ACCOUNT}:role/${n}` } };
  },
  "aws:lb/loadBalancer:LoadBalancer": (name, i) => {
    const n = i.name ?? name;
    return {
      state: {
        arn: arn("elasticloadbalancing", `loadbalancer/app/${n}/50dc6c495c0c9188`),
        dnsName: `${n}.example.test`,
      },
    };
  },
  "aws:lb/targetGroup:TargetGroup": (name, i) => {
    const n = i.name ?? name;
    return { state: { arn: arn("elasticloadbalancing", `targetgroup/${n}/73e2d6bc24d8a067`) } };
  },
  "aws:ecs/taskDefinition:TaskDefinition": (name, i) => {
    const family = i.family ?? name;
    const revision = 1;
    return {
      state: {
        family,
        revision,
        arn: arn("ecs", `task-definition/${family}:${revision}`),
      },
    };
  },
  "aws:ecs/service:Service": (name, i) => {
    const n = i.name ?? name;
    return { state: { name: n, arn: arn("ecs", `service/${n}`) } };
  },
  "aws:cloudwatch/logGroup:LogGroup": (name, i) => {
    const n = i.name ?? name;
    return { state: { name: n, arn: arn("logs", `log-group:${n}`) } };
  },
  // SQS: ID của queue chính là URL.
  "aws:sqs/queue:Queue": (name, i) => {
    const n = i.name ?? name;
    const url = `https://sqs.${FAKE_REGION}.amazonaws.com/${FAKE_ACCOUNT}/${n}`;
    return { id: url, state: { name: n, url, arn: arn("sqs", n) } };
  },
  "aws:lambda/function:Function": (name, i) => {
    const n = i.name ?? name;
    return { state: { name: n, arn: arn("lambda", `function:${n}`) } };
  },
};

/** Trả về mocks + danh sách registrations. Tách khỏi `setMocks` để test trực tiếp `call`. */
export function buildMocks(): { mocks: pulumi.runtime.Mocks; runtime: MockRuntime } {
  const registrations: Registration[] = [];

  const mocks: pulumi.runtime.Mocks = {
    newResource: (args) => {
      const inputs: Inputs = args.inputs ?? {};
      const provided = PROVIDER_OUTPUTS[args.type]?.(args.name, inputs);
      const id = provided?.id ?? `${args.name}-id`;
      const state = { ...inputs, ...provided?.state };
      registrations.push({ type: args.type, name: args.name, inputs, state, id });
      return { id, state };
    },
    call: (args) => {
      if (args.token === "aws:index/getRegion:getRegion") {
        return { name: FAKE_REGION, region: FAKE_REGION };
      }
      // Không trả `args.inputs` cho lookup lạ: sẽ che mất output undefined.
      throw new Error(
        `Unmocked invoke "${args.token}": add an explicit mapping in tests/mocks.ts`,
      );
    },
  };

  const runtime: MockRuntime = {
    registrations,
    ofType: (type) => registrations.filter((r) => r.type === type),
    one: (type, name) => {
      const found = registrations.filter(
        (r) => r.type === type && (name === undefined || r.name === name),
      );
      if (found.length !== 1) {
        throw new Error(
          `Expected exactly 1 ${type}${name ? ` named "${name}"` : ""}, found ${found.length}`,
        );
      }
      return found[0];
    },
    clear: () => {
      registrations.length = 0;
    },
  };

  return { mocks, runtime };
}

/** Đăng ký mocks đúng một lần cho file test hiện tại. Gọi trước khi import module có resource. */
export function setupMocks(stack: string = MOCK_STACK): MockRuntime {
  const { mocks, runtime } = buildMocks();
  pulumi.runtime.setMocks(mocks, MOCK_PROJECT, stack, false);
  return runtime;
}

/**
 * Chờ một Output resolve rồi trả giá trị. Nếu Output không bao giờ resolve
 * thì test timeout thay vì pass nhầm.
 */
export function resolveOutput<T>(output: pulumi.Input<T>): Promise<pulumi.Unwrap<T>> {
  return new Promise<pulumi.Unwrap<T>>((resolve) => {
    pulumi.output(output).apply(resolve);
  });
}
