import { describe, expect, test } from "bun:test";

import type { DeviceSpec } from "./device-spec";
import {
  commandInputSchema,
  commandNameSchema,
  parameterSchema,
  requiredParameters,
} from "./device-spec-tools";

/**
 * TypeBox 的 TSchema 是个宽泛类型，测试里要按具体形状断言，
 * 必须先 `as unknown as`——直接 `as` 会被 tsc 判为不重叠。
 */
interface NameSchema {
  type: string;
  enum: string[];
}
interface ObjectSchema {
  type?: string;
  description?: string;
  properties: Record<string, { anyOf?: unknown[] }>;
  required?: string[];
  additionalProperties?: boolean;
}
interface SimpleSchema {
  type: string;
}

const spec: DeviceSpec = {
  name: "smart-plug",
  description: "智能插座",
  commands: {
    turn_on: { description: "开机", parameters: {} },
    turn_off: { description: "关机", parameters: {} },
    set_mode: {
      description: "设置工作模式",
      parameters: {
        mode: {
          type: "enum",
          description: "工作模式",
          required: true,
          enum: ["eco", "normal", "turbo"],
        },
        level: { type: "int", description: "档位", required: false },
      },
    },
  },
  properties: {},
  events: {},
};

describe("commandNameSchema", () => {
  test("命令名是字面量枚举，模型无法编造命令", () => {
    const s = commandNameSchema(spec.commands) as unknown as NameSchema;
    expect(s.type).toBe("string");
    expect(s.enum).toEqual(["turn_on", "turn_off", "set_mode"]);
    expect(s.enum).toHaveLength(3);
  });

  test("没有命令的产品直接抛错", () => {
    expect(() => commandNameSchema({})).toThrow(/no commands/);
  });
});

describe("commandInputSchema", () => {
  test("枚举参数生成 3 个字面量的联合", () => {
    const s = commandInputSchema(spec, "set_mode") as unknown as ObjectSchema;
    expect(s.properties.mode.anyOf).toHaveLength(3);
  });

  test("required 数组只包含必填参数", () => {
    const s = commandInputSchema(spec, "set_mode") as unknown as ObjectSchema;
    expect(s.required).toEqual(["mode"]);
    expect(requiredParameters(spec, "set_mode")).toEqual(["mode"]);
  });

  test("additionalProperties 为 false，防止模型塞入额外字段", () => {
    const s = commandInputSchema(spec, "set_mode") as unknown as ObjectSchema;
    expect(s.additionalProperties).toBe(false);
  });

  test("无参数命令退化为 Record(String, Any)", () => {
    const s = commandInputSchema(spec, "turn_on") as unknown as ObjectSchema;
    expect(s.type).toBe("object");
    expect(s.description).toBe("{} if none");
  });

  test("未知命令抛错", () => {
    expect(() => commandInputSchema(spec, "nope")).toThrow(/unknown command/);
  });

  test("required:false 的参数不出现在 required 数组里", () => {
    // TypeBox 的 Type.Optional 是「key 不进入 required」，不是 anyOf[..., undefined]
    const s = commandInputSchema(spec, "set_mode") as unknown as ObjectSchema;
    expect(s.required).not.toContain("level");
  });
});

describe("parameterSchema", () => {
  test("bool / json / array 参数映射到正确的基础类型", () => {
    const boolS = parameterSchema({
      type: "bool",
      description: "",
      required: true,
    }) as unknown as SimpleSchema;
    const jsonS = parameterSchema({
      type: "json",
      description: "",
      required: true,
    }) as unknown as SimpleSchema;
    const arrS = parameterSchema({
      type: "array",
      description: "",
      required: true,
    }) as unknown as SimpleSchema;
    expect(boolS.type).toBe("boolean");
    expect(jsonS.type).toBe("object");
    expect(arrS.type).toBe("array");
  });

  test("int / float 都映射为 number", () => {
    const intS = parameterSchema({
      type: "int",
      description: "",
      required: true,
    }) as unknown as SimpleSchema;
    const floatS = parameterSchema({
      type: "float",
      description: "",
      required: true,
    }) as unknown as SimpleSchema;
    expect(intS.type).toBe("number");
    expect(floatS.type).toBe("number");
  });
});
