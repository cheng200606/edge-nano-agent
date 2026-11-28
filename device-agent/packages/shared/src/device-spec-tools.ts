/**
 * DeviceSpec → TypeBox 工具参数 schema。
 *
 * 对应真实源码：packages/shared/src/device-spec-tools.ts（原工程在 tools 侧）
 *
 * 模型能看到什么，完全由这一步决定：
 *   - 命令名 → Literal 枚举，模型在结构上无法编造命令
 *   - 每个参数 → Type.String()/Number()/Boolean()，enum 变成 Union([Literal, ...])
 *   - required:false → Type.Optional(...)
 *   - 没有参数的命令 → Record(String, Any)
 *
 * ⚠️ 不要把 zod schema 强转成 TypeBox：两者对 optional / additionalProperties
 * 的语义不同（指南「常见坑」第 1 条）。
 */
import { type TSchema, Type } from "@sinclair/typebox";

import type { DeviceSpec, DeviceSpecParameter } from "./device-spec";

/** 命令名的字面量联合：模型无法编造不存在的命令。 */
export function commandNameSchema(commands: Record<string, unknown>): TSchema {
  const ids = Object.keys(commands);
  if (ids.length === 0) throw new Error("product has no commands");
  return Type.Unsafe<string>({ type: "string", enum: ids });
}

function parameterBaseSchema(p: DeviceSpecParameter): TSchema {
  switch (p.type) {
    case "int":
    case "float":
      return Type.Number({ description: p.description });
    case "bool":
      return Type.Boolean({ description: p.description });
    case "json":
      return Type.Record(Type.String(), Type.Any(), { description: p.description });
    case "array":
      return Type.Array(Type.Any(), { description: p.description });
    case "enum":
      return Type.String({ description: p.description });
    default:
      return Type.String({ description: p.description });
  }
}

/** 单个参数的 schema：枚举优先，其次按类型；required 决定是否 Optional。 */
export function parameterSchema(p: DeviceSpecParameter): TSchema {
  let base: TSchema;
  if (p.enum && p.enum.length > 0) {
    // 统一 String(v)，避免前端出现 1 与 "1" 两个选项
    const literals = p.enum.map((v) =>
      typeof v === "number" ? Type.Literal(v) : Type.Literal(String(v)),
    );
    base =
      literals.length === 1 ? literals[0] : Type.Union(literals, { description: p.description });
  } else {
    base = parameterBaseSchema(p);
  }
  return p.required ? base : Type.Optional(base);
}

/** 某条命令的入参对象 schema。additionalProperties:false 很关键。 */
export function commandInputSchema(spec: DeviceSpec, commandId: string): TSchema {
  const command = spec.commands[commandId];
  if (!command) throw new Error(`unknown command: ${commandId}`);
  const params = command.parameters ?? {};
  const names = Object.keys(params);
  if (names.length === 0) {
    return Type.Record(Type.String(), Type.Any(), { description: "{} if none" });
  }
  const props: Record<string, TSchema> = {};
  for (const [name, p] of Object.entries(params)) {
    props[name] = parameterSchema(p);
  }
  return Type.Object(props, { additionalProperties: false, description: command.description });
}

/** 列出某条命令的必填参数名，便于测试与前端渲染。 */
export function requiredParameters(spec: DeviceSpec, commandId: string): string[] {
  const params = spec.commands[commandId]?.parameters ?? {};
  return Object.entries(params)
    .filter(([, p]) => p.required)
    .map(([name]) => name);
}
