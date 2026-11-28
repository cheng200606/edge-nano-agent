/**
 * DeviceService：24 张表的唯一数据入口。
 *
 * 对应真实源码：packages/persistence/src/device-service.ts
 *
 * 职责边界（指南 3.4.1）：只做「读 / 写 / 事务」，**不含业务规则**。
 * 业务（注册编排、命令下发、同步策略）属于 DeviceOperations（第 4 章）。
 *
 * 实现说明：bun:sqlite 是同步 API，因此方法全部同步，调用方无需 await。
 * 四个容易写错的细节（指南 3.4.3）都在这里落地：
 *   a) registerDevice 幂等     b) 事件分页用 id 游标而非 offset
 *   c) 状态更新必须带 last_seen  d) deleteProduct 事务级联
 */
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";

import type { DatabaseHandle } from "./db/client";
import { deviceCommands } from "./db/schema-commands";
import {
  deviceEvents,
  devices,
  deviceTags,
  products,
  productVersions,
  tags,
} from "./db/schema-core";

export const DEVICE_SERVICE_ERRORS = {
  PRODUCT_NOT_FOUND: "PRODUCT_NOT_FOUND",
  DEVICE_NOT_FOUND: "DEVICE_NOT_FOUND",
  DEVICE_ALREADY_BOUND: "DEVICE_ALREADY_BOUND",
  COMMAND_NOT_FOUND: "COMMAND_NOT_FOUND",
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
} as const;

export type DeviceServiceErrorCode =
  (typeof DEVICE_SERVICE_ERRORS)[keyof typeof DEVICE_SERVICE_ERRORS];

export class DeviceServiceError extends Error {
  readonly code: DeviceServiceErrorCode;

  constructor(code: DeviceServiceErrorCode, message: string) {
    super(message);
    this.name = "DeviceServiceError";
    this.code = code;
  }
}

export interface ProductInput {
  id: string;
  name: string;
  description?: string;
  deviceSpec?: unknown;
  metadata?: unknown;
  iotPlatformProviderId?: string;
  lifecycleStatus?: string;
}

export type ProductRow = typeof products.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
export type DeviceEventRow = typeof deviceEvents.$inferSelect;
export type DeviceCommandRow = typeof deviceCommands.$inferSelect;

export interface RegisterDeviceResult {
  created: boolean;
  device: DeviceRow;
}

export interface LogEventInput {
  productId: string;
  deviceId: string;
  type: string;
  summary?: string;
  detail?: unknown;
  namespace?: string;
  source?: string;
  occurredAt?: number;
}

export interface CreateCommandInput {
  productId: string;
  deviceId: string;
  command: string;
  input?: unknown;
  requestedBy?: string;
  /** 回执截止时刻（毫秒时间戳）；台账轮询据此判 timeout */
  deadlineAt: number;
  sentAt?: number;
}

const nowMs = () => Date.now();

export class DeviceService {
  private readonly handle: DatabaseHandle;

  constructor(handle: DatabaseHandle) {
    this.handle = handle;
  }

  private get db() {
    return this.handle.db;
  }

  // ---------------------------------------------------------------- 产品

  listProducts(): ProductRow[] {
    return this.db.select().from(products).orderBy(asc(products.id)).all();
  }

  getProduct(id: string): ProductRow | undefined {
    return this.db.select().from(products).where(eq(products.id, id)).get();
  }

  /** 幂等写入：已存在则更新可编辑字段，不覆盖 version。 */
  upsertProduct(input: ProductInput): ProductRow {
    const existing = this.getProduct(input.id);
    if (existing) {
      this.db
        .update(products)
        .set({
          name: input.name,
          description: input.description ?? existing.description,
          deviceSpec: (input.deviceSpec ?? existing.deviceSpec) as never,
          metadata: (input.metadata ?? existing.metadata) as never,
          iotPlatformProviderId: input.iotPlatformProviderId ?? existing.iotPlatformProviderId,
          lifecycleStatus: input.lifecycleStatus ?? existing.lifecycleStatus,
          updatedAt: nowMs(),
        })
        .where(eq(products.id, input.id))
        .run();
      return this.getProduct(input.id) as ProductRow;
    }

    this.db
      .insert(products)
      .values({
        id: input.id,
        name: input.name,
        description: input.description ?? "",
        deviceSpec: (input.deviceSpec ?? {}) as never,
        metadata: (input.metadata ?? {}) as never,
        iotPlatformProviderId: input.iotPlatformProviderId ?? "default",
        lifecycleStatus: input.lifecycleStatus ?? "developing",
        version: 1,
        createdAt: nowMs(),
        updatedAt: nowMs(),
      })
      .run();
    return this.getProduct(input.id) as ProductRow;
  }

