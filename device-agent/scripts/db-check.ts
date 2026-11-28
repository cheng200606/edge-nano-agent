/**
 * 建表与自检脚本：bun run db:check
 *
 * 在一个临时库里跑完迁移，打印表数量与关键 PRAGMA，
 * 用于验收「22 张表」这条硬指标（本项目实际 24 张）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "../packages/persistence/src/db/client";
import { countUserTables, ensureSchema } from "../packages/persistence/src/db/schema-lifecycle";

const migrationsFolder = join(import.meta.dir, "..", "drizzle");
const dir = mkdtempSync(join(tmpdir(), "da-dbcheck-"));
const dbPath = join(dir, "check.sqlite");

try {
  const handle = openDatabase({ path: dbPath });
  const result = ensureSchema(handle, migrationsFolder);
  const tables = countUserTables(handle);
  const journal = handle.sqlite.query("PRAGMA journal_mode").get() as {
    journal_mode: string;
  } | null;
  const fk = handle.sqlite.query("PRAGMA foreign_keys").get() as { foreign_keys: number } | null;

  process.stdout.write(`applied migrations : ${result.applied}\n`);
  process.stdout.write(`schema version     : ${result.version}\n`);
  process.stdout.write(`user tables        : ${tables}\n`);
  process.stdout.write(`journal_mode       : ${journal?.journal_mode}\n`);
  process.stdout.write(`foreign_keys       : ${fk?.foreign_keys}\n`);

  handle.close();

  if (tables < 22) {
    process.stderr.write(`FAIL: expected >= 22 user tables, got ${tables}\n`);
    process.exit(1);
  }
  process.stdout.write("OK\n");
} finally {
  // Windows 上 sqlite 关闭后 WAL 句柄可能仍被短暂持有，清理失败不应影响退出码
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore: 临时目录残留由 OS 回收
  }
}
