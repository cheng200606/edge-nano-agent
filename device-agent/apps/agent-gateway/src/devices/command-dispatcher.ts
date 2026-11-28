/**
 * 命令下发与台账回填。
 *
 * 对应真实源码：apps/agent-gateway/src/devices/command-dispatcher.ts
 *
 * 核心纪律（AGENTS.md 评分红线）：
 *   **下发成功 ≠ completed**。publish 只是"已发出"，台账必须保持 pending，
 *   直到收到回执或轮询判定 timeout。所以 send() 返回的是 commandId 与是否发出，
 *   而不是"成功"。
 */
import { buildCommandPayload, commandTopic } from "@device-agent/iot-platform/providers/default";
import type { DeviceService } from "@device-agent/persistence/device-service";

import type { Logger } from "../utils/logger";
import type { MqttLink } from "./mqtt-link";

export interface SendCommandInput {
  productId: string;
  deviceId: string;
  command: string;
  input?: unknown;
  requestedBy?: string;
  timeoutMs?: number;
}

export interface SendCommandResult {
  commandId: string;
  published: boolean;
  deadlineAt: number;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

export class CommandDispatcher {
  private readonly service: DeviceService;
  private readonly link: MqttLink;
  private readonly logger: Logger;

  constructor(service: DeviceService, link: MqttLink, logger: Logger) {
    this.service = service;
    this.link = link;
    this.logger = logger;
  }

  /** 建台账（pending）→ 发布下行。发布失败也不回滚台账，交由 timeout 收敛。 */
  send(input: SendCommandInput): SendCommandResult {
    const timeoutMs = input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const deadlineAt = Date.now() + timeoutMs;
    const record = this.service.createCommand({
      productId: input.productId,
      deviceId: input.deviceId,
      command: input.command,
      input: input.input ?? {},
      requestedBy: input.requestedBy ?? "",
      deadlineAt,
    });

    const topic = commandTopic(input.productId, input.deviceId);
    const published = this.link.publish(
      topic,
      buildCommandPayload({
        commandId: record.id,
        command: input.command,
        input: input.input ?? {},
        deadlineAt,
      }),
      1,
    );

    if (!published) {
      this.logger.warn("command not published (mqtt down), ledger stays pending", {
        commandId: record.id,
        topic,
      });
    } else {
      this.service.logEvent({
        productId: input.productId,
        deviceId: input.deviceId,
        type: "command_sent",
        summary: input.command,
        detail: { commandId: record.id, topic },
        source: "dispatcher",
      });
    }

    return { commandId: record.id, published, deadlineAt };
  }

  /** 回执到达：pending → completed / failed，并落事件。 */
  handleResponse(resp: {
    productId: string;
    deviceId: string;
    commandId: string;
    ok: boolean;
    response?: unknown;
    errorCode?: string;
    errorMessage?: string;
  }): void {
    try {
      const row = this.service.completeCommand(
        resp.commandId,
        resp.ok,
        resp.response,
        resp.ok ? undefined : { code: resp.errorCode, message: resp.errorMessage },
      );
      this.service.logEvent({
        productId: resp.productId,
        deviceId: resp.deviceId,
        type: "command_response",
        summary: row.command,
        detail: { commandId: row.id, status: row.status, response: resp.response },
        source: "mqtt",
      });
    } catch (err) {
      // 回执迟到（台账已 timeout）或未知 commandId，都不应让链路挂掉
      this.logger.warn("command response not applied", {
        commandId: resp.commandId,
        code: (err as { code?: string }).code ?? "UNKNOWN",
        message: (err as Error).message,
      });
    }
  }

  /** 轮询收敛超时命令；由定时器周期调用。 */
  sweepTimeouts(): number {
    const n = this.service.expireCommands();
    if (n > 0) {
      this.logger.info("commands expired", { count: n });
    }
    return n;
  }
}
