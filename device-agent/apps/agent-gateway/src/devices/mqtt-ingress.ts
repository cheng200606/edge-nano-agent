/**
 * MQTT 入口：把设备上行报文落到数据库。
 *
 * 对应真实源码：apps/agent-gateway/src/devices/mqtt-ingress.ts
 *
 * 设计要点：
 *   - 纯函数化（handleXxx），便于不连 broker 直接单测
 *   - **不自动创建产品**：仅凭主题里的 productId 就建产品是安全漏洞，
 *     产品必须由 API/配置显式创建；首次见到设备只做注册（幂等）
 *   - 任何一条坏报文都不能让链路挂掉：解析失败记 validation_error 事件后返回
 */
import {
  eventTopic,
  parseCommandResponsePayload,
  parseDeviceEventPayload,
  parseTelemetryPayload,
  resolveDeviceTopic,
  telemetryTopic,
} from "@device-agent/iot-platform/providers/default";
import type { DeviceService } from "@device-agent/persistence/device-service";

import type { Logger } from "../utils/logger";
import type { MqttLink } from "./mqtt-link";

export interface IngressDeps {
  service: DeviceService;
  logger: Logger;
  /** 收到命令回执时回调，由 CommandDispatcher 处理 */
  onCommandResponse?: (data: {
    productId: string;
    deviceId: string;
    commandId: string;
    ok: boolean;
    response?: unknown;
    errorCode?: string;
    errorMessage?: string;
  }) => void;
}

export interface IngressResult {
  handled: boolean;
  code?: string;
  message?: string;
}

function ensureDevice(
  deps: IngressDeps,
  productId: string,
  deviceId: string,
): IngressResult | null {
  try {
    deps.service.registerDevice(deviceId, productId);
    return null;
  } catch (err) {
    const code = (err as { code?: string }).code ?? "INGRESS_REGISTER_FAILED";
    const message = (err as Error).message;
    deps.logger.warn("ingress register failed", { productId, deviceId, code, message });
    return { handled: false, code, message };
  }
}

/** 遥测：注册设备（幂等）→ 影子更新状态 → 落 telemetry 事件。 */
export function handleTelemetryMessage(
  topic: string,
  payload: Buffer | string,
  deps: IngressDeps,
): IngressResult {
  const ids = resolveDeviceTopic(topic, "telemetry");
  if (!ids) return { handled: false, code: "UNKNOWN_TOPIC", message: topic };

  const parsed = parseTelemetryPayload(payload);
  if (!parsed.ok) {
    deps.service.logEvent({
      productId: ids.productId,
      deviceId: ids.deviceId,
      type: "validation_error",
      summary: parsed.error.code,
      detail: parsed.error as never,
    });
    return { handled: false, code: parsed.error.code, message: parsed.error.message };
  }

  const reg = ensureDevice(deps, ids.productId, ids.deviceId);
  if (reg) return reg;

  deps.service.updateStatus(ids.productId, ids.deviceId, "online", parsed.data.values);
  deps.service.logEvent({
    productId: ids.productId,
    deviceId: ids.deviceId,
    type: "telemetry",
    summary: Object.keys(parsed.data.values).join(","),
    detail: { ts: parsed.data.ts, values: parsed.data.values },
    source: "mqtt",
    occurredAt: parsed.data.ts,
  });
  return { handled: true };
}

/** 设备主动事件：info / alert / error。 */
export function handleDeviceEventMessage(
  topic: string,
  payload: Buffer | string,
  deps: IngressDeps,
): IngressResult {
  const ids = resolveDeviceTopic(topic, "event");
  if (!ids) return { handled: false, code: "UNKNOWN_TOPIC", message: topic };

  const parsed = parseDeviceEventPayload(payload);
  if (!parsed.ok) {
    deps.service.logEvent({
      productId: ids.productId,
      deviceId: ids.deviceId,
      type: "validation_error",
      summary: parsed.error.code,
      detail: parsed.error as never,
    });
    return { handled: false, code: parsed.error.code, message: parsed.error.message };
  }

  const reg = ensureDevice(deps, ids.productId, ids.deviceId);
  if (reg) return reg;

  deps.service.logEvent({
    productId: ids.productId,
    deviceId: ids.deviceId,
    type: "device_event",
    summary: parsed.data.eventName,
    detail: { eventType: parsed.data.eventType, payload: parsed.data.payload },
    source: "mqtt",
  });
  return { handled: true };
}

/** 命令回执：交给 dispatcher 回填台账。 */
export function handleCommandResponseMessage(
  topic: string,
  payload: Buffer | string,
  deps: IngressDeps,
): IngressResult {
  const ids = resolveDeviceTopic(topic, "responses");
  if (!ids) return { handled: false, code: "UNKNOWN_TOPIC", message: topic };

  const parsed = parseCommandResponsePayload(payload);
  if (!parsed.ok) {
    deps.logger.warn("invalid command response", { topic, code: parsed.error.code });
    return { handled: false, code: parsed.error.code, message: parsed.error.message };
  }

  deps.onCommandResponse?.({
    productId: ids.productId,
    deviceId: ids.deviceId,
    commandId: parsed.data.commandId,
    ok: parsed.data.ok,
    response: parsed.data.response,
    errorCode: parsed.data.errorCode,
    errorMessage: parsed.data.errorMessage,
  });
  return { handled: true };
}

/** 把三类上行主题挂到链路上。 */
export function attachIngress(link: MqttLink, deps: IngressDeps): void {
  link.subscribe("v1/+/+/telemetry", (topic, payload) => {
    handleTelemetryMessage(topic, payload, deps);
  });
  link.subscribe("v1/+/+/event", (topic, payload) => {
    handleDeviceEventMessage(topic, payload, deps);
  });
  link.subscribe("device-agent/+/device/+/responses", (topic, payload) => {
    handleCommandResponseMessage(topic, payload, deps);
  });
}

export { eventTopic, telemetryTopic };
