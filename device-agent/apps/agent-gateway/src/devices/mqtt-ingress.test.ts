/**
 * MQTT 入口单测：不连 broker，直接喂 topic + payload。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DatabaseHandle, openDatabase } from "@device-agent/persistence/db/client";
import { ensureSchema } from "@device-agent/persistence/db/schema-lifecycle";
import { DeviceService } from "@device-agent/persistence/device-service";
import { configureLogging, createLogger } from "../utils/logger";
import {
  handleCommandResponseMessage,
  handleDeviceEventMessage,
  handleTelemetryMessage,
  type IngressDeps,
} from "./mqtt-ingress";

const migrationsFolder = join(import.meta.dir, "..", "..", "..", "..", "drizzle");

let dir = "";
let handle: DatabaseHandle;
let service: DeviceService;
let deps: IngressDeps;
const responses: { commandId: string; ok: boolean }[] = [];

beforeAll(() => {
  configureLogging({ level: "error", console: false, file: false });
  dir = mkdtempSync(join(tmpdir(), "da-ingress-"));
  handle = openDatabase({ path: join(dir, "t.sqlite") });
  ensureSchema(handle, migrationsFolder);
  service = new DeviceService(handle);
  service.upsertProduct({ id: "p1", name: "智能插座" });
  deps = {
    service,
    logger: createLogger("TestIngress"),
    onCommandResponse: (r) => responses.push({ commandId: r.commandId, ok: r.ok }),
  };
});

afterAll(() => {
  try {
    service.dispose();
  } catch {
    // ignore
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("遥测入口", () => {
  test("首见设备自动注册并写在线状态", () => {
    const r = handleTelemetryMessage(
      "v1/p1/dev-9/telemetry",
      JSON.stringify({ ts: 1700000000000, values: { temp: 25.5 } }),
      deps,
    );
    expect(r.handled).toBe(true);
    const d = service.getDeviceInProduct("p1", "dev-9");
    expect(d).toBeDefined();
    expect(d?.status).toBe("online");
    expect((d?.reportedState as { temp?: number } | undefined)?.temp).toBe(25.5);
  });

  test("落 telemetry 事件", () => {
    const events = service.listDeviceEventsInProduct("p1", "dev-9");
    expect(events.some((e) => e.type === "telemetry")).toBe(true);
  });

  test("坏 JSON 落 validation_error 且不抛异常", () => {
    const r = handleTelemetryMessage("v1/p1/dev-9/telemetry", "{not json", deps);
    expect(r.handled).toBe(false);
    expect(r.code).toBe("MQTT_PAYLOAD_INVALID_JSON");
    const events = service.listDeviceEventsInProduct("p1", "dev-9");
    expect(events.some((e) => e.type === "validation_error")).toBe(true);
  });

  test("values 不是对象被拒绝", () => {
    const r = handleTelemetryMessage(
      "v1/p1/dev-9/telemetry",
      JSON.stringify({ values: [1, 2] }),
      deps,
    );
    expect(r.code).toBe("TELEMETRY_VALUES_NOT_OBJECT");
  });

  test("未知主题返回 UNKNOWN_TOPIC", () => {
    const r = handleTelemetryMessage("v2/p1/dev-9/telemetry", "{}", deps);
    expect(r.code).toBe("UNKNOWN_TOPIC");
  });

  test("产品不存在时记 register 失败，不凭空建产品", () => {
    const r = handleTelemetryMessage(
      "v1/ghost/dev-1/telemetry",
      JSON.stringify({ values: { temp: 1 } }),
      deps,
    );
    expect(r.handled).toBe(false);
    expect(r.code).toBe("PRODUCT_NOT_FOUND");
    expect(service.getProduct("ghost")).toBeUndefined();
  });
});

describe("设备事件入口", () => {
  test("alert 事件落 device_event", () => {
    const r = handleDeviceEventMessage(
      "v1/p1/dev-9/event",
      JSON.stringify({ event: "door_open", type: "alert", payload: { by: "key" } }),
      deps,
    );
    expect(r.handled).toBe(true);
    const events = service.listDeviceEventsInProduct("p1", "dev-9");
    const alert = events.find((e) => e.summary === "door_open");
    expect(alert?.type).toBe("device_event");
  });

  test("缺事件名被拒绝", () => {
    const r = handleDeviceEventMessage("v1/p1/dev-9/event", JSON.stringify({ type: "info" }), deps);
    expect(r.code).toBe("EVENT_NAME_MISSING");
  });
});

describe("命令回执入口", () => {
  test("合法回执触发回调", () => {
    const before = responses.length;
    const r = handleCommandResponseMessage(
      "device-agent/p1/device/dev-9/responses",
      JSON.stringify({ commandId: "cmd-x", ok: true, response: { done: true } }),
      deps,
    );
    expect(r.handled).toBe(true);
    expect(responses.length).toBe(before + 1);
    expect(responses.at(-1)?.commandId).toBe("cmd-x");
  });

  test("缺 commandId 被拒绝", () => {
    const r = handleCommandResponseMessage(
      "device-agent/p1/device/dev-9/responses",
      JSON.stringify({ ok: true }),
      deps,
    );
    expect(r.code).toBe("RESPONSE_COMMAND_ID_MISSING");
  });
});
