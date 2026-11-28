/**
 * 命令台账：device_commands。
 *
 * 虽然老师指南的 22 张表清单里把它折进了 device_events，但 AGENTS.md 明确
 * 把 device_commands 列为 5 张核心表之一，且"命令下发成功 ≠ completed"
 * 这条红线需要独立台账才能表达，因此单独建表（总数变为 24，仍满足 ≥22）。
 *
 * 三态语义（不可合并成两态）：
 *   pending    已下发，等回执
 *   completed  收到成功回执
 *   failed     收到失败回执
 *   timeout    超过 deadline 仍未回执 —— **靠台账轮询判定，不是 setTimeout**
 */
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const COMMAND_STATUSES = ["pending", "completed", "failed", "timeout"] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

export const deviceCommands = sqliteTable(
  "device_commands",
  {
    id: text("id").primaryKey(),
    productId: text("product_id").notNull(),
    deviceId: text("device_id").notNull(),
    command: text("command").notNull(),
    /** 下发时的入参快照 */
    input: text("input", { mode: "json" }).notNull().default(sql`'{}'`),
    /**
     * 调用方提供的幂等键（HTTP 的 Idempotency-Key、工具调用的 dedupe 键）。
     * 允许为 NULL —— SQLite 的唯一索引把 NULL 视为互不相同，
     * 因此"没有幂等键"的命令不会被误判为重复。
     */
    idempotencyKey: text("idempotency_key"),
    status: text("status").notNull().default("pending"),
    /** 设备回执原文 */
    response: text("response", { mode: "json" }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    requestedBy: text("requested_by").notNull().default(""),
    sentAt: integer("sent_at").notNull().default(0),
    /** 回执截止时刻；轮询任务据此判定 timeout */
    deadlineAt: integer("deadline_at").notNull().default(0),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    check(
      "device_commands_status_check",
      sql`${t.status} IN ('pending','completed','failed','timeout')`,
    ),
    // 幂等：同一设备同一条幂等键只允许一条（NULL 不参与唯一性判断）
    uniqueIndex("uq_device_commands_idempotency").on(t.productId, t.deviceId, t.idempotencyKey),
    index("idx_device_commands_status").on(t.status),
    index("idx_device_commands_device").on(t.productId, t.deviceId),
    index("idx_device_commands_deadline").on(t.deadlineAt),
  ],
);
