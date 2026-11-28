/**
 * 工作区与环境变量。
 *
 * 对应真实源码：packages/shared/src/workspace-env.ts
 * 优先级：环境变量 > <base>/.device_agent/.env > <base>/.env
 * 已存在的变量不覆盖（避免容器注入的变量被文件里的旧值盖掉）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveRuntimeBaseDir } from "./runtime-paths";

const HOME_ENV = "DEVICE_AGENT_HOME";
const WORKSPACE_ENV = "DEVICE_AGENT_WORKSPACE";

/** 运行态目录，默认 <仓库根>/.device_agent */
export function resolveDeviceAgentHome(sourceDir: string = import.meta.dirname): string {
  const fromEnv = process.env[HOME_ENV]?.trim();
  if (fromEnv) return fromEnv;
  return join(resolveRuntimeBaseDir(sourceDir), ".device_agent");
}

/** 用户工作区，默认 <仓库根>/workspace */
export function resolveWorkspaceRoot(sourceDir: string = import.meta.dirname): string {
  const fromEnv = process.env[WORKSPACE_ENV]?.trim();
  if (fromEnv) return fromEnv;
  return join(resolveRuntimeBaseDir(sourceDir), "workspace");
}

/** 极简 .env 解析：KEY=VALUE，忽略注释与空行，不处理转义。 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * 依次加载 .env 文件；已存在的 process.env 变量不会被覆盖。
 * 返回实际注入的键，便于启动日志说明"哪些变量来自文件"。
 */
export function loadWorkspaceEnv(sourceDir: string = import.meta.dirname): string[] {
  const base = resolveRuntimeBaseDir(sourceDir);
  const candidates = [join(base, ".device_agent", ".env"), join(base, ".env")];
  const injected: string[] = [];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const parsed = parseDotEnv(readFileSync(file, "utf8"));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) {
        process.env[k] = v;
        injected.push(k);
      }
    }
  }
  return injected;
}
