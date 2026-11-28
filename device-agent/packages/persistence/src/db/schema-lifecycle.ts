/**
 * 建表：启动即就绪。
 *
 * 对应真实源码：packages/persistence/src/db/schema-lifecycle.ts
 *
 * 指南 3.3 给了两种做法：手写 CREATE TABLE IF NOT EXISTS + 版本号表，或用
 * Drizzle 迁移。本项目按用户要求走 **Drizzle 全套**：用 drizzle-kit 生成的
 * SQL 迁移 + drizzle 官方 migrator，迁移状态由 `__drizzle_migrations` 维护。
 *
 * 三条纪律仍然遵守：
 *   1. 允许重复启动（migrator 幂等）
 *   2. 结构变更只新增迁移文件，不改历史
 *   3. 建表失败必须阻断启动（这里不 try/catch 吞异常）
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import type { DatabaseHandle } from "./client";

/** 在候选目录里找 drizzle 迁移目录（源码运行 / 编译产物两种形态）。 */
export function resolveMigrationsFolder(candidates: string[]): string {
  for (const dir of candidates) {
    if (existsSync(join(dir, "meta", "_journal.json"))) return dir;
  }
  throw new Error(`migrations folder not found; tried: ${candidates.join(", ")}`);
}

export interface EnsureSchemaResult {
  applied: number;
  version: number;
}

/**
 * 应用所有未执行的迁移，返回当前 schema 版本。
 * @param migrationsFolder drizzle-kit 生成的迁移目录（含 meta/_journal.json）
 */
export function ensureSchema(handle: DatabaseHandle, migrationsFolder: string): EnsureSchemaResult {
  const before = currentVersion(handle);
  migrate(handle.db, { migrationsFolder });
  const after = currentVersion(handle);
  return { applied: after - before, version: after };
}

/** 已应用的迁移条数（drizzle 自己维护的表）。 */
export function currentVersion(handle: DatabaseHandle): number {
  const row = handle.sqlite
    .query(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'`,
    )
    .get() as { n: number } | null;
  if (!row || row.n === 0) return 0;
  const applied = handle.sqlite.query(`SELECT COUNT(*) AS n FROM __drizzle_migrations`).get() as {
    n: number;
  } | null;
  return applied?.n ?? 0;
}

/** 表数量，用于自检（验收要求 ≥ 22）。 */
export function countUserTables(handle: DatabaseHandle): number {
  const row = handle.sqlite
    .query(
      `SELECT COUNT(*) AS n FROM sqlite_master
       WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`,
    )
    .get() as { n: number } | null;
  return row?.n ?? 0;
}
