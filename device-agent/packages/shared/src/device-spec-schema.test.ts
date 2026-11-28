import { describe, expect, test } from "bun:test";

import { DEVICE_SPEC_TYPES } from "./device-spec";
import { normalizeDeviceSpecInput, validateDeviceSpec } from "./device-spec-schema";

describe("DeviceSpecSchema 结构", () => {
  test("最小合法 spec 通过，缺省字段有默认值", () => {
    const r = validateDeviceSpec({ name: "smart-plug", description: "" });
    expect(r.issues).toEqual([]);
    expect(r.data?.name).toBe("smart-plug");
    expect(r.data?.commands).toEqual({});
    expect(r.data?.properties).toEqual({});
    expect(r.data?.events).toEqual({});
  });

  test("7 种类型都被接受", () => {
    const properties: Record<string, { type: string; description: string }> = {};
    for (const t of DEVICE_SPEC_TYPES) properties[`p_${t}`] = { type: t, description: "" };
    const r = validateDeviceSpec({ name: "p", description: "", properties });
    expect(r.issues).toEqual([]);
    expect(Object.keys(r.data?.properties ?? {})).toHaveLength(DEVICE_SPEC_TYPES.length);
  });

  test("name 为空被拒绝", () => {
    const r = validateDeviceSpec({ name: "", description: "" });
    expect(r.data).toBeNull();
    expect(r.issues[0].path).toBe("name");
  });

  test("未知类型被拒绝", () => {
    const r = validateDeviceSpec({
      name: "p",
      description: "",
      properties: { mode: { type: "object", description: "" } },
    });
    expect(r.data).toBeNull();
    expect(r.issues[0].path).toBe("properties.mode.type");
  });
});

describe("enum 与类型一致性", () => {
  test("bool 上声明 enum 报错，路径定位到 properties.mode.enum", () => {
    const r = validateDeviceSpec({
      name: "p",
      description: "",
      commands: {},
      properties: { mode: { type: "bool", description: "", enum: ["on"] } },
      events: {},
    });
    expect(r.data).toBeNull();
    expect(r.issues[0].path).toBe("properties.mode.enum");
  });

  test("int 枚举里混入小数被拒绝", () => {
    const r = validateDeviceSpec({
      name: "p",
      description: "",
      properties: { level: { type: "int", description: "", enum: [1, 2.5, 3] } },
    });
    expect(r.data).toBeNull();
    expect(r.issues.some((i) => i.path === "properties.level.enum")).toBe(true);
  });

  test("命令参数的 enum 同样校验，路径含 commands.<cmd>.parameters", () => {
    const r = validateDeviceSpec({
      name: "p",
      description: "",
      commands: {
        set_mode: {
          description: "",
          parameters: { m: { type: "json", description: "", required: true, enum: ["a"] } },
        },
      },
    });
    expect(r.data).toBeNull();
    expect(r.issues[0].path).toBe("commands.set_mode.parameters.m.enum");
  });

  test("合法枚举通过", () => {
    const r = validateDeviceSpec({
      name: "p",
      description: "",
      properties: { level: { type: "int", description: "", enum: [1, 2, 3] } },
    });
    expect(r.issues).toEqual([]);
    expect(r.data?.properties.level.enum).toEqual([1, 2, 3]);
  });
});

describe("defaultValue 兼容性", () => {
  test("类型不匹配被拒绝", () => {
    const r = validateDeviceSpec({
      name: "p",
      description: "",
      properties: { temp: { type: "float", description: "", defaultValue: "warm" } },
    });
    expect(r.data).toBeNull();
    expect(r.issues[0].path).toBe("properties.temp.defaultValue");
  });

  test("不在枚举范围内被拒绝", () => {
    const r = validateDeviceSpec({
      name: "p",
      description: "",
      properties: { level: { type: "int", description: "", enum: [1, 2], defaultValue: 5 } },
    });
    expect(r.data).toBeNull();
    expect(r.issues[0].path).toBe("properties.level.defaultValue");
  });

  test("兼容的默认值通过", () => {
    const r = validateDeviceSpec({
      name: "p",
      description: "",
      properties: {
        level: { type: "int", description: "", enum: [1, 2], defaultValue: 1 },
        on: { type: "bool", description: "", defaultValue: false },
        extra: { type: "json", description: "", defaultValue: { a: 1 } },
      },
    });
    expect(r.issues).toEqual([]);
  });
});

describe("旧字段兼容", () => {
  test("telemetry 被重命名为 properties", () => {
    const r = validateDeviceSpec({
      name: "p",
      description: "",
      commands: {},
      events: {},
      telemetry: { temp: { type: "float", description: "℃" } },
    });
    expect(r.issues).toEqual([]);
    expect(r.data?.properties.temp.type).toBe("float");
  });

  test("properties 与 telemetry 同时存在时以 properties 为准", () => {
    const normalized = normalizeDeviceSpecInput({
      name: "p",
      properties: { a: { type: "string" } },
      telemetry: { b: { type: "int" } },
    }) as Record<string, unknown>;
    expect(Object.keys(normalized.properties as object)).toEqual(["a"]);
    expect(normalized.telemetry).toBeUndefined();
  });
});
