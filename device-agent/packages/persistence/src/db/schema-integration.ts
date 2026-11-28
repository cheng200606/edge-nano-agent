/**
 * 对外集成组：webhook_endpoints / webhook_credentials / webhook_credential_key_check
 *               / marketplace_cards / marketplace_apps / app_sessions。
 *
 * 对应真实源码：packages/persistence/src/db/schema.sqlite.ts
 *
 * 安全要点：webhook_credentials 只存**加密后的密文**与密钥指纹，
 * 明文密钥永不落库（凭据保险箱）。
 */
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const WEBHOOK_KINDS = ["outbound", "inbound"] as const;
export const SESSION_STATUSES = ["active", "expired", "revoked"] as const;

export const webhookEndpoints = sqliteTable(
  "webhook_endpoints",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("outbound"),
    url: text("url").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** 订阅的事件类型列表 */
    events: text("events", { mode: "json" }).notNull().default(sql`'[]'`),
    headers: text("headers", { mode: "json" }).notNull().default(sql`'{}'`),
    /** 引用 webhook_credentials.id */
    credentialId: text("credential_id"),
    lastStatus: integer("last_status"),
    lastCalledAt: integer("last_called_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    check("webhook_endpoints_kind_check", sql`${t.kind} IN ('outbound','inbound')`),
    index("idx_webhook_endpoints_enabled").on(t.enabled),
  ],
);

export const webhookCredentials = sqliteTable(
  "webhook_credentials",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** 密文（AES-GCM base64），不是明文 */
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    /** 主密钥指纹，用于轮换时定位 */
    keyFingerprint: text("key_fingerprint").notNull().default(""),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [uniqueIndex("uq_webhook_credentials_name").on(t.name)],
);

/**
 * 密钥校验记录：记录"某把主密钥自检过"的事实，启动时比对指纹，
 * 防止用错密钥导致所有密文解不开却没人发现。
 */
export const webhookCredentialKeyCheck = sqliteTable(
  "webhook_credential_key_check",
  {
    id: text("id").primaryKey(),
    keyFingerprint: text("key_fingerprint").notNull(),
    /** 已知明文的加密结果，用于自检 */
    sampleCiphertext: text("sample_ciphertext").notNull(),
    sampleIv: text("sample_iv").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [uniqueIndex("uq_webhook_credential_key_check_fp").on(t.keyFingerprint)],
);

export const marketplaceCards = sqliteTable(
  "marketplace_cards",
  {
    id: text("id").primaryKey(),
    productId: text("product_id").notNull().default(""),
    title: text("title").notNull().default(""),
    summary: text("summary").notNull().default(""),
    /** A2A 能力卡片 json */
    card: text("card", { mode: "json" }).notNull().default(sql`'{}'`),
    version: integer("version").notNull().default(1),
    published: integer("published", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index("idx_marketplace_cards_product").on(t.productId)],
);

export const marketplaceApps = sqliteTable(
  "marketplace_apps",
  {
    id: text("id").primaryKey(),
    cardId: text("card_id").notNull().default(""),
    name: text("name").notNull(),
    entryUrl: text("entry_url").notNull().default(""),
    manifest: text("manifest", { mode: "json" }).notNull().default(sql`'{}'`),
    installed: integer("installed", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [uniqueIndex("uq_marketplace_apps_name").on(t.name)],
);

export const appSessions = sqliteTable(
  "app_sessions",
  {
    id: text("id").primaryKey(),
    appId: text("app_id").notNull().default(""),
    principalId: text("principal_id").notNull().default(""),
    status: text("status").notNull().default("active"),
    issuedAt: integer("issued_at").notNull().default(0),
    expiresAt: integer("expires_at").notNull().default(0),
    metadata: text("metadata", { mode: "json" }).notNull().default(sql`'{}'`),
  },
  (t) => [
    check("app_sessions_status_check", sql`${t.status} IN ('active','expired','revoked')`),
    index("idx_app_sessions_app").on(t.appId),
  ],
);
