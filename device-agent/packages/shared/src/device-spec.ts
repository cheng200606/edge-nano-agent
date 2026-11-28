/**
 * 设备模型类型系统。
 *
 * 对应真实源码：packages/shared/src/device-spec.ts
 *
 * 设计取舍（指南 2.2.1）：**故意不提供 object / 嵌套结构**。
 * 设备侧 MCU 能力有限，嵌套会让固件序列化成本翻倍；需要结构化数据时
 * 用 `json` 字段整体传递。这个限制会一路传导到工具参数——模型看不到
 * 嵌套对象，只能看到 `json`。
 */

export const DEVICE_SPEC_TYPES = [
  "string",
  "int",
  "float",
  "bool",
  "enum",
  "json",
  "array",
] as const;
export type DeviceSpecType = (typeof DEVICE_SPEC_TYPES)[number];

export const DEVICE_SPEC_EVENT_TYPES = ["info", "alert", "error"] as const;
export type DeviceSpecEventType = (typeof DEVICE_SPEC_EVENT_TYPES)[number];

/** 允许携带 enum 的类型（指南 2.2.2 校验 1）。 */
export const ENUM_CAPABLE_TYPES: readonly DeviceSpecType[] = ["string", "int", "float", "enum"];

export interface DeviceSpecParameter {
  type: DeviceSpecType;
  description: string;
  required: boolean;
  enum?: (string | number)[];
}

export interface DeviceSpecProperty {
  type: DeviceSpecType;
  description: string;
  defaultValue?: unknown;
  enum?: (string | number)[];
}

export interface DeviceSpecEvent {
  description: string;
  eventType: DeviceSpecEventType;
  outputData: Record<string, DeviceSpecParameter>;
}

export interface DeviceSpecCommand {
  description: string;
  parameters: Record<string, DeviceSpecParameter>;
}

export interface DeviceSpec {
  name: string;
  description: string;
  commands: Record<string, DeviceSpecCommand>;
  properties: Record<string, DeviceSpecProperty>;
  events: Record<string, DeviceSpecEvent>;
}

export interface DeviceSpecIssue {
  path: string;
  message: string;
}
