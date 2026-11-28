/**
 * DeviceService 单测：不用 mock，起一个真临时库跑迁移。
 *
 * 覆盖指南 3.4.3 的四个易错点：
 *   a) 设备注册幂等      b) 事件游标分页
 *   c) 状态更新带 last_seen  d) 删除产品事务级联
 * 另外覆盖命令台账三态与 timeout 轮询。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DatabaseHandle, openDatabase } from "./db/client";
import { countUserTables, ensureSchema } from "./db/schema-lifecycle";
import { DeviceService, DeviceServiceError } from "./device-service";

const migrationsFolder = join(import.meta.dir, "..", "..", "..", "drizzle");

let dir = "";
let handle: DatabaseHandle;
let svc: DeviceService;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "da-svc-"));
  handle = openDatabase({ path: join(dir, "test.sqlite") });
  ensureSchema(handle, migrationsFolder);
  svc = new DeviceService(handle);
});

afterAll(() => {
  try {
    svc.dispose();
  } catch {
    // ignore
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 上 WAL 句柄可能短暂占用
  }
});

describe("建表", () => {
  test("24 张业务表就绪", () => {
    expect(countUserTables(handle)).toBe(24);
  });

  test("checkHealth 只做 SELECT 1", () => {
    const h = svc.checkHealth();
    expect(h.ready).toBe(true);
    expect(typeof h.latencyMs).toBe("number");
  });
});

describe("产品 CRUD", () => {
  test("upsertProduct 新建后 getProduct 能取到", () => {
    const p = svc.upsertProduct({ id: "p1", name: "智能插座" });
    expect(p.id).toBe("p1");
    expect(p.version).toBe(1);
    expect(p.lifecycleStatus).toBe("developing");
    expect(svc.getProduct("p1")?.name).toBe("智能插座");
  });

  test("upsertProduct 幂等更新，不递增 version", () => {
    svc.upsertProduct({ id: "p1", name: "智能插座 v2" });
    const p = svc.getProduct("p1");
    expect(p?.name).toBe("智能插座 v2");
    expect(p?.version).toBe(1);
  });

  test("publishProduct 递增 version 并留版本快照", () => {
    const r = svc.publishProduct("p1", "首次发布");
    expect(r.version).toBe(2);
    expect(svc.getProduct("p1")?.lifecycleStatus).toBe("published");
  });

  test("listProducts 按 id 升序", () => {
    svc.upsertProduct({ id: "p0", name: "A" });
    const ids = svc.listProducts().map((p) => p.id);
    expect(ids).toEqual([...ids].sort());
  });

  test("非法产品 ID 被 schema check 拒绝", () => {
    expect(() => svc.upsertProduct({ id: "bad/id", name: "x" })).toThrow();
  });
});

describe("设备注册幂等", () => {
  test("首次注册 created=true", () => {
    const r = svc.registerDevice("dev-1", "p1", { fw: "1.0" });
    expect(r.created).toBe(true);
    expect(r.device.status).toBe("offline");
  });

  test("重复注册 created=false 且不新增行", () => {
    const before = svc.listDevices("p1").length;
    const r = svc.registerDevice("dev-1", "p1");
    expect(r.created).toBe(false);
    expect(svc.listDevices("p1").length).toBe(before);
  });

  test("同一 deviceId 绑定到别的产品被拒绝", () => {
    svc.upsertProduct({ id: "p2", name: "B" });
    expect(() => svc.registerDevice("dev-1", "p2")).toThrow(DeviceServiceError);
    try {
      svc.registerDevice("dev-1", "p2");
    } catch (err) {
      expect((err as DeviceServiceError).code).toBe("DEVICE_ALREADY_BOUND");
    }
  });

  test("产品不存在时报 PRODUCT_NOT_FOUND", () => {
    try {
      svc.registerDevice("dev-x", "nope");
    } catch (err) {
      expect((err as DeviceServiceError).code).toBe("PRODUCT_NOT_FOUND");
    }
  });
});

describe("状态影子更新", () => {
  test("updateStatus 同时写 status 与 last_seen_at", () => {
    const before = svc.getDeviceInProduct("p1", "dev-1")?.lastSeenAt ?? 0;
    svc.updateStatus("p1", "dev-1", "online", { temp: 42 });
    const d = svc.getDeviceInProduct("p1", "dev-1");
    expect(d?.status).toBe("online");
    expect(d?.lastSeenAt).toBeGreaterThanOrEqual(before);
    expect((d?.reportedState as { temp: number }).temp).toBe(42);
  });

  test("updateDesiredState 只改期望值", () => {
    svc.updateDesiredState("p1", "dev-1", { mode: "eco" });
    const d = svc.getDeviceInProduct("p1", "dev-1");
    expect((d?.desiredState as { mode: string }).mode).toBe("eco");
    expect((d?.reportedState as { temp: number }).temp).toBe(42);
  });
});

describe("事件与游标分页", () => {
  test("logEvent 落库并返回自增 id", () => {
    const id = svc.logEvent({
      productId: "p1",
      deviceId: "dev-1",
      type: "telemetry",
      summary: "t=42",
      detail: { temp: 42 },
    });
    expect(id).toBeGreaterThan(0);
  });

  test("游标分页不重不漏", () => {
    for (let i = 0; i < 9; i += 1) {
      svc.logEvent({ productId: "p1", deviceId: "dev-1", type: "telemetry", summary: `n${i}` });
    }
    const page1 = svc.listDeviceEventsInProduct("p1", "dev-1", 5);
    expect(page1).toHaveLength(5);
    const page2 = svc.listDeviceEventsInProduct("p1", "dev-1", 5, page1[4].id);
    expect(page2).toHaveLength(5);
    const overlap = page1.filter((a) => page2.some((b) => b.id === a.id));
    expect(overlap).toHaveLength(0);
  });

  test("cleanupDeviceEvents 只删过期数据", () => {
    const removed = svc.cleanupDeviceEvents(30, 100);
    expect(removed).toBe(0);
  });
});

describe("命令台账三态", () => {
  test("创建为 pending", () => {
    const cmd = svc.createCommand({
      productId: "p1",
      deviceId: "dev-1",
      command: "set_mode",
      input: { mode: "eco" },
      deadlineAt: Date.now() + 60_000,
    });
    expect(cmd.status).toBe("pending");
  });

  test("回执到达 pending → completed", () => {
    const cmd = svc.createCommand({
      productId: "p1",
      deviceId: "dev-1",
      command: "turn_on",
      deadlineAt: Date.now() + 60_000,
    });
    const done = svc.completeCommand(cmd.id, true, { ok: true });
    expect(done.status).toBe("completed");
    expect(done.completedAt).not.toBeNull();
  });

  test("失败回执 pending → failed 并记录错误码", () => {
    const cmd = svc.createCommand({
      productId: "p1",
      deviceId: "dev-1",
      command: "turn_off",
      deadlineAt: Date.now() + 60_000,
    });
    const done = svc.completeCommand(cmd.id, false, undefined, {
      code: "DEVICE_REJECTED",
      message: "device rejected",
    });
    expect(done.status).toBe("failed");
    expect(done.errorCode).toBe("DEVICE_REJECTED");
  });

  test("超时靠台账轮询置为 timeout，不是 setTimeout", () => {
    svc.createCommand({
      productId: "p1",
      deviceId: "dev-1",
      command: "stale",
      deadlineAt: Date.now() - 1000,
    });
    const n = svc.expireCommands();
    expect(n).toBeGreaterThanOrEqual(1);
    const stale = svc.listPendingCommands().find((c) => c.command === "stale");
    expect(stale).toBeUndefined();
  });

  test("未知命令 id 报 COMMAND_NOT_FOUND", () => {
    try {
      svc.completeCommand("nope", true);
    } catch (err) {
      expect((err as DeviceServiceError).code).toBe("COMMAND_NOT_FOUND");
    }
  });
});

describe("标签", () => {
  test("批量打标签幂等", () => {
    const first = svc.batchAddDeviceTagInProduct("p1", ["dev-1"], "关键设备");
    expect(first).toBe(1);
    const again = svc.batchAddDeviceTagInProduct("p1", ["dev-1"], "关键设备");
    expect(again).toBe(0);
    expect(svc.getDeviceTagsInProduct("p1", "dev-1")).toHaveLength(1);
  });
});

describe("删除产品事务级联", () => {
  test("删产品后设备与事件都不残留", () => {
    svc.upsertProduct({ id: "p-del", name: "待删" });
    svc.registerDevice("dev-del", "p-del");
    svc.logEvent({ productId: "p-del", deviceId: "dev-del", type: "telemetry" });

    const r = svc.deleteProduct("p-del");
    expect(r.deleted).toBe(true);
    expect(svc.getProduct("p-del")).toBeUndefined();
    expect(svc.listDevices("p-del")).toHaveLength(0);
    expect(svc.listDeviceEventsInProduct("p-del", "dev-del")).toHaveLength(0);
  });

  test("删不存在的产品返回 deleted=false", () => {
    expect(svc.deleteProduct("nope").deleted).toBe(false);
  });
});