  /** 发布产品：version + 1 并留一条版本快照（A2A 卡片刷新靠 version）。 */
  publishProduct(productId: string, note = ""): { version: number } {
    const existing = this.getProduct(productId);
    if (!existing) {
      throw new DeviceServiceError(
        DEVICE_SERVICE_ERRORS.PRODUCT_NOT_FOUND,
        `product not found: ${productId}`,
      );
    }
    const nextVersion = existing.version + 1;
    this.db.transaction((tx) => {
      tx.update(products)
        .set({ version: nextVersion, lifecycleStatus: "published", updatedAt: nowMs() })
        .where(eq(products.id, productId))
        .run();
      tx.insert(productVersions)
        .values({
          id: `${productId}-v${nextVersion}`,
          productId,
          version: nextVersion,
          deviceSpec: existing.deviceSpec as never,
          note,
          createdAt: nowMs(),
        })
        .run();
    });
    return { version: nextVersion };
  }

  /**
   * 删除产品：事务级联。
   * 即便开了 foreign_keys=ON，也显式删除并写测试——SQLite 的 CASCADE
   * 需要建表时就声明，后加很麻烦，显式删除更可靠。
   */
  deleteProduct(productId: string): { deleted: boolean } {
    if (!this.getProduct(productId)) return { deleted: false };
    this.db.transaction((tx) => {
      tx.delete(deviceEvents).where(eq(deviceEvents.productId, productId)).run();
      tx.delete(deviceCommands).where(eq(deviceCommands.productId, productId)).run();
      tx.delete(deviceTags).where(eq(deviceTags.productId, productId)).run();
      tx.delete(devices).where(eq(devices.productId, productId)).run();
      tx.delete(productVersions).where(eq(productVersions.productId, productId)).run();
      tx.delete(products).where(eq(products.id, productId)).run();
    });
    return { deleted: true };
  }

  // ---------------------------------------------------------------- 设备

  listDevices(productId: string): DeviceRow[] {
    return this.db.select().from(devices).where(eq(devices.productId, productId)).all();
  }

  getDeviceInProduct(productId: string, deviceId: string): DeviceRow | undefined {
    return this.db
      .select()
      .from(devices)
      .where(and(eq(devices.productId, productId), eq(devices.id, deviceId)))
      .get();
  }

  /** 全局按 deviceId 找（deviceId 不能跨产品复用，正常只会有一条）。 */
  findDeviceById(deviceId: string): DeviceRow | undefined {
    return this.db.select().from(devices).where(eq(devices.id, deviceId)).get();
  }

  /**
   * 注册设备：必须幂等。
   * MQTT 设备每次重连都会触发"首见"，不幂等会让设备表指数增长。
   */
  registerDevice(deviceId: string, productId: string, metadata?: unknown): RegisterDeviceResult {
    if (!deviceId || !productId) {
      throw new DeviceServiceError(
        DEVICE_SERVICE_ERRORS.INVALID_ARGUMENT,
        "deviceId and productId are required",
      );
    }
    const product = this.getProduct(productId);
    if (!product) {
      throw new DeviceServiceError(
        DEVICE_SERVICE_ERRORS.PRODUCT_NOT_FOUND,
        `product not found: ${productId}`,
      );
    }

    const existing = this.findDeviceById(deviceId);
    if (existing) {
      if (existing.productId !== productId) {
        throw new DeviceServiceError(
          DEVICE_SERVICE_ERRORS.DEVICE_ALREADY_BOUND,
          `device ${deviceId} already bound to product ${existing.productId}`,
        );
      }
      this.updateLastSeen(productId, deviceId, metadata);
      return { created: false, device: this.getDeviceInProduct(productId, deviceId) as DeviceRow };
    }

    this.db
      .insert(devices)
      .values({
        id: deviceId,
        productId,
        name: deviceId,
        status: "offline",
        reportedState: {} as never,
        desiredState: {} as never,
        metadata: (metadata ?? {}) as never,
        lastSeenAt: nowMs(),
        createdAt: nowMs(),
        updatedAt: nowMs(),
      })
      .onConflictDoNothing()
      .run();

    return {
      created: true,
      device: this.getDeviceInProduct(productId, deviceId) as DeviceRow,
    };
  }

