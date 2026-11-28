/**
 * MQTT 主题契约：模板、渲染、反解、通配。
 *
 * 对应真实源码：packages/shared/src/mqtt-topics.ts
 *
 * 设备侧固件通常由另一组人写，唯一能对齐的就是「主题字符串 + 报文结构」，
 * 所以主题必须做成模板，允许产品级覆盖。
 *
 * 历史兼容提醒（指南 2.4.1）：
 *   遥测/事件用 `v1/` 前缀，控制面用 `device-agent/` 前缀。
 *   这是早期固件把数据主题写死成 `v1/...` 留下的，不要"顺手统一"，
 *   否则存量设备全部掉线。
 */

export const DEFAULT_TOPIC_PREFIX = "device-agent";
export const DEFAULT_DEVICE_DATA_TOPIC_PREFIX = "v1";

/** 产品 ID 缺失时的占位段，避免生成 `//` 这种非法主题。 */
export const UNKNOWN_PRODUCT_TOPIC_SEGMENT = "_";

export const DEFAULT_MQTT_TOPIC_TEMPLATES = Object.freeze({
  productIn: "device-agent/{productId}/in",
  productOut: "device-agent/{productId}/out",
  deviceIn: "device-agent/{productId}/device/{deviceId}/in",
  deviceOut: "device-agent/{productId}/device/{deviceId}/out",
  deviceCommands: "device-agent/{productId}/device/{deviceId}/commands",
  deviceResponses: "device-agent/{productId}/device/{deviceId}/responses",
  deviceTelemetry: "v1/{productId}/{deviceId}/telemetry",
  deviceEvent: "v1/{productId}/{deviceId}/event",
  deviceNtpRequest: "device-agent/{productId}/device/{deviceId}/ntp/request",
  deviceNtpResponse: "device-agent/{productId}/device/{deviceId}/ntp/response",
} as const);

export type MqttTopicKey = keyof typeof DEFAULT_MQTT_TOPIC_TEMPLATES;

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

function normalizeSegment(seg: string, key: string): string {
  const v = seg.trim();
  if (!v) throw new Error(`Missing MQTT topic value for placeholder {${key}}`);
  if (v.includes("/")) {
    throw new Error(`Invalid MQTT topic value for {${key}}: contains "/"`);
  }
  return v;
}

/** 空值兜底：产品 ID 缺失时用 `_`，保证主题不会出现空段。 */
export function segmentOrUnknown(value: string | undefined | null): string {
  const v = (value ?? "").trim();
  return v ? v : UNKNOWN_PRODUCT_TOPIC_SEGMENT;
}

/**
 * 渲染主题。任一占位符缺失、为空、或值里含 `/` 都抛错——
 * 含 `/` 尤其危险：会订阅到别的产品的主题。
 */
export function renderTopic(template: string, values: Record<string, string>): string {
  return template
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(PLACEHOLDER, (_m, key: string) => {
      const v = values[key];
      if (typeof v === "string" && v.trim()) return normalizeSegment(v, key);
      throw new Error(`Missing MQTT topic placeholder value: ${key}`);
    });
}

export interface TopicCapture {
  [key: string]: string;
}

/** 反向匹配：topic → {productId, deviceId}，不匹配返回 null。 */
export function matchTopic(template: string, topic: string): TopicCapture | null {
  const t = template.split("/");
  const s = topic.split("/");
  if (t.length !== s.length) return null;
  const captured: TopicCapture = {};
  for (let i = 0; i < t.length; i += 1) {
    const m = t[i].match(/^\{([a-zA-Z0-9_]+)\}$/);
    if (m) {
      captured[m[1]] = s[i];
    } else if (t[i] !== s[i]) {
      return null;
    }
  }
  return captured;
}

/** 订阅用：缺失占位符替换为 MQTT 单层通配 `+`。 */
export function toWildcardTopic(template: string): string {
  return template.replace(PLACEHOLDER, "+");
}

/** 一次渲染某一类主题，便于调用点少写样板。 */
export function topicFor(
  key: MqttTopicKey,
  values: { productId?: string; deviceId?: string },
  templates: Record<string, string> = DEFAULT_MQTT_TOPIC_TEMPLATES,
): string {
  return renderTopic(templates[key], {
    productId: values.productId ?? "",
    deviceId: values.deviceId ?? "",
  });
}
