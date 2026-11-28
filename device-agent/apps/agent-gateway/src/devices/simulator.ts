/**
 * 本地设备模拟器：在没有真实硬件时把闭环跑起来。
 *
 * 对应真实源码：指南第 4 章的「本地模拟器」。
 *
 * 它是一条独立的 MQTT 连接（不是复用网关的链路），这样才符合真实拓扑：
 * 设备是不同的主体，有自己的 clientId 与重连行为。
 */
import {
  commandTopic,
  responseTopic,
  telemetryTopic,
} from "@device-agent/iot-platform/providers/default";
import type { DeviceService } from "@device-agent/persistence/device-service";

import type { Logger } from "../utils/logger";
import { MqttLink } from "./mqtt-link";

export interface SimulatorConfig {
  url: string;
  productId: string;
  deviceId: string;
  intervalMs?: number;
  logger: Logger;
  service: DeviceService;
  /** 命令处理时人为延迟，用于演示台账 pending → completed */
  commandDelayMs?: number;
}

export class DeviceSimulator {
  private readonly cfg: SimulatorConfig;
  private readonly link: MqttLink;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;

  constructor(cfg: SimulatorConfig) {
    this.cfg = cfg;
    this.link = new MqttLink({
      url: cfg.url,
      clientId: `sim-${cfg.productId}-${cfg.deviceId}`,
      reconnectPeriodMs: 2000,
      logger: cfg.logger,
    });
  }

  start(): void {
    const { productId, deviceId, service, logger } = this.cfg;

    // 产品与设备由模拟器显式创建（真实场景由 API 创建）
    service.upsertProduct({ id: productId, name: `${productId} 产品` });
    service.registerDevice(deviceId, productId, { firmware: "sim-1.0" });

    this.link.connect();

    this.link.subscribe(commandTopic(productId, deviceId), (topic, payload) => {
      let msg: { commandId?: string; command?: string; input?: unknown } = {};
      try {
        msg = JSON.parse(payload.toString("utf8")) as typeof msg;
      } catch {
        logger.warn("simulator got invalid command payload", { topic });
        return;
      }
      if (!msg.commandId) {
        logger.warn("simulator got command without commandId", { topic });
        return;
      }
      const delay = this.cfg.commandDelayMs ?? 120;
      setTimeout(() => {
        const ok = msg.command !== "explode";
        const body = JSON.stringify({
          commandId: msg.commandId,
          ok,
          response: ok
            ? { accepted: true, command: msg.command, input: msg.input ?? {} }
            : undefined,
          errorCode: ok ? undefined : "SIM_REJECTED",
          errorMessage: ok ? undefined : "simulator rejects this command",
        });
        this.link.publish(responseTopic(productId, deviceId), body, 1);
        logger.info("simulator replied", { commandId: msg.commandId, ok });
      }, delay);
    });

    this.timer = setInterval(() => this.publishTelemetry(), this.cfg.intervalMs ?? 2000);
    logger.info("simulator started", {
      productId,
      deviceId,
      intervalMs: this.cfg.intervalMs ?? 2000,
    });
  }

  private publishTelemetry(): void {
    const { productId, deviceId } = this.cfg;
    this.seq += 1;
    const values = {
      temp: Math.round((22 + Math.sin(this.seq / 5) * 3) * 100) / 100,
      humidity: Math.round((50 + Math.cos(this.seq / 7) * 8) * 100) / 100,
      voltage: Math.round((220 + Math.sin(this.seq / 3) * 2) * 100) / 100,
      seq: this.seq,
    };
    const body = JSON.stringify({ ts: Date.now(), values });
    const sent = this.link.publish(telemetryTopic(productId, deviceId), body, 1);
    if (!sent) {
      this.cfg.logger.debug("simulator telemetry skipped (mqtt down)", { seq: this.seq });
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.link.close();
  }
}
