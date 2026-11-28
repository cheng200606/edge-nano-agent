/**
 * 定时组：agent_timers / agent_timer_runs。
 *
 * 对应真实源码：packages/persistence/src/db/schema.sqlite.ts
 *
 * 状态机（不可随意合并）：
 *   active    等待下次触发
 *   paused    用户暂停
 *   running   正在执行（防止同一任务并发执行）
 *   completed 一次性任务已执行完
 *   deleted   软删除
 */
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const TIMER_STATUSES = ["active", "paused", "running", "completed", "deleted"] as const;
export const TIMER_SCHEDULE_KINDS = ["cron", "interval", "once"] as const;
export const TIMER_RUN_STATUSES = ["running", "completed", "failed"] as const;

export const agentTimers = sqliteTable(
  "agent_timers",
  {
    id: text("id").primaryKey(),
    /** 创建它的会话，执行结果回传到这个会话 */
    originSessionId: text("origin_session_id").notNull().default(""),
    /** 作用域快照：productId / deviceId / namespace */
    scope: text("scope", { mode: "json" }).notNull().default(sql`'{}'`),
    status: text("status").notNull().default("active"),
    instruction: text("instruction").notNull(),
    scheduleKind: text("schedule_kind").notNull(),
    scheduleExpr: text("schedule_expr").notNull(),
    timezone: text("timezone").notNull().default("Asia/Shanghai"),
    nextRunAt: integer("next_run_at").notNull().default(0),
    lastRunAt: integer("last_run_at"),
    lastError: text("last_error"),
    /** 执行策略快照：可用工具 / 技能 / A2A 能力，避免执行时环境漂移 */
    executionPolicy: text("execution_policy", { mode: "json" }).notNull().default(sql`'{}'`),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    check(
      "agent_timers_status_check",
      sql`${t.status} IN ('active','paused','running','completed','deleted')`,
    ),
    check("agent_timers_schedule_kind_check", sql`${t.scheduleKind} IN ('cron','interval','once')`),
    index("idx_agent_timers_next_run").on(t.status, t.nextRunAt),
    index("idx_agent_timers_session").on(t.originSessionId),
  ],
);

export const agentTimerRuns = sqliteTable(
  "agent_timer_runs",
  {
    id: text("id").primaryKey(),
    timerId: text("timer_id")
      .notNull()
      .references(() => agentTimers.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("running"),
    startedAt: integer("started_at").notNull().default(0),
    finishedAt: integer("finished_at"),
    /** 执行会话，便于回看当时的完整对话 */
    sessionId: text("session_id").notNull().default(""),
    resultText: text("result_text").notNull().default(""),
    error: text("error"),
  },
  (t) => [
    check("agent_timer_runs_status_check", sql`${t.status} IN ('running','completed','failed')`),
    index("idx_agent_timer_runs_timer").on(t.timerId, t.startedAt),
  ],
);
