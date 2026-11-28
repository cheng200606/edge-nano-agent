/**
 * MQTT 链路封装。
 *
 * 对应真实源码：apps/agent-gateway/src/channels/mqtt/*
 *
 * 两条纪律：
 *   1. **降级不阻塞**：broker 连不上时网关必须照常启动，只是 /readyz 报 mqtt.ready=false
 *   2. **重连由库负责**：不自己写 while 重试循环，交给 mqtt 客户端的 reconnectPeriod
 */
import mqtt, { type IClientOptions, type MqttClient } from "mqtt";

import type { Logger } from "../utils/logger";

export interface MqttLinkOptions {
  url: string;
  clientId: string;
  username?: string;
  password?: string;
  keepAliveSeconds?: number;
  reconnectPeriodMs?: number;
  cleanStart?: boolean;
  logger: Logger;
}

export type MessageHandler = (topic: string, payload: Buffer) => void;

export interface MqttLinkStats {
  connected: boolean;
  published: number;
  received: number;
  errors: number;
  lastError?: string;
  connectedAt?: number;
}

export class MqttLink {
  private readonly opts: MqttLinkOptions;
  private client: MqttClient | null = null;
  private readonly handlers = new Map<string, MessageHandler[]>();
  private stats: MqttLinkStats = { connected: false, published: 0, received: 0, errors: 0 };

  constructor(opts: MqttLinkOptions) {
    this.opts = opts;
  }

  /** 发起连接。返回的 Promise 只表示"已发起"，不代表连上——连不上不会 reject。 */
  connect(): void {
    if (this.client) return;
    const options: IClientOptions = {
      clientId: this.opts.clientId,
      keepalive: this.opts.keepAliveSeconds ?? 60,
      reconnectPeriod: this.opts.reconnectPeriodMs ?? 3000,
      clean: this.opts.cleanStart ?? true,
      connectTimeout: 8000,
    };
    if (this.opts.username) options.username = this.opts.username;
    if (this.opts.password) options.password = this.opts.password;

    const client = mqtt.connect(this.opts.url, options);
    this.client = client;
    const log = this.opts.logger;

    client.on("connect", () => {
      this.stats.connected = true;
      this.stats.connectedAt = Date.now();
      log.info("mqtt connected", { url: this.opts.url, clientId: this.opts.clientId });
      for (const [topic, list] of this.handlers) {
        client.subscribe(topic, { qos: 1 }, (err) => {
          if (err) {
            this.stats.errors += 1;
            this.stats.lastError = err.message;
            log.error("mqtt subscribe failed", { topic, error: err.message });
            return;
          }
          log.info("mqtt subscribed", { topic, handlers: list.length });
        });
      }
    });

    client.on("reconnect", () => {
      log.warn("mqtt reconnecting", { url: this.opts.url });
    });

    client.on("close", () => {
      this.stats.connected = false;
      log.warn("mqtt connection closed");
    });

    client.on("error", (err: Error) => {
      this.stats.errors += 1;
      // 首次连不上是预期情况（降级不阻塞），只记 warn 不抛
      this.stats.lastError = err.message;
      log.warn("mqtt error", { error: err.message });
    });

    client.on("message", (topic: string, payload: Buffer) => {
      this.stats.received += 1;
      for (const [pattern, list] of this.handlers) {
        if (matches(pattern, topic)) {
          for (const h of list) {
            try {
              h(topic, payload);
            } catch (err) {
              this.stats.errors += 1;
              log.error("mqtt handler threw", { topic, error: (err as Error).message });
            }
          }
        }
      }
    });
  }

  /** 订阅。支持 + 单层通配；重复订阅同一主题会追加 handler。 */
  subscribe(topic: string, handler: MessageHandler): void {
    const list = this.handlers.get(topic) ?? [];
    list.push(handler);
    this.handlers.set(topic, list);
    if (this.client?.connected) {
      this.client.subscribe(topic, { qos: 1 });
    }
  }

  publish(topic: string, payload: string, qos: 0 | 1 = 1): boolean {
    if (!this.client?.connected) {
      this.stats.errors += 1;
      this.stats.lastError = "publish while disconnected";
      return false;
    }
    this.client.publish(topic, payload, { qos });
    this.stats.published += 1;
    return true;
  }

  isReady(): boolean {
    return this.client?.connected === true;
  }

  snapshot(): MqttLinkStats {
    return { ...this.stats };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.stats.connected = false;
    if (!client) return;
    await new Promise<void>((resolve) => {
      client.end(false, {}, () => resolve());
      setTimeout(resolve, 1500);
    });
  }
}

/** MQTT 主题匹配：支持 + 与 #。 */
export function matches(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;
  const p = pattern.split("/");
  const t = topic.split("/");
  for (let i = 0; i < p.length; i += 1) {
    if (p[i] === "#") return true;
    if (i >= t.length) return false;
    if (p[i] === "+") continue;
    if (p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}
