/**
 * 自动化组：workflow_rules / workflow_runs / workflow_run_steps / workflow_dedupe_keys。
 *
 * 对应真实源码：packages/persistence/src/db/schema.sqlite.ts
 *
 * 关键点（指南 3.2.1 教学提示）：
 *   workflow_runs.status 里的 `partial_failed` 是最有价值的一态——
 *   它表达"命令已下发但回执超时"这种真实情况。只实现 completed/failed
 *   就无法描述部分成功。
 */
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const WORKFLOW_RUN_STATUSES = ["running", "completed", "partial_failed", "failed"] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export const WORKFLOW_STEP_TYPES = ["action", "switch", "join", "agent", "decision"] as const;

export const workflowRules = sqliteTable(
  "workflow_rules",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** 触发器定义（事件类型、过滤条件） */
    trigger: text("trigger", { mode: "json" }).notNull().default(sql`'{}'`),
    /** 条件与动作的流程图 */
    graph: text("graph", { mode: "json" }).notNull().default(sql`'{}'`),
    /** 作用域：productId / deviceId / namespace */
    scope: text("scope", { mode: "json" }).notNull().default(sql`'{}'`),
    createdBy: text("created_by").notNull().default(""),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("idx_workflow_rules_enabled").on(t.enabled),
    index("idx_workflow_rules_name").on(t.name),
  ],
);

export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflowRules.id, { onDelete: "cascade" }),
    /** 触发快照：即使规则被改，也能复盘当时为什么触发 */
    trigger: text("trigger", { mode: "json" }).notNull().default(sql`'{}'`),
    status: text("status").notNull().default("running"),
    startedAt: integer("started_at").notNull().default(0),
    finishedAt: integer("finished_at"),
    summary: text("summary").notNull().default(""),
    error: text("error"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    check(
      "workflow_runs_status_check",
      sql`${t.status} IN ('running','completed','partial_failed','failed')`,
    ),
    index("idx_workflow_runs_workflow").on(t.workflowId, t.createdAt),
    index("idx_workflow_runs_status").on(t.status),
  ],
);

export const workflowRunSteps = sqliteTable(
  "workflow_run_steps",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    /** 步骤在流程图里的节点 id */
    nodeId: text("node_id").notNull().default(""),
    type: text("type").notNull(),
    actionType: text("action_type").notNull().default(""),
    ok: integer("ok", { mode: "boolean" }).notNull().default(true),
    durationMs: integer("duration_ms").notNull().default(0),
    details: text("details", { mode: "json" }).notNull().default(sql`'{}'`),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    check(
      "workflow_run_steps_type_check",
      sql`${t.type} IN ('action','switch','join','agent','decision')`,
    ),
    index("idx_workflow_run_steps_run").on(t.runId),
  ],
);

/**
 * 幂等去重表：同一 triggerKey 在窗口内只触发一次。
 * 这是"幂等三件套"的第三件（唯一键 + INSERT OR IGNORE + 去重表）。
 */
export const workflowDedupeKeys = sqliteTable(
  "workflow_dedupe_keys",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workflowId: text("workflow_id").notNull(),
    /** 业务侧计算的幂等键，例如 deviceId:eventId */
    dedupeKey: text("dedupe_key").notNull(),
    /** 过期时刻，清理任务据此删除 */
    expiresAt: integer("expires_at").notNull().default(0),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex("uq_workflow_dedupe_keys").on(t.workflowId, t.dedupeKey),
    index("idx_workflow_dedupe_expires").on(t.expiresAt),
  ],
);
