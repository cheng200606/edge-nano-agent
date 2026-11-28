/**
 * 网关生命周期聚合。
 *
 * 对应真实源码：apps/agent-gateway/src/gateway.ts
 *
 * M0：配置 → 日志 → HTTP
 * M3：+ SQLite（迁移就绪）+ MQTT 链路 + 设备入口 + 命令台账 + 可选模拟器
 * M4：+ Agent 单轮（pi-agent-core 循环 + mock 模型 + 会话 jsonl）与 POST /api/chat（SSE）
 *
 * 降级原则：MQTT 连不上**不阻塞启动**，只是 /readyz 报 mqtt.ready=false。
 * 关闭顺序：定时器 → 模拟器 → Agent 回合（中止在飞请求）→ MQTT → HTTP → DB。
 */
import { join } from "node:path";
import { type DatabaseHandle, openDatabase } from "@device-agent/persistence/db/client";
import {
  ensureSchema,
  resolveMigrationsFolder,
} from "@device-agent/persistence/db/schema-lifecycle";
import { DeviceService } from "@device-agent/persistence/device-service";
import {
  type DeviceAgentConfig,
  loadDeviceAgentConfig,
  summarizeConfig,
} from "@device-agent/shared/device-agent-config";
import { resolveRuntimeBaseDir } from "@device-agent/shared/runtime-paths";
import { resolveDeviceAgentHome } from "@device-agent/shared/workspace-env";

import { TurnService } from "./agent/turn";
import { CommandDispatcher } from "./devices/command-dispatcher";
import { attachIngress } from "./devices/mqtt-ingress";
import { MqttLink } from "./devices/mqtt-link";
import { DeviceSimulator } from "./devices/simulator";
import { createChatHandler } from "./http-api/chat";
import { createHealthRegistry, type HealthRegistry } from "./standalone/health";
import { createHttpServer, type HttpServerHandle } from "./standalone/http-server";
import { configureLogging, createLogger } from "./utils/logger";

const COMMAND_SWEEP_INTERVAL_MS = 5_000;

export interface GatewayHandle {
  config: DeviceAgentConfig;
  home: string;
  health: HealthRegistry;
  server: HttpServerHandle;
  service: DeviceService;
  mqtt: MqttLink;
  dispatcher: CommandDispatcher;
  /** Agent 单轮服务（M4） */
  turn: TurnService;
  simulator?: DeviceSimulator;
  stop(): Promise<void>;
}

export interface GatewayOptions {
  sourceDir?: string;
  port?: number;
  /** 测试用：覆盖数据库路径 */
  databasePath?: string;
  /** 测试用：强制关闭 MQTT */
  disableMqtt?: boolean;
  /** 是否启动本地设备模拟器（默认读环境变量 DEVICE_SIMULATOR） */
  enableSimulator?: boolean;
}

export async function startGateway(opts: GatewayOptions = {}): Promise<GatewayHandle> {
  const sourceDir = opts.sourceDir ?? import.meta.dirname;
  const baseDir = resolveRuntimeBaseDir(sourceDir);
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
  if (loaded.seeded) log.info("Seeded default config", { path: loaded.path });
  if (loaded.issues.length > 0) {
    log.warn("Config issues, falling back to defaults", { issues: loaded.issues });
  }
  for (const line of summarizeConfig(loaded.config)) log.info("config", { detail: line });

  // ---------------- 数据库 ----------------
  const dbPath = opts.databasePath ?? join(home, "device_agent.sqlite");
  const handle: DatabaseHandle = openDatabase({ path: dbPath });
  const migrationsFolder = resolveMigrationsFolder([
    join(baseDir, "drizzle"),
    join(home, "drizzle"),
  ]);
  const applied = ensureSchema(handle, migrationsFolder);
  const service = new DeviceService(handle);
  log.info("database ready", { path: dbPath, appliedMigrations: applied.applied });

  // ---------------- MQTT ----------------
  const mqtt = new MqttLink({
    url: loaded.config.mqtt.brokerUrl,
    clientId: `${loaded.config.mqtt.clientId}-${loaded.config.cloud.instanceId}`,
    username: loaded.config.mqtt.username || undefined,
    password: loaded.config.mqtt.password || undefined,
    keepAliveSeconds: loaded.config.mqtt.keepAliveSeconds,
    reconnectPeriodMs: loaded.config.mqtt.reconnectPeriodMs,
    cleanStart: loaded.config.mqtt.cleanStart,
    logger: createLogger("Mqtt"),
  });

  const dispatcher = new CommandDispatcher(service, mqtt, createLogger("Dispatcher"));
  if (!opts.disableMqtt) {
    attachIngress(mqtt, {
      service,
      logger: createLogger("Ingress"),
      onCommandResponse: (resp) => dispatcher.handleResponse(resp),
    });
    mqtt.connect();
    log.info("mqtt connecting", { url: loaded.config.mqtt.brokerUrl });
  }

  // ---------------- 健康检查 ----------------
  const health = createHealthRegistry();
  health.register("database", () => service.checkHealth(), { critical: true });
  health.register("mqtt", () => ({ ready: mqtt.isReady(), ...mqtt.snapshot() }), {
    critical: true,
  });

  // ---------------- 超时轮询 ----------------
  const sweep = setInterval(() => {
    try {
      dispatcher.sweepTimeouts();
    } catch (err) {
      log.error("command sweep failed", { error: (err as Error).message });
    }
  }, COMMAND_SWEEP_INTERVAL_MS);
  sweep.unref?.();

  // ---------------- 模拟器 ----------------
  const simulatorEnabled = opts.enableSimulator ?? process.env.DEVICE_SIMULATOR === "1";
  let simulator: DeviceSimulator | undefined;
  if (simulatorEnabled && !opts.disableMqtt) {
    simulator = new DeviceSimulator({
      url: loaded.config.mqtt.brokerUrl,
      productId: process.env.DEVICE_SIM_PRODUCT ?? "demo-plug",
      deviceId: process.env.DEVICE_SIM_ID ?? "demo-dev-1",
      intervalMs: Number(process.env.DEVICE_SIM_INTERVAL_MS ?? 2000),
      logger: createLogger("Simulator"),
      service,
    });
    simulator.start();
  }

  // ---------------- Agent 单轮 ----------------
  const turn = new TurnService({
    config: loaded.config,
    home,
    service,
    logger: createLogger("Agent"),
  });

  // ---------------- HTTP ----------------
  const port = opts.port ?? Number(process.env.PORT ?? 3000);
  const server = createHttpServer({
    port,
    health,
    home,
    config: loaded.config,
    chat: createChatHandler({ turn, logger: createLogger("Chat") }),
  });
  log.info("Gateway ready", {
    url: server.url,
    mqtt: mqtt.isReady() ? "connected" : "connecting",
    simulator: simulator ? "on" : "off",
    agent: `${turn.model.provider}/${turn.model.id}`,
  });

  return {
    config: loaded.config,
    home,
    health,
    server,
    service,
    mqtt,
    dispatcher,
    turn,
    simulator,
    async stop() {
      clearInterval(sweep);
      if (simulator) await simulator.stop();
      // 先中止在飞的 Agent 回合，否则 server.close() 会一直等 SSE 连接
      turn.dispose();
      await mqtt.close();
      await server.close();
      service.dispose();
      log.info("Gateway stopped");
    },
  };
}
