/**
 * 对真实运行库执行迁移（不是临时库）。
 *
 *   bun run db:migrate
 *
 * 与 `db:check` 的区别：
 *   db:check  在临时目录起一个库，只验证"迁移能否建出 24 张表"，不留痕
 *   db:migrate 直接作用于 <home>/device_agent.sqlite，用于手动修复 / 升级既有环境
 *
 * 正常启动时网关自己会跑迁移（schema-lifecycle.ensureSchema），这个脚本是给
 * "库已经存在但要单独升级" 或 "想先看迁移会做什么" 的场景用的。
 */
import { join } from "node:path";
import { openDatabase } from "@device-agent/persistence/db/client";
import {
  countUserTables,
  currentVersion,
  ensureSchema,
  resolveMigrationsFolder,
} from "@device-agent/persistence/db/schema-lifecycle";
import { resolveRuntimeBaseDir } from "@device-agent/shared/runtime-paths";
import { resolveDeviceAgentHome } from "@device-agent/shared/workspace-env";

const projectRoot = join(import.meta.dir, "..");
const home = resolveDeviceAgentHome(projectRoot);
const dbPath = join(home, "device_agent.sqlite");
const baseDir = resolveRuntimeBaseDir(projectRoot);

const migrationsFolder = resolveMigrationsFolder([join(baseDir, "drizzle"), join(home, "drizzle")]);

process.stdout.write(`[migrate] home       = ${home}\n`);
process.stdout.write(`[migrate] database   = ${dbPath}\n`);
process.stdout.write(`[migrate] migrations = ${migrationsFolder}\n`);

const handle = openDatabase({ path: dbPath });
try {
  const before = currentVersion(handle);
  const result = ensureSchema(handle, migrationsFolder);
  const tables = countUserTables(handle);
  process.stdout.write(`[migrate] version    : ${before} -> ${result.version}\n`);
  process.stdout.write(`[migrate] applied    : ${result.applied}\n`);
  process.stdout.write(`[migrate] tables     : ${tables}\n`);
  if (tables < 22) {
    process.stderr.write(`[migrate] FAIL: expected >= 22 user tables, got ${tables}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("[migrate] OK\n");
  }
} finally {
  handle.close();
}
