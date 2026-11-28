/**
 * 记忆与身份组：memory_items / memory_events / principals。
 *
 * 对应真实源码：packages/persistence/src/db/schema.sqlite.ts
 */
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const MEMORY_KINDS = ["fact", "preference", "procedure", "note"] as const;
export const PRINCIPAL_KINDS = ["user", "agent", "service", "device"] as const;

export const memoryItems = sqliteTable(
  "memory_items",
  {
    id: text("id").primaryKey(),
    /** 作用域键，例如 product:p1 或 device:p1:d1；空表示全局 */
    scopeKey: text("scope_key").notNull().default(""),
    kind: text("kind").notNull().default("fact"),
    key: text("key").notNull(),
    value: text("value").notNull().default(""),
    /** 重要度 0-100，用于检索排序与淘汰 */
    importance: integer("importance").notNull().default(50),
    /** 过期时刻；0 表示永不过期 */
    expiresAt: integer("expires_at").notNull().default(0),
    source: text("source").notNull().default(""),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    check("memory_items_kind_check", sql`${t.kind} IN ('fact','preference','procedure','note')`),
    check("memory_items_importance_check", sql`${t.importance} BETWEEN 0 AND 100`),
    // 同一作用域下同一 key 唯一 -> upsert 写入
    uniqueIndex("uq_memory_items_scope_key").on(t.scopeKey, t.key),
    index("idx_memory_items_scope").on(t.scopeKey),
  ],
);

export const memoryEvents = sqliteTable(
  "memory_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    memoryId: text("memory_id").notNull().default(""),
    action: text("action").notNull(),
    scopeKey: text("scope_key").notNull().default(""),
    detail: text("detail", { mode: "json" }).notNull().default(sql`'{}'`),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    check("memory_events_action_check", sql`${t.action} IN ('created','updated','deleted','read')`),
    index("idx_memory_events_memory").on(t.memoryId, t.createdAt),
  ],
);

export const principals = sqliteTable(
  "principals",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    displayName: text("display_name").notNull().default(""),
    /** 外部身份映射，例如飞书 open_id / Discord userId */
    externalId: text("external_id").notNull().default(""),
    metadata: text("metadata", { mode: "json" }).notNull().default(sql`'{}'`),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    check("principals_kind_check", sql`${t.kind} IN ('user','agent','service','device')`),
    uniqueIndex("uq_principals_external").on(t.kind, t.externalId),
  ],
);
