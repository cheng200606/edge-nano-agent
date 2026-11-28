/**
 * 语音组：voice_keyword_terms / voice_question_cache。
 *
 * 对应真实源码：packages/persistence/src/db/schema.sqlite.ts
 * 这里的 check 直接照抄指南 3.2.2 的示例——它们是"把不变量放在最靠近数据的地方"
 * 的样板：即使运维脚本绕过 service 直接写 SQL，也造不出非法行。
 */
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const VOICE_MATCH_MODES = ["substring", "word_boundary", "context"] as const;

export const voiceKeywordTerms = sqliteTable(
  "voice_keyword_terms",
  {
    id: text("id").primaryKey(),
    term: text("term").notNull(),
    /** 归一化后的 hash（sha256 hex，64 字符），用于去重与检索 */
    termHash: text("term_hash").notNull(),
    matchMode: text("match_mode").notNull().default("substring"),
    /** 是否人工挑选过（0/1） */
    curated: integer("curated").notNull().default(0),
    weight: integer("weight").notNull().default(100),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    check("voice_keyword_terms_term_hash_check", sql`length(${t.termHash}) = 64`),
    check("voice_keyword_terms_term_check", sql`length(${t.term}) BETWEEN 2 AND 64`),
    check(
      "voice_keyword_terms_match_mode_check",
      sql`${t.matchMode} IN ('substring','word_boundary','context')`,
    ),
    check("voice_keyword_terms_curated_check", sql`${t.curated} IN (0,1)`),
    uniqueIndex("uq_voice_keyword_terms_hash").on(t.termHash),
  ],
);

export const voiceQuestionCache = sqliteTable(
  "voice_question_cache",
  {
    id: text("id").primaryKey(),
    /** 问题归一化 hash */
    questionHash: text("question_hash").notNull(),
    question: text("question").notNull().default(""),
    answer: text("answer").notNull().default(""),
    /** 命中次数，用于淘汰低频缓存 */
    hitCount: integer("hit_count").notNull().default(0),
    expiresAt: integer("expires_at").notNull().default(0),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    check("voice_question_cache_hash_check", sql`length(${t.questionHash}) = 64`),
    uniqueIndex("uq_voice_question_cache_hash").on(t.questionHash),
    index("idx_voice_question_cache_expires").on(t.expiresAt),
  ],
);
