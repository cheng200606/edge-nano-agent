/**
 * 从 zod schema 生成 `config/config.schema.json`。
 *
 *   bun run config:schema
 *
 * 为什么要有这个文件（指南 2.5）：原系统把配置 schema 随包分发，
 * 供控制台做表单渲染、供用户校验自己手改的 config.json。
 * 本项目的**唯一真源仍是代码里的 zod schema**，JSON 由它生成，
 * 避免"代码改了、随包 schema 没改"的漂移。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DeviceAgentConfigSchema } from "@device-agent/shared/device-agent-config-schema";
import { z } from "zod";

const root = join(import.meta.dir, "..");
const outDir = join(root, "config");
const outFile = join(outDir, "config.schema.json");

const jsonSchema = z.toJSONSchema(DeviceAgentConfigSchema, {
  target: "draft-7",
  io: "input",
});

const doc = {
  $comment:
    "由 scripts/gen-config-schema.ts 从 packages/shared/src/device-agent-config-schema.ts 生成，勿手改",
  ...jsonSchema,
};

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

const propCount = Object.keys(
  (jsonSchema as { properties?: Record<string, unknown> }).properties ?? {},
).length;
process.stdout.write(`[config:schema] wrote ${outFile} (${propCount} top-level domains)\n`);
