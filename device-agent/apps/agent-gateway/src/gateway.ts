/**
 * 网关生命周期聚合。
 *
 * 对应真实源码：apps/agent-gateway/src/gateway.ts
 * M0 阶段只做三件事：解析 home、加载配置、起 HTTP 服务。
 * 后续里程碑依次把 MQTT 连接（M3）、Agent 路由（M4）、定时器（M8）挂进来。
 */
import { join } from "node:path";

import {
  type DeviceAgentConfig,
  loadDeviceAgentConfig,
  summarizeConfig,
} from "@device-agent/shared/device-agent-config";
import { resolveDeviceAgentHome } from "@device-agent/shared/workspace-env";
import { createHealthRegistry, type HealthRegistry } from "./standalone/health";
import { createHttpServer, type HttpServerHandle } from "./standalone/http-server";
import { configureLogging, createLogger } from "./utils/logger";

export interface GatewayHandle {
  config: DeviceAgentConfig;
  home: string;
  health: HealthRegistry;
  server: HttpServerHandle;
  stop(): Promise<void>;
}

export interface GatewayOptions {
  sourceDir?: string;
  port?: number;
}

export async function startGateway(opts: GatewayOptions = {}): Promise<GatewayHandle> {
  const sourceDir = opts.sourceDir ?? import.meta.dirname;
  const home = resolveDeviceAgentHome(sourceDir);
  const bootstrapLog = createLogger("Bootstrap");

  bootstrapLog.info("Loading configuration", { home });
  const loaded = loadDeviceAgentConfig(home);

  configureLogging({
    level: loaded.config.logging.level,
    console: loaded.config.logging.console,
    file: loaded.config.logging.file,
    dir: home,
  });

  const log = createLogger("Gateway");
  if (loaded.seeded) {
    log.info("Seeded default config", { path: loaded.path });
  }
  if (loaded.issues.length > 0) {
    log.warn("Config issues, falling back to defaults", { issues: loaded.issues });
  }
  for (const line of summarizeConfig(loaded.config)) {
    log.info("config", { detail: line });
  }
  log.info("Starting gateway", {
    version: process.env.npm_package_version ?? "0.5.1",
    role: process.env.DEVICE_AGENT_ROLE ?? "standalone",
    home,
    logs: join(home, "logs"),
  });

  const health = createHealthRegistry();
  health.register("database", () => ({ ready: false, reason: "not-initialized (M2)" }));
  health.register("mqtt", () => ({ ready: false, reason: "not-connected (M3)" }));

  const port = opts.port ?? Number(process.env.PORT ?? 3000);
  // Bun.serve 返回时已处于监听状态，这里不再调用 listen()
  const server = createHttpServer({ port, health, home, config: loaded.config });

  log.info("Gateway ready", { url: server.url });

  return {
    config: loaded.config,
    home,
    health,
    server,
    async stop() {
      await server.close();
      log.info("Gateway stopped");
    },
  };
}
