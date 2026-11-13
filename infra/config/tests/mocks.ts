import * as pulumi from "@pulumi/pulumi";

/**
 * Mocks tối thiểu cho unit tests của project platform-config: một lần `setMocks` cho mỗi file test, gọi TRƯỚC
 * khi import module tạo resource (dynamic import). Account giả 123456789012 chỉ phục vụ unit tests.
 */
export const FAKE_ACCOUNT = "123456789012";
export const FAKE_REGION = "ap-southeast-1";
export const MOCK_PROJECT = "platform-config";
export const MOCK_STACK = "dev";

export interface Registration {
  type: string;
  name: string;
  inputs: Record<string, any>;
  state: Record<string, any>;
}

export interface MockRuntime {
  registrations: Registration[];
  ofType(type: string): Registration[];
  one(type: string, name?: string): Registration;
}

export function setupMocks(stack: string = MOCK_STACK): MockRuntime {
  const registrations: Registration[] = [];

  pulumi.runtime.setMocks(
    {
      newResource: (args) => {
        const inputs: Record<string, any> = args.inputs ?? {};
        const state: Record<string, any> = { ...inputs };
        if (args.type === "aws:ssm/parameter:Parameter") {
          state.arn = `arn:aws:ssm:${FAKE_REGION}:${FAKE_ACCOUNT}:parameter${inputs.name}`;
          state.version = 1;
        }
        registrations.push({ type: args.type, name: args.name, inputs, state });
        return { id: `${args.name}-id`, state };
      },
      call: (args) => {
        throw new Error(`Unmocked invoke "${args.token}": add an explicit mapping in tests/mocks.ts`);
      },
    },
    MOCK_PROJECT,
    stack,
    false,
  );

  return {
    registrations,
    ofType: (type) => registrations.filter((r) => r.type === type),
    one: (type, name) => {
      const found = registrations.filter((r) => r.type === type && (name === undefined || r.name === name));
      if (found.length !== 1) {
        throw new Error(`Expected exactly 1 ${type}${name ? ` named "${name}"` : ""}, found ${found.length}`);
      }
      return found[0];
    },
  };
}

/** Chờ một Output resolve rồi trả giá trị. Không bao giờ resolve thì test timeout thay vì pass nhầm. */
export function resolveOutput<T>(output: pulumi.Input<T>): Promise<pulumi.Unwrap<T>> {
  return new Promise<pulumi.Unwrap<T>>((resolve) => {
    pulumi.output(output).apply(resolve);
  });
}
