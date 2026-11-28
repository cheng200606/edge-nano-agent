/**
 * 命令台账单测：用桩替代 MqttLink，验证"下发成功 ≠ completed"。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DatabaseHandle, openDatabase } from "@device-agent/persistence/db/client";
import { ensureSchema } from "@device-agent/persistence/db/schema-lifecycle";
import { DeviceService } from "@device-agent/persistence/device-service";
import { configureLogging, createLogger } from "../utils/logger";
import { CommandDispatcher } from "./command-dispatcher";
import type { MqttLink } from "./mqtt-link";

const migrationsFolder = join(import.meta.dir, "..", "..", "..", "..", "drizzle");

interface Published {
  topic: string;
  payload: string;
}

let dir = "";
let handle: DatabaseHandle;
let service: DeviceService;
let published: Published[] = [];
let connected = true;

function stubLink(): MqttLink {
  return {
    publish: (topic: string, payload: string) => {
      if (!connected) return false;
      published.push({ topic, payload });
      return true;
    },
    isReady: () => connected,
  } as unknown as MqttLink;
}

beforeAll(() => {
  configureLogging({ level: "error", console: false, file: false });
  dir = mkdtempSync(join(tmpdir(), "da-disp-"));
  handle = openDatabase({ path: join(dir, "t.sqlite") });
  ensureSchema(handle, migrationsFolder);
  service = new DeviceService(handle);
  service.upsertProduct({ id: "p1", name: "插座" });
  service.registerDevice("dev-1", "p1");
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

describe("send", () => {
  test("发布成功时台账仍是 pending（下发成功 ≠ completed）", () => {
    published = [];
    connected = true;
    const d = new CommandDispatcher(service, stubLink(), createLogger("D"));
    const r = d.send({
      productId: "p1",
      deviceId: "dev-1",
      command: "set_mode",
      input: { mode: "eco" },
      timeoutMs: 60_000,
    });
    expect(r.published).toBe(true);
    expect(published).toHaveLength(1);
    expect(published[0].topic).toBe("device-agent/p1/device/dev-1/commands");
    const row = service.getCommand(r.commandId);
    expect(row?.status).toBe("pending");
    expect(row?.command).toBe("set_mode");
  });

  test("下发报文含 commandId 与 deadlineAt", () => {
    const body = JSON.parse(published[0].payload) as {
      commandId: string;
      command: string;
      deadlineAt: number;
    };
    expect(body.commandId.startsWith("cmd-")).toBe(true);
    expect(body.command).toBe("set_mode");
    expect(body.deadlineAt).toBeGreaterThan(Date.now());
  });

  test("MQTT 断开时台账照样建，published=false", () => {
    connected = false;
    const d = new CommandDispatcher(service, stubLink(), createLogger("D"));
    const r = d.send({ productId: "p1", deviceId: "dev-1", command: "turn_on" });
    expect(r.published).toBe(false);
    expect(service.getCommand(r.commandId)?.status).toBe("pending");
    connected = true;
  });
});

describe("handleResponse", () => {
  test("回执到达 pending → completed 并落 command_response 事件", () => {
    published = [];
    const d = new CommandDispatcher(service, stubLink(), createLogger("D"));
    const r = d.send({ productId: "p1", deviceId: "dev-1", command: "turn_on" });
    d.handleResponse({ productId: "p1", deviceId: "dev-1", commandId: r.commandId, ok: true });
    expect(service.getCommand(r.commandId)?.status).toBe("completed");
    const events = service.listDeviceEventsInProduct("p1", "dev-1", 20);
    expect(events.some((e) => e.type === "command_response")).toBe(true);
  });

  test("失败回执 pending → failed 记错误码", () => {
    published = [];
    const d = new CommandDispatcher(service, stubLink(), createLogger("D"));
    const r = d.send({ productId: "p1", deviceId: "dev-1", command: "explode" });
    d.handleResponse({
      productId: "p1",
      deviceId: "dev-1",
      commandId: r.commandId,
      ok: false,
      errorCode: "SIM_REJECTED",
      errorMessage: "boom",
    });
    const row = service.getCommand(r.commandId);
    expect(row?.status).toBe("failed");
    expect(row?.errorCode).toBe("SIM_REJECTED");
  });

  test("未知 commandId 只记 warn，不抛", () => {
    const d = new CommandDispatcher(service, stubLink(), createLogger("D"));
    expect(() =>
      d.handleResponse({ productId: "p1", deviceId: "dev-1", commandId: "nope", ok: true }),
    ).not.toThrow();
  });
});

describe("sweepTimeouts", () => {
  test("超时命令被轮询收敛为 timeout", () => {
    published = [];
    const d = new CommandDispatcher(service, stubLink(), createLogger("D"));
    const r = d.send({ productId: "p1", deviceId: "dev-1", command: "slow", timeoutMs: 1 });
    // 等 10ms 让 deadline 过期
    const until = Date.now() + 10;
    while (Date.now() < until) {
      // busy wait
    }
    const n = d.sweepTimeouts();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(service.getCommand(r.commandId)?.status).toBe("timeout");
  });
});
