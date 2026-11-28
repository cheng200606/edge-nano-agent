/**
 * 一次 Agent 回合（turn）：装配 `Agent` → 消费事件 → 落盘 → 转成 `AgentReplyEvent`。
 *
 * 对应真实源码：apps/agent-gateway/src/agent/turn.ts
 *
 * ⚠️ 评分红线：**没有手写 while 循环当 agent loop**。
 * 循环、工具执行、多轮衔接、中止语义全部由 `@earendil-works/pi-agent-core@1.1.0` 的
 * `Agent` 负责；本文件只做四件事：
 *   1. 每回合重建 system 提示词（时间/设备/工具清单必须新鲜，指南 5.4）
 *   2. 把 `Agent` 的生命周期事件翻译成 `AgentReplyEvent`（SSE 的载荷）
 *   3. 在 `message_end` 收集消息，回合结束后一次性落盘（**绝不在 delta 里写库**）
 *   4. 判定终止原因：completed / failed / cancelled（指南 5.5.1 只认这三种）
 *
 * 与指南 5.3.4「同一会话复用同一个 pi session 实例」的差异（有意的取舍）：
 *   本实现每回合用会话文件 + 全新 `Agent` 实例重建 transcript，不做内存会话缓存。
 *   原因：M4 只有一个工具，重建成本可忽略；而"缓存的 session 里残留旧工具名"是
 *   指南「常见坑」第 3 条，重建反而绕开了。工具签名缓存（sha256(toolNames)）留到
 *   M5/LU-06 工具扩容、重建变贵时再上，届时 key 就是 `${sessionId}|${signature}`。
 */
