/**
 * drizzle-kit 配置。
 *
 * 生成迁移：bun run db:generate
 * 迁移产物：device-agent/drizzle/*.sql + meta/_journal.json（需要提交）
 */
import type { Config } from "drizzle-kit";

export default {
  schema: "./packages/persistence/src/db/schema.sqlite.ts",
  out: "./drizzle",
  dialect: "sqlite",
  strict: true,
  verbose: true,
  dbCredentials: {
    url: "./.device_agent/device_agent.sqlite",
  },
} satisfies Config;
