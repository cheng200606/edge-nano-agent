/**
 * DeviceSpec 校验：结构 + 三条跨字段约束 + 旧字段兼容。
 *
 * 对应真实源码：packages/shared/src/device-spec-schema.ts
 *
 * 三条必须实现、否则后续工具生成会出错的约束：
 *   1. enum 只允许出现在 string | int | float | enum 上，且元素类型要与声明类型一致
 *   2. defaultValue 必须与 type 兼容，且声明了 enum 时必须属于枚举
 *   3. 历史数据里 telemetry 与 properties 混用，加载时要 telemetry → properties 重命名
 */
import { z } from "zod";

import {
  DEVICE_SPEC_EVENT_TYPES,
  DEVICE_SPEC_TYPES,
  type DeviceSpec,
  type DeviceSpecIssue,
  type DeviceSpecType,
  ENUM_CAPABLE_TYPES,
} from "./device-spec";

const enumValueSchema = z.union([z.string(), z.number()]);

const ParameterSchema = z.object({
  type: z.enum(DEVICE_SPEC_TYPES),
  description: z.string().default(""),
  required: z.boolean().default(false),
  enum: z.array(enumValueSchema).optional(),
});

const PropertySchema = z.object({
  type: z.enum(DEVICE_SPEC_TYPES),
  description: z.string().default(""),
  defaultValue: z.unknown().optional(),
  enum: z.array(enumValueSchema).optional(),
});

const EventSchema = z.object({
  description: z.string().default(""),
  eventType: z.enum(DEVICE_SPEC_EVENT_TYPES),
  outputData: z.record(z.string(), ParameterSchema).default({}),
});

const BaseSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  commands: z.record(z.string(), ParameterSchemaWrapper()).default({}),
  properties: z.record(z.string(), PropertySchema).default({}),
  events: z.record(z.string(), EventSchema).default({}),
});

// 命令 = 描述 + 参数表；参数表复用 ParameterSchema
function ParameterSchemaWrapper() {
  return z.object({
    description: z.string().default(""),
    parameters: z.record(z.string(), ParameterSchema).default({}),
  });
}

/** 值是否与声明类型兼容。 */
function valueMatchesType(type: DeviceSpecType, value: unknown): boolean {
  switch (type) {
    case "string":
    case "enum":
      return typeof value === "string" || typeof value === "number";
    case "int":
      return typeof value === "number" && Number.isInteger(value);
    case "float":
      return typeof value === "number" && Number.isFinite(value);
    case "bool":
      return typeof value === "boolean";
    case "json":
      return typeof value === "object" && value !== null;
    case "array":
      return Array.isArray(value);
    default:
      return false;
  }
}

function enumElementMatchesType(type: DeviceSpecType, value: string | number): boolean {
  if (type === "int") return typeof value === "number" && Number.isInteger(value);
  if (type === "float") return typeof value === "number" && Number.isFinite(value);
  // string / enum 统一按字符串比较，避免前端出现 "1" 与 1 两个选项
  return typeof value === "string" || typeof value === "number";
}

interface Container {
  type: DeviceSpecType;
  enum?: (string | number)[];
  defaultValue?: unknown;
}

/** 对 properties / commands.parameters / events.outputData 里每一项做同一套约束校验。 */
function checkContainer(container: Container, path: string[], ctx: z.RefinementCtx): void {
  const { type, enum: enumValues, defaultValue } = container;

  if (enumValues && enumValues.length > 0) {
    if (!ENUM_CAPABLE_TYPES.includes(type)) {
      ctx.addIssue({
        code: "custom",
        message: `enum is not allowed for type "${type}" (only ${ENUM_CAPABLE_TYPES.join("/")})`,
        path: [...path, "enum"],
      });
    } else {
      const bad = enumValues.find((v) => !enumElementMatchesType(type, v));
      if (bad !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: `enum value ${JSON.stringify(bad)} does not match type "${type}"`,
          path: [...path, "enum"],
        });
      }
    }
  }

  if (defaultValue !== undefined) {
    if (!valueMatchesType(type, defaultValue)) {
      ctx.addIssue({
        code: "custom",
        message: `defaultValue is incompatible with type "${type}"`,
        path: [...path, "defaultValue"],
      });
    } else if (
      enumValues &&
      enumValues.length > 0 &&
      !enumValues.includes(defaultValue as string | number)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "defaultValue is not one of the declared enum values",
        path: [...path, "defaultValue"],
      });
    }
  }
}

export const DeviceSpecSchema = BaseSpecSchema.superRefine((spec, ctx) => {
  for (const [name, prop] of Object.entries(spec.properties ?? {})) {
    checkContainer(prop as Container, ["properties", name], ctx);
  }
  for (const [cmdName, cmd] of Object.entries(spec.commands ?? {})) {
    for (const [pName, p] of Object.entries(cmd.parameters ?? {})) {
      checkContainer(p as Container, ["commands", cmdName, "parameters", pName], ctx);
    }
  }
  for (const [evName, ev] of Object.entries(spec.events ?? {})) {
    for (const [fName, f] of Object.entries(ev.outputData ?? {})) {
      checkContainer(f as Container, ["events", evName, "outputData", fName], ctx);
    }
  }
});

/**
 * 旧字段兼容：telemetry → properties。
 * 历史产品导入时 properties 可能叫 telemetry，不重命名会直接校验失败。
 * 两者同时存在时以 properties 为准，并剔除 telemetry（否则多余字段会被
 * 后续序列化带到持久化层）。
 */
export function normalizeDeviceSpecInput(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const src = input as Record<string, unknown>;
  if (src.telemetry === undefined) return input;
  const { telemetry, ...rest } = src;
  if (rest.properties !== undefined) return rest;
  return { ...rest, properties: telemetry };
}

export interface ValidateResult {
  data: DeviceSpec | null;
  issues: DeviceSpecIssue[];
}

export function validateDeviceSpec(input: unknown): ValidateResult {
  const normalized = normalizeDeviceSpecInput(input);
  const parsed = DeviceSpecSchema.safeParse(normalized);
  if (parsed.success) {
    return { data: parsed.data as DeviceSpec, issues: [] };
  }
  return {
    data: null,
    issues: parsed.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  };
}
