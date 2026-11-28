/**
 * 设备平台 provider：default。
 *
 * 对应真实源码：packages/iot-platform/src/providers/default/*
 *
 * 职责：把「主题 + 原始报文」翻译成系统内部的领域对象，以及反向构造下行主题。
 *
 * ⚠️ 为什么 ParseResult 不是可辨别联合（discriminated union）：
 *   本工程 tsconfig 是 `strict: false`（沿用原工程，避免上万条隐式 any），
 *   此时 `strictNullChecks` 也是关闭的，**布尔字面量判别式不会窄化**：
 *   `if (!r.ok) ...` 之后 TS 仍认为是整个联合，报 "not assignable"。
 *   因此用「带可选字段的单一结构」，靠 `ok` 显式判断，兼容两种 strict 设置。
 */
import {
  DEFAULT_MQTT_TOPIC_TEMPLATES,
  matchTopic,
  renderTopic,
} from "@device-agent/shared/mqtt-topics";

export const DEFAULT_PROVIDER_ID = "default";

export interface ProtocolError {
  code: string;
  message: string;
}

export interface ParseResult<T> {
  ok: boolean;
  data?: T;
  error?: ProtocolError;
}

export interface TelemetryData {
  ts: number;
  values: Record<string, unknown>;
}

export interface DeviceEventData {
  eventName: string;
  eventType: "info" | "alert" | "error";
  payload: Record<string, unknown>;
}

export interface CommandResponseData {
  commandId: string;
  ok: boolean;
  response?: unknown;
  errorCode?: string;
  errorMessage?: string;
}

const TELEMETRY_TOPIC_TEMPLATE = DEFAULT_MQTT_TOPIC_TEMPLATES.deviceTelemetry;
const EVENT_TOPIC_TEMPLATE = DEFAULT_MQTT_TOPIC_TEMPLATES.deviceEvent;
const COMMAND_TOPIC_TEMPLATE = DEFAULT_MQTT_TOPIC_TEMPLATES.deviceCommands;
const RESPONSE_TOPIC_TEMPLATE = DEFAULT_MQTT_TOPIC_TEMPLATES.deviceResponses;

/** 从主题里解出 {productId, deviceId}；不是本平台的设备主题返回 null。 */
export function resolveDeviceTopic(
  topic: string,
  kind: "telemetry" | "event" | "commands" | "responses",
): { productId: string; deviceId: string } | null {
  const template =
    kind === "telemetry"
      ? TELEMETRY_TOPIC_TEMPLATE
      : kind === "event"
        ? EVENT_TOPIC_TEMPLATE
        : kind === "commands"
          ? COMMAND_TOPIC_TEMPLATE
          : RESPONSE_TOPIC_TEMPLATE;
  const captured = matchTopic(template, topic);
  if (!captured?.productId || !captured?.deviceId) return null;
  return { productId: captured.productId, deviceId: captured.deviceId };
}

export function telemetryTopic(productId: string, deviceId: string): string {
  return renderTopic(TELEMETRY_TOPIC_TEMPLATE, { productId, deviceId });
}

export function eventTopic(productId: string, deviceId: string): string {
  return renderTopic(EVENT_TOPIC_TEMPLATE, { productId, deviceId });
}

export function commandTopic(productId: string, deviceId: string): string {
  return renderTopic(COMMAND_TOPIC_TEMPLATE, { productId, deviceId });
}

export function responseTopic(productId: string, deviceId: string): string {
  return renderTopic(RESPONSE_TOPIC_TEMPLATE, { productId, deviceId });
}

function fail(code: string, message: string): { ok: false; error: ProtocolError } {
  return { ok: false, error: { code, message } };
}

function parseJson(raw: string | Buffer): ParseResult<Record<string, unknown>> {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("MQTT_PAYLOAD_INVALID_JSON", "payload is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("MQTT_PAYLOAD_NOT_OBJECT", "payload must be a JSON object");
  }
  return { ok: true, data: parsed as Record<string, unknown> };
}

export function parseTelemetryPayload(raw: string | Buffer): ParseResult<TelemetryData> {
  const parsed = parseJson(raw);
  if (parsed.ok !== true || !parsed.data) {
    return { ok: false, error: parsed.error ?? { code: "PARSE_FAILED", message: "parse failed" } };
  }
  const body = parsed.data;
  const values = body.values;
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    return fail("TELEMETRY_VALUES_NOT_OBJECT", "values must be an object");
  }
  const ts = typeof body.ts === "number" ? body.ts : Date.now();
  return { ok: true, data: { ts, values: values as Record<string, unknown> } };
}

export function parseDeviceEventPayload(raw: string | Buffer): ParseResult<DeviceEventData> {
  const parsed = parseJson(raw);
  if (parsed.ok !== true || !parsed.data) {
    return { ok: false, error: parsed.error ?? { code: "PARSE_FAILED", message: "parse failed" } };
  }
  const body = parsed.data;
  const name = body.event ?? body.eventName;
  if (typeof name !== "string" || name.length === 0) {
    return fail("EVENT_NAME_MISSING", "event name is required");
  }
  const rawType = body.type;
  const eventType: "info" | "alert" | "error" =
    rawType === "alert" || rawType === "error" ? rawType : "info";
  const payload =
    typeof body.payload === "object" && body.payload !== null
      ? (body.payload as Record<string, unknown>)
      : {};
  return { ok: true, data: { eventName: name, eventType, payload } };
}

export function parseCommandResponsePayload(
  raw: string | Buffer,
): ParseResult<CommandResponseData> {
  const parsed = parseJson(raw);
  if (parsed.ok !== true || !parsed.data) {
    return { ok: false, error: parsed.error ?? { code: "PARSE_FAILED", message: "parse failed" } };
  }
  const body = parsed.data;
  const commandId = body.commandId;
  if (typeof commandId !== "string" || commandId.length === 0) {
    return fail("RESPONSE_COMMAND_ID_MISSING", "commandId is required");
  }
  return {
    ok: true,
    data: {
      commandId,
      ok: body.ok === true,
      response: body.response,
      errorCode: typeof body.errorCode === "string" ? body.errorCode : undefined,
      errorMessage: typeof body.errorMessage === "string" ? body.errorMessage : undefined,
    },
  };
}

export interface CommandDispatchMessage {
  commandId: string;
  command: string;
  input: unknown;
  deadlineAt: number;
}

export function buildCommandPayload(msg: CommandDispatchMessage): string {
  return JSON.stringify({
    commandId: msg.commandId,
    command: msg.command,
    input: msg.input ?? {},
    deadlineAt: msg.deadlineAt,
    issuedAt: Date.now(),
  });
}