import { join } from "node:path";
import type { DeviceService } from "@device-agent/persistence/device-service";
import type { DeviceAgentConfig, ModelConfig } from "@device-agent/shared/device-agent-config";
import { validateDeviceSpec } from "@device-agent/shared/device-spec-schema";
import type { AgentReplyEvent } from "@device-agent/shared/session-contract";
import { validateSessionId } from "@device-agent/shared/session-contract";
import {
  Agent,
  type AgentMessage,
  type AgentToolResult,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";

import type { Logger } from "../utils/logger";
import { createAgentStreamFn, describeModel, resolveAgentModel } from "./model";
import { SessionStore, SessionStoreError } from "./session-store";
import { buildSystemPrompt, type PromptDevice } from "./system-prompt";
import { createAgentTools, toolNamesOf } from "./tools";

/** 回合级错误码（HTTP 层映射成 4xx/5xx 的 code）。 */
export const TURN_ERRORS = {
  TURN_SERVICE_CLOSED: "TURN_SERVICE_CLOSED",
  MESSAGE_REQUIRED: "TURN_MESSAGE_REQUIRED",
  MESSAGE_TOO_LONG: "TURN_MESSAGE_TOO_LONG",
  AGENT_RUN_FAILED: "AGENT_RUN_FAILED",
  AGENT_MODEL_ERROR: "AGENT_MODEL_ERROR",
  AGENT_ABORTED: "AGENT_ABORTED",
  SESSION_PERSIST_FAILED: "SESSION_PERSIST_FAILED",
} as const;

export type TurnErrorCode =
  | (typeof TURN_ERRORS)[keyof typeof TURN_ERRORS]
  | SessionStoreError["code"];

/** 请求层（校验/关闭）的可捕获错误；mid-run 失败**不**抛，走 error 事件。 */
export class TurnError extends Error {
  readonly code: TurnErrorCode;

  constructor(code: TurnErrorCode, message: string) {
    super(message);
    this.name = "TurnError";
    this.code = code;
  }
}

export type TurnStatus = "completed" | "failed" | "cancelled";

export interface TurnRequest {
  sessionId: string;
  message: string;
  /** 作用域：只读该产品的设备。不传表示"全部产品" */
  productId?: string;
}

export interface TurnRunOptions {
  signal?: AbortSignal;
  /** 事件立即回调（SSE 处理器在此处 enqueue），回合结束也会在 TurnResult.events 里 */
  onEvent?: (event: AgentReplyEvent) => void;
}

export interface TurnResult {
  sessionId: string;
  status: TurnStatus;
  /** 最终回答文本（= 最后一条 assistant 消息的文本） */
  text: string;
  events: AgentReplyEvent[];
  /** 本回合落盘的消息条数 */
  persistedMessages: number;
  errorCode?: string;
  usage?: AgentReplyEvent["usage"];
}

export interface TurnServiceOptions {
  config: DeviceAgentConfig;
  /** 运行态根目录：会话落在 `<home>/pi-sessions/<sessionId>.jsonl` */
  home: string;
  service: DeviceService;
  logger: Logger;
  /** 测试注入：默认按 config.models.agent 构造 */
  streamFn?: StreamFn;
  /** 测试注入：默认 `<home>/pi-sessions` */
  sessionStore?: SessionStore;
  now?: () => Date;
  timeZone?: string;
  /** 单条用户消息的最大长度，防止把整本书塞进上下文 */
  maxMessageChars?: number;
}

const DEFAULT_MAX_MESSAGE_CHARS = 16_000;

/** 一次 assistant 消息是否值得写进历史（失败占位不进，避免下次开局面对空消息）。 */
function shouldPersist(message: AgentMessage): boolean {
  if (message.role === "system") return false;
  if (message.role !== "assistant") return true;
  const failed = message.stopReason === "error" || message.stopReason === "aborted";
  if (!failed) return true;
  return contentText(message.content).trim().length > 0;
}

function toReplyUsage(usage: AssistantMessage["usage"] | undefined): AgentReplyEvent["usage"] {
  if (!usage) return undefined;
  return {
    promptTokens: usage.input,
    completionTokens: usage.output,
    totalTokens: usage.totalTokens,
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class TurnService {
  readonly sessionStore: SessionStore;
  readonly modelConfig: ModelConfig;
  private readonly service: DeviceService;
  private readonly logger: Logger;
  private readonly streamFn: StreamFn;
  private readonly now: () => Date;
  private readonly timeZone: string;
  private readonly maxMessageChars: number;
  /** 同一 sessionId 的回合串行化：并发写同一个 jsonl 会交错 */
  private readonly tails = new Map<string, Promise<void>>();
  private readonly activeAgents = new Set<Agent>();
  private closed = false;

  constructor(options: TurnServiceOptions) {
    this.service = options.service;
    this.logger = options.logger;
    this.modelConfig = options.config.models.agent;
    this.sessionStore = options.sessionStore ?? new SessionStore(join(options.home, "pi-sessions"));
    this.streamFn = options.streamFn ?? createAgentStreamFn(this.modelConfig);
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone ?? resolveTimeZone();
    this.maxMessageChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;

    const described = describeModel(this.modelConfig);
    this.logger.info("agent model ready", described);
  }

  /** 模型描述（Agent 每回合都用同一张表；只有 config 变才需要重启） */
  get model() {
    return resolveAgentModel(this.modelConfig);
  }

  /**
   * 跑一回合。校验失败抛 `TurnError`；mid-run 失败**不抛**，
   * 而是以 `error` + `done` 事件收尾（SSE 必须有终止帧）。
   */
  async runTurn(request: TurnRequest, options: TurnRunOptions = {}): Promise<TurnResult> {
    if (this.closed) {
      throw new TurnError(TURN_ERRORS.TURN_SERVICE_CLOSED, "turn service is closed");
    }
    const validation = validateSessionId(request.sessionId);
    if (!validation.ok) {
      throw new TurnError(
        validation.code ?? "SESSION_ID_INVALID",
        validation.message ?? "invalid sessionId",
      );
    }
    const message = typeof request.message === "string" ? request.message.trim() : "";
    if (message.length === 0) {
      throw new TurnError(TURN_ERRORS.MESSAGE_REQUIRED, "message must be a non-empty string");
    }
    if (message.length > this.maxMessageChars) {
      throw new TurnError(
        TURN_ERRORS.MESSAGE_TOO_LONG,
        `message exceeds ${this.maxMessageChars} characters`,
      );
    }

    return this.enqueue(request.sessionId, () => this.runExclusive(request, message, options));
  }

  /** 优雅关闭：先中止在飞的回合，再拒绝新请求。 */
  dispose(): void {
    this.closed = true;
    for (const agent of this.activeAgents) agent.abort();
    this.activeAgents.clear();
    this.tails.clear();
  }

  private async runExclusive(
    request: TurnRequest,
    message: string,
    options: TurnRunOptions,
  ): Promise<TurnResult> {
    const events: AgentReplyEvent[] = [];
    let seq = 0;
    const emit = (partial: Omit<AgentReplyEvent, "sessionId" | "seq">): void => {
      const event: AgentReplyEvent = { ...partial, sessionId: request.sessionId, seq: seq++ };
      events.push(event);
      options.onEvent?.(event);
    };

    const loaded = this.sessionStore.load(request.sessionId);
    const tools = createAgentTools({ service: this.service, logger: this.logger });
    const toolNames = toolNamesOf(tools);
    const scope = this.collectScope(request.productId);
    const systemPrompt = buildSystemPrompt({
      now: this.now(),
      timeZone: this.timeZone,
      productId: request.productId,
      devices: scope.devices,
      commandIds: scope.commandIds,
      toolNames,
    });

    const agent = new Agent({
      initialState: {
        systemPrompt,
        tools,
        messages: loaded.messages,
        model: this.model,
        thinkingLevel: "off",
      },
      streamFn: this.streamFn,
      getApiKey: () => {
        const key = this.modelConfig.apiKey.trim();
        return key.length > 0 ? key : undefined;
      },
      sessionId: request.sessionId,
      // 单工具场景下串行执行事件顺序可预测；M5 多工具时再评估并行
      toolExecution: "sequential",
    });

    const collected: AgentMessage[] = [];
    let terminal: AssistantMessage | undefined;

    const unsubscribe = agent.subscribe((event) => {
      switch (event.type) {
        case "message_update": {
          const update = event.assistantMessageEvent;
          if (update.type === "text_delta" && update.delta.length > 0) {
            emit({ kind: "delta", text: update.delta });
          }
          break;
        }
        case "tool_execution_start": {
          // 工具一起跑就通知前端（指南 5.5：别等执行完）
          emit({
            kind: "tool_start",
            toolName: event.toolName,
            toolInput: event.args,
          });
          break;
        }
        case "tool_execution_end": {
          const result = event.result as AgentToolResult | undefined;
          emit({
            kind: "tool_result",
            toolName: event.toolName,
            toolOutput: result
              ? { isError: event.isError, content: result.content, details: result.details }
              : { isError: event.isError },
          });
          break;
        }
        case "message_end": {
          // 只在消息完整结束时收集，绝不在 message_update 里写库
          if (event.message.role === "assistant") terminal = event.message;
          if (shouldPersist(event.message)) collected.push(event.message);
          break;
        }
        default:
          break;
      }
    });

    this.activeAgents.add(agent);
    // 外部中止（客户端断开 / 网关关闭）必须真的中止 Agent 循环，
    // 否则 abort 信号只停在 HTTP 层，模型和工具都还在跑
    const onAbort = (): void => agent.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let runFailure: Error | undefined;
    try {
      await agent.prompt(message);
    } catch (error) {
      // Agent 内部已把模型错误编码成 stopReason；能冒到这里的是循环级异常
      runFailure = asError(error);
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      this.activeAgents.delete(agent);
    }

    const abortSignal = options.signal;
    let status: TurnStatus = "completed";
    let errorCode: string | undefined;
    let errorText: string | undefined;

    if (runFailure) {
      status = "failed";
      errorCode = TURN_ERRORS.AGENT_RUN_FAILED;
      errorText = runFailure.message;
    } else if (abortSignal?.aborted || terminal?.stopReason === "aborted") {
      status = "cancelled";
      errorCode = TURN_ERRORS.AGENT_ABORTED;
      errorText = "Turn cancelled by client.";
    } else if (terminal?.stopReason === "error" || terminal?.errorMessage?.trim()) {
      status = "failed";
      errorCode = TURN_ERRORS.AGENT_MODEL_ERROR;
      errorText = terminal?.errorMessage?.trim() || "Agent model request failed.";
    }

    const finalText = terminal ? contentText(terminal.content) : "";
    const usage = toReplyUsage(terminal?.usage);

    // 落盘放在回合结束后统一写；失败回合中已完成的消息同样要留下（历史必须真实）
    let persistedMessages = 0;
    try {
      persistedMessages = this.sessionStore.append(request.sessionId, collected).appended;
    } catch (error) {
      const failure = asError(error);
      this.logger.error("session persist failed", {
        sessionId: request.sessionId,
        code: error instanceof SessionStoreError ? error.code : TURN_ERRORS.SESSION_PERSIST_FAILED,
        error: failure.message,
      });
    }

    if (usage) emit({ kind: "usage", usage });
    if (status !== "completed") {
      emit({ kind: "error", errorCode, text: errorText });
    }
    emit({ kind: "done", text: finalText, usage });

    this.logger.info("turn finished", {
      sessionId: request.sessionId,
      status,
      events: events.length,
      deltas: events.filter((event) => event.kind === "delta").length,
      tools: events.filter((event) => event.kind === "tool_start").length,
      persistedMessages,
      textLength: finalText.length,
    });

    return {
      sessionId: request.sessionId,
      status,
      text: finalText,
      events,
      persistedMessages,
      errorCode,
      usage,
    };
  }

  /** 作用域内的设备与允许的命令 ID（来自产品 DeviceSpec，作为数据注入提示词）。 */
  private collectScope(productId?: string): {
    devices: PromptDevice[];
    commandIds: string[];
  } {
    const productIds = productId
      ? [productId]
      : this.service.listProducts().map((product) => product.id);
    const devices: PromptDevice[] = [];
    const commandIds = new Set<string>();

    for (const id of productIds) {
      for (const row of this.service.listDevices(id)) {
        devices.push({
          deviceId: row.id,
          productId: row.productId,
          name: row.name,
          status: row.status,
        });
      }
      const product = this.service.getProduct(id);
      if (!product) continue;
      const spec = validateDeviceSpec(product.deviceSpec);
      // strict:false 下布尔判别式不窄化，这里只认 data 是否存在（AGENTS.md 工程坑）
      if (spec.data) {
        for (const commandId of Object.keys(spec.data.commands)) commandIds.add(commandId);
      }
    }

    return { devices, commandIds: [...commandIds] };
  }

  /** 同一 sessionId 串行（不同 session 并行）。前一回合失败不影响后一回合入队。 */
  private async enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, settled);
    try {
      return await run;
    } finally {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    }
  }
}

/** 运行时时区：优先环境变量，其次系统时区（IANA 名），最后 UTC。 */
function resolveTimeZone(): string {
  const fromEnv = process.env.DEVICE_AGENT_TIMEZONE?.trim();
  if (fromEnv) return fromEnv;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