  /** 影子更新：状态 + 上报值 + last_seen_at 必须一起写（否则出现"在线但 3 小时前上报"）。 */
  updateStatus(
    productId: string,
    deviceId: string,
    status: "online" | "offline" | "error",
    reportedState?: unknown,
    metadata?: unknown,
    lastSeenAt = nowMs(),
  ): void {
    this.db
      .update(devices)
      .set({
        status,
        ...(reportedState !== undefined ? { reportedState: reportedState as never } : {}),
        ...(metadata !== undefined ? { metadata: metadata as never } : {}),
        lastSeenAt,
        updatedAt: nowMs(),
      })
      .where(and(eq(devices.productId, productId), eq(devices.id, deviceId)))
      .run();
  }

  updateReportedState(productId: string, deviceId: string, state: unknown): void {
    this.db
      .update(devices)
      .set({ reportedState: state as never, updatedAt: nowMs() })
      .where(and(eq(devices.productId, productId), eq(devices.id, deviceId)))
      .run();
  }

  updateDesiredState(productId: string, deviceId: string, state: unknown): void {
    this.db
      .update(devices)
      .set({ desiredState: state as never, updatedAt: nowMs() })
      .where(and(eq(devices.productId, productId), eq(devices.id, deviceId)))
      .run();
  }

  updateLastSeen(productId: string, deviceId: string, metadata?: unknown): void {
    this.db
      .update(devices)
      .set({
        lastSeenAt: nowMs(),
        ...(metadata !== undefined ? { metadata: metadata as never } : {}),
        updatedAt: nowMs(),
      })
      .where(and(eq(devices.productId, productId), eq(devices.id, deviceId)))
      .run();
  }

  // ---------------------------------------------------------------- 事件

  logEvent(input: LogEventInput): number {
    const result = this.db
      .insert(deviceEvents)
      .values({
        productId: input.productId,
        deviceId: input.deviceId,
        namespace: input.namespace ?? "",
        type: input.type,
        summary: input.summary ?? "",
        detail: (input.detail ?? {}) as never,
        source: input.source ?? "",
        occurredAt: input.occurredAt ?? nowMs(),
        createdAt: nowMs(),
      })
      .run();
    return Number(result.lastInsertRowid ?? 0);
  }

  /** 游标分页：beforeId 传上一页最后一条 id，不用 offset。 */
  listDeviceEventsInProduct(
    productId: string,
    deviceId: string,
    limit = 50,
    beforeId?: number,
  ): DeviceEventRow[] {
    const conditions = [eq(deviceEvents.productId, productId), eq(deviceEvents.deviceId, deviceId)];
    if (beforeId !== undefined) conditions.push(lt(deviceEvents.id, beforeId));
    return this.db
      .select()
      .from(deviceEvents)
      .where(and(...conditions))
      .orderBy(desc(deviceEvents.id))
      .limit(limit)
      .all();
  }

  /** 按天清理：分批删，避免一次删太多把库锁住。 */
  cleanupDeviceEvents(retentionDays = 30, batchSize = 1000): number {
    const cutoff = nowMs() - retentionDays * 24 * 60 * 60 * 1000;
    const result = this.db
      .delete(deviceEvents)
      .where(
        sql`${deviceEvents.id} IN (
          SELECT id FROM ${deviceEvents} WHERE ${deviceEvents.createdAt} < ${cutoff} LIMIT ${batchSize}
        )`,
      )
      .run();
    return Number(result.changes ?? 0);
  }

  // ---------------------------------------------------------------- 命令台账

