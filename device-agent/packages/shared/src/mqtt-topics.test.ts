import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MQTT_TOPIC_TEMPLATES,
  matchTopic,
  renderTopic,
  segmentOrUnknown,
  topicFor,
  toWildcardTopic,
} from "./mqtt-topics";

describe("主题模板", () => {
  test("共 10 个默认模板", () => {
    expect(Object.keys(DEFAULT_MQTT_TOPIC_TEMPLATES)).toHaveLength(10);
  });

  test("遥测/事件用 v1 前缀，控制面用 device-agent 前缀（历史兼容）", () => {
    expect(DEFAULT_MQTT_TOPIC_TEMPLATES.deviceTelemetry.startsWith("v1/")).toBe(true);
    expect(DEFAULT_MQTT_TOPIC_TEMPLATES.deviceEvent.startsWith("v1/")).toBe(true);
    expect(DEFAULT_MQTT_TOPIC_TEMPLATES.deviceCommands.startsWith("device-agent/")).toBe(true);
  });
});

describe("renderTopic", () => {
  test("渲染设备遥测主题", () => {
    const topic = renderTopic(DEFAULT_MQTT_TOPIC_TEMPLATES.deviceTelemetry, {
      productId: "p1",
      deviceId: "d1",
    });
    expect(topic).toBe("v1/p1/d1/telemetry");
  });

  test("占位符值含 / 时抛错（否则会订阅到别人的产品）", () => {
    expect(() =>
      renderTopic(DEFAULT_MQTT_TOPIC_TEMPLATES.deviceTelemetry, {
        productId: "p/evil",
        deviceId: "d1",
      }),
    ).toThrow(/contains "\/"/);
  });

  test("占位符缺失或为空时抛错", () => {
    expect(() =>
      renderTopic(DEFAULT_MQTT_TOPIC_TEMPLATES.deviceTelemetry, { productId: "p1" }),
    ).toThrow(/Missing MQTT topic placeholder value/);
    // 纯空白视同"未提供值"，走占位符缺失分支
    expect(() =>
      renderTopic(DEFAULT_MQTT_TOPIC_TEMPLATES.deviceTelemetry, {
        productId: "  ",
        deviceId: "d1",
      }),
    ).toThrow(/Missing MQTT topic placeholder value/);
  });

  test("首尾多余的 / 被裁掉", () => {
    expect(renderTopic("/a/{x}/b/", { x: "1" })).toBe("a/1/b");
  });

  test("topicFor 便捷入口", () => {
    expect(topicFor("deviceCommands", { productId: "p1", deviceId: "d1" })).toBe(
      "device-agent/p1/device/d1/commands",
    );
  });
});

describe("matchTopic", () => {
  test("从通配订阅收到的主题反解出 productId / deviceId", () => {
    const captured = matchTopic("v1/{productId}/{deviceId}/telemetry", "v1/p1/d1/telemetry");
    expect(captured).toEqual({ productId: "p1", deviceId: "d1" });
  });

  test("段数不同返回 null", () => {
    expect(matchTopic("v1/{productId}/{deviceId}/telemetry", "v1/p1/d1")).toBeNull();
  });

  test("固定段不一致返回 null", () => {
    expect(matchTopic("v1/{productId}/{deviceId}/telemetry", "v1/p1/d1/event")).toBeNull();
  });
});

describe("空产品 ID 兜底", () => {
  test("segmentOrUnknown 把空值换成 _，不会产生 // 非法主题", () => {
    expect(segmentOrUnknown("")).toBe("_");
    expect(segmentOrUnknown(undefined)).toBe("_");
    expect(segmentOrUnknown("  ")).toBe("_");
    expect(segmentOrUnknown("p1")).toBe("p1");
  });

  test("用 _ 兜底后主题仍然合法", () => {
    const topic = renderTopic(DEFAULT_MQTT_TOPIC_TEMPLATES.deviceTelemetry, {
      productId: segmentOrUnknown(""),
      deviceId: "d1",
    });
    expect(topic).toBe("v1/_/d1/telemetry");
    expect(topic.includes("//")).toBe(false);
  });
});

describe("通配", () => {
  test("所有占位符替换为 +", () => {
    expect(toWildcardTopic(DEFAULT_MQTT_TOPIC_TEMPLATES.deviceTelemetry)).toBe("v1/+/+/telemetry");
    expect(toWildcardTopic(DEFAULT_MQTT_TOPIC_TEMPLATES.deviceCommands)).toBe(
      "device-agent/+/device/+/commands",
    );
  });
});
