/**
 * 配置加载：播种 → 读取 → 校验 → 非 strict 回退。
 *
 * 对应真实源码：packages/shared/src/device-agent-config.ts
 * 三个必须保持的行为：
 *   1. 首次启动没有 config.json 是正常状态，写入默认值而不是报错
 *   2. 配置坏掉时回退默认值并返回 issues（否则用户进不了控制台修）
 *   3. 环境变量优先于文件（DEVICE_AGENT_HOME 决定目录）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type DeviceAgentConfig,
  DeviceAgentConfigSchema,
  formatIssues,
  loadDefaultDeviceAgentConfig,
} from "./device-agent-config-schema";

export type {
  CloudRole,
  DeviceAgentConfig,
  LogLevel,
  ModelConfig,
  ModelProvider,
} from "./device-agent-config-schema";
export {
  CLOUD_ROLES,
  CONFIG_DOMAINS,
  CONFIG_VERSION,
  DeviceAgentConfigSchema,
  LOG_LEVELS,
  loadDefaultDeviceAgentConfig,
} from "./device-agent-config-schema";

export function resolveDeviceAgentConfigPath(home: string): string {
  return join(home, "config.json");
}

/** 首次启动把默认配置落盘，返回是否真的写入了。 */
export function ensureDeviceAgentConfigSeeded(
  home: string,
  seed: DeviceAgentConfig = loadDefaultDeviceAgentConfig(),
): boolean {
  const p = resolveDeviceAgentConfigPath(home);
  if (existsSync(p)) return false;
  mkdirSync(home, { recursive: true });
  writeFileSync(p, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
  return true;
}

export interface LoadConfigResult {
  config: DeviceAgentConfig;
  issues: string[];
  seeded: boolean;
  path: string;
}

/**
 * 加载配置。
 * @param strict true 时校验失败直接抛错（测试与 CI 用），默认 false 回退默认值
 */
export function loadDeviceAgentConfig(
  home: string,
  opts: { strict?: boolean } = {},
): LoadConfigResult {
  const seeded = ensureDeviceAgentConfigSeeded(home);
  const path = resolveDeviceAgentConfigPath(home);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const message = `failed to parse config.json: ${(err as Error).message}`;
    if (opts.strict) throw new Error(message);
    return { config: loadDefaultDeviceAgentConfig(), issues: [message], seeded, path };
  }

  const parsed = DeviceAgentConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const message = formatIssues(parsed.error);
    if (opts.strict) throw new Error(`config validation failed: ${message}`);
    return { config: loadDefaultDeviceAgentConfig(), issues: [message], seeded, path };
  }
  return { config: parsed.data, issues: [], seeded, path };
}

/** 启动摘要：只打印非敏感字段。 */
export function summarizeConfig(cfg: DeviceAgentConfig): string[] {
  return [
    `version      = ${cfg.version}`,
    `cloud.worker = ${cfg.cloud.worker} (instance=${cfg.cloud.instanceId})`,
    `mqtt.broker  = ${cfg.mqtt.brokerUrl} clientId=${cfg.mqtt.clientId}`,
    `models.agent = provider=${cfg.models.agent.provider} model=${cfg.models.agent.model || "<unset>"}`,
    `iotPlatform  = ${cfg.iotPlatform.providerId}`,
    `voice        = enabled=${cfg.voice.enabled} provider=${cfg.voice.provider}`,
    `logging      = level=${cfg.logging.level} console=${cfg.logging.console} file=${cfg.logging.file}`,
    `aiCredits    = enabled=${cfg.aiCredits.enabled} currency=${cfg.aiCredits.currency}`,
    `permissions  = tools=${cfg.permissions.tools.length === 0 ? "all" : cfg.permissions.tools.join(",")}`,
  ];
}