  createCommand(input: CreateCommandInput): DeviceCommandRow {
    const id = `cmd-${nowMs().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const sentAt = input.sentAt ?? nowMs();
    this.db
      .insert(deviceCommands)
      .values({
        id,
        productId: input.productId,
        deviceId: input.deviceId,
        command: input.command,
        input: (input.input ?? {}) as never,
        status: "pending",
        requestedBy: input.requestedBy ?? "",
        sentAt,
        deadlineAt: input.deadlineAt,
        createdAt: nowMs(),
      })
      .onConflictDoNothing()
      .run();
    return this.getCommand(id) as DeviceCommandRow;
  }

  getCommand(id: string): DeviceCommandRow | undefined {
    return this.db.select().from(deviceCommands).where(eq(deviceCommands.id, id)).get();
  }

  listPendingCommands(limit = 100): DeviceCommandRow[] {
    return this.db
      .select()
      .from(deviceCommands)
      .where(eq(deviceCommands.status, "pending"))
      .orderBy(asc(deviceCommands.deadlineAt))
      .limit(limit)
      .all();
  }

  /** 回执到达：pending → completed / failed。 */
  completeCommand(
    id: string,
    ok: boolean,
    response?: unknown,
    error?: { code?: string; message?: string },
  ): DeviceCommandRow {
    const existing = this.getCommand(id);
    if (!existing) {
      throw new DeviceServiceError(
        DEVICE_SERVICE_ERRORS.COMMAND_NOT_FOUND,
        `command not found: ${id}`,
      );
    }
    this.db
      .update(deviceCommands)
      .set({
        status: ok ? "completed" : "failed",
        response: (response ?? null) as never,
        errorCode: error?.code ?? null,
        errorMessage: error?.message ?? null,
        completedAt: nowMs(),
      })
      .where(eq(deviceCommands.id, id))
      .run();
    return this.getCommand(id) as DeviceCommandRow;
  }

  /**
   * 把超时未回执的命令置为 timeout。
   * **靠台账轮询判定，不用 setTimeout** —— 进程重启后 setTimeout 会丢，
   * 台账状态才是唯一事实来源。
   */
  expireCommands(now = nowMs()): number {
    const result = this.db
      .update(deviceCommands)
      .set({ status: "timeout", completedAt: now })
      .where(and(eq(deviceCommands.status, "pending"), lt(deviceCommands.deadlineAt, now)))
      .run();
    return Number(result.changes ?? 0);
  }

  // ---------------------------------------------------------------- 标签

  getDeviceTagsInProduct(productId: string, deviceId: string): string[] {
    const rows = this.db
      .select({ tagId: deviceTags.tagId })
      .from(deviceTags)
      .where(and(eq(deviceTags.productId, productId), eq(deviceTags.deviceId, deviceId)))
      .all();
    return rows.map((r) => r.tagId);
  }

  batchAddDeviceTagInProduct(productId: string, deviceIds: string[], tagName: string): number {
    const tag = this.db.select().from(tags).where(eq(tags.name, tagName)).get();
    const tagId = tag?.id ?? `tag-${tagName}`;
    if (!tag) {
      this.db
        .insert(tags)
        .values({ id: tagId, name: tagName, color: "", createdAt: nowMs() })
        .onConflictDoNothing()
        .run();
    }
    let added = 0;
    for (const deviceId of deviceIds) {
      const r = this.db
        .insert(deviceTags)
        .values({ productId, deviceId, tagId, createdAt: nowMs() })
        .onConflictDoNothing()
        .run();
      added += Number(r.changes ?? 0);
    }
    return added;
  }

  // ---------------------------------------------------------------- 运维

  /** 供 /readyz 使用：只做 SELECT 1，不查业务表。 */
  checkHealth(): { ready: boolean; latencyMs: number } {
    const t0 = performance.now();
    try {
      this.handle.sqlite.query("SELECT 1").get();
      return { ready: true, latencyMs: Math.round((performance.now() - t0) * 100) / 100 };
    } catch {
      return { ready: false, latencyMs: Math.round((performance.now() - t0) * 100) / 100 };
    }
  }

  dispose(): void {
    this.handle.close();
  }
}
