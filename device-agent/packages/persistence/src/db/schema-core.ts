/**
 * 22 张表的 Drizzle schema（SQLite）。
 *
 * 对应真实源码：packages/persistence/src/db/schema.sqlite.ts
 *
 * 分组（指南 3.2）：
 *   产品与设备  products / devices / device_tags / tags
 *   设备数据    device_events（只增不改，按天清理）
 *   自动化      workflow_rules / workflow_runs / workflow_run_steps / workflow_dedupe_keys
 *   定时        agent_timers / agent_timer_runs
 *   记忆与身份  memory_items / memory_events / principals
 *   对外集成    webhook_endpoints / webhook_credentials / webhook_credential_key_check
 *               marketplace_cards / marketplace_apps / app_sessions
 *   语音        voice_keyword_terms / voice_question_cache
 *
 * 设计纪律：
 *   - 约束写在最靠近数据的地方（check），绕过 service 写 SQL 也不会产生非法行
 *   - 状态列一律加 check，枚举值写死在 schema 里
 *   - 时间统一用毫秒时间戳 integer
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const createdAt = () => integer("created_at").notNull().default(sql`(unixepoch() * 1000)`);
const updatedAt = () => integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`);

// ---------------------------------------------------------------- 产品与设备

export const products = sqliteTable(
  "products",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** 第 2 章的 DeviceSpec（json） */
    deviceSpec: text("device_spec", { mode: "json" }).notNull().default(sql`'{}'`),
    /** 人格、语音工具白名单、快捷动作等非数据字典配置 */
    metadata: text("metadata", { mode: "json" }).notNull().default(sql`'{}'`),
    iotPlatformProviderId: text("iot_platform_provider_id").notNull().default("default"),
    lifecycleStatus: text("lifecycle_status").notNull().default("developing"),
    /** 每次发布 +1，用于 A2A 卡片刷新 */
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // 产品 ID 同时是 MQTT 主题段，必须是安全字符。
    // 注意：不能写 `GLOB '[A-Za-z0-9_-]*'`——那只约束首字符，`bad/id` 也能通过。
    // 正确写法是「不包含集合外字符」。
    check("products_id_check", sql`${t.id} NOT GLOB '*[^A-Za-z0-9_-]*'`),
    check(
      "products_lifecycle_status_check",
      sql`${t.lifecycleStatus} IN ('developing','published','archived')`,
    ),
    index("idx_products_lifecycle").on(t.lifecycleStatus),
  ],
);

export const productVersions = sqliteTable(
  "product_versions",
  {
    id: text("id").primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    deviceSpec: text("device_spec", { mode: "json" }).notNull().default(sql`'{}'`),
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("uq_product_versions_product_version").on(t.productId, t.version),
    index("idx_product_versions_product").on(t.productId),
  ],
);

export const devices = sqliteTable(
  "devices",
  {
    id: text("id").notNull(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    name: text("name").notNull().default(""),
    status: text("status").notNull().default("offline"),
    /** 设备上报的当前值 */
    reportedState: text("reported_state", { mode: "json" }).notNull().default(sql`'{}'`),
    /** 期望值（update_device_state 写这里） */
    desiredState: text("desired_state", { mode: "json" }).notNull().default(sql`'{}'`),
    lastSeenAt: integer("last_seen_at").notNull().default(0),
    /** 固件版本、型号等 */
    metadata: text("metadata", { mode: "json" }).notNull().default(sql`'{}'`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // 联合主键：同一 deviceId 不能跨产品复用
    primaryKey({ columns: [t.productId, t.id] }),
    check("devices_status_check", sql`${t.status} IN ('online','offline','error')`),
    index("idx_devices_product").on(t.productId),
    index("idx_devices_status").on(t.status),
  ],
);

export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    color: text("color").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("uq_tags_name").on(t.name)],
);

export const deviceTags = sqliteTable(
  "device_tags",
  {
    productId: text("product_id").notNull(),
    deviceId: text("device_id").notNull(),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.deviceId, t.tagId] }),
    index("idx_device_tags_tag").on(t.tagId),
  ],
);

// ---------------------------------------------------------------- 设备数据

/** 13 种事件类型：遥测/事件/状态/命令响应/校验错误等统一事件流 */
export const DEVICE_EVENT_TYPES = [
  "telemetry",
  "device_event",
  "status",
  "command_response",
  "validation_error",
  "command_sent",
  "command_timeout",
  "command_failed",
  "state_update",
  "workflow_trigger",
  "manual_action",
  "system",
  "audit",
] as const;

export const deviceEvents = sqliteTable(
  "device_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    productId: text("product_id").notNull().default(""),
    deviceId: text("device_id").notNull().default(""),
    namespace: text("namespace").notNull().default(""),
    type: text("type").notNull(),
    summary: text("summary").notNull().default(""),
    detail: text("detail", { mode: "json" }).notNull().default(sql`'{}'`),
    source: text("source").notNull().default(""),
    occurredAt: integer("occurred_at").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("idx_device_events_device_time").on(t.deviceId, t.createdAt),
    index("idx_device_events_type").on(t.type),
    index("idx_device_events_namespace").on(t.namespace),
  ],
);
