/**
 * 数据库客户端：打开连接并设置必需的 PRAGMA。
 *
 * 对应真实源码：packages/persistence/src/db/client.ts
 *
 * 三条 PRAGMA 缺一不可（指南 3.1 / 3.2）：
 *   journal_mode = WAL   并发读写不互相阻塞；崩溃恢复更安全
 *   foreign_keys = ON    否则删产品不会级联删设备，留下孤儿行
 *   busy_timeout         写锁竞争时等待而不是立刻 SQLITE_BUSY
 */
import { Database } from "bun:sqlite";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "./schema.sqlite";

export type AppDatabase = BunSQLiteDatabase<typeof schema>;

export interface DatabaseHandle {
  sqlite: Database;
  db: AppDatabase;
  path: string;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** 文件路径；传 ":memory:" 用内存库（测试） */
  path: string;
  /** 内存库无法开 WAL，测试环境自动跳过 */
  enableWal?: boolean;
}

export function openDatabase(opts: OpenDatabaseOptions): DatabaseHandle {
  const isMemory = opts.path === ":memory:";
  const sqlite = new Database(opts.path, { create: !isMemory });

  if (opts.enableWal !== false && !isMemory) {
    sqlite.exec("PRAGMA journal_mode = WAL;");
  }
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  sqlite.exec("PRAGMA synchronous = NORMAL;");

  const db = drizzle(sqlite, { schema });

  return {
    sqlite,
    db,
    path: opts.path,
    close() {
      sqlite.close();
    },
  };
}
