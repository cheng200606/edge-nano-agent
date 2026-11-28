/**
 * schema 聚合出口：drizzle-kit 与运行时都从这里读全部表定义。
 *
 * 共 24 张表 = 指南 22 张 + product_versions + device_commands
 * （后两张是 AGENTS.md 点名的核心表，指南清单里没有单列，取并集）
 */

export * from "./schema-automation";
export * from "./schema-commands";
export * from "./schema-core";
export * from "./schema-integration";
export * from "./schema-memory";
export * from "./schema-timers";
export * from "./schema-voice";
