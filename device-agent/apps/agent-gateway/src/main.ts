/**
 * 进程入口：环境变量 → 日志 → CLI → 角色分派 → 网关启动 → 优雅关闭。
 *
 * 对应真实源码：apps/agent-gateway/src/main.ts
 * 铁律：入口里不写业务。业务都在 gateway.ts 与各领域模块里。
 */
import { loadDeviceAgentConfig, summarizeConfig } from "@device-agent/shared/device-agent-config";
import { loadWorkspaceEnv, resolveDeviceAgentHome } from "@device-agent/shared/workspace-env";

import { handleCli } from "./cli/index";
import { startGateway } from "./gateway";
import { configureLogging, createLogger } from "./utils/logger";

const injected = loadWorkspaceEnv(import.meta.dirname);
const log = createLogger("Main");

async function main(): Promise<void> {
  const cli = await handleCli();

  if (cli.printConfig) {
    const home = resolveDeviceAgentHome(import.meta.dirname);
    const loaded = loadDeviceAgentConfig(home);
    process.stdout.write(`${summarizeConfig(loaded.config).join("\n")}\n`);
    if (loaded.issues.length > 0) {
      process.stderr.write(`config issues: ${loaded.issues.join("; ")}\n`);
    }
    return;
  }
  if (cli.handled) return;

  if (injected.length > 0) {
    log.info("Workspace env loaded", { keys: injected });
  }

  const level = (process.env.LOG_LEVEL ?? "info").trim();
  if (level === "debug" || level === "info" || level === "warn" || level === "error") {
    configureLogging({ level });
  }

  const role = (process.env.DEVICE_AGENT_ROLE ?? "standalone").trim();
  if (role !== "standalone") {
    // 云端角色 M6 之后再实现，显式报错避免"以为跑起来了"
    throw new Error(`Unsupported runtime role: ${role}`);
  }

  const gateway = await startGateway({ sourceDir: import.meta.dirname });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log.info("Shutting down", { signal });
    try {
      await gateway.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  log.error("Fatal error", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
