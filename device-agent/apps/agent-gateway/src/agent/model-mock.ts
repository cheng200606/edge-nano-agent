/**
 * Mock 模型：一个**纯本地、确定性**的 `StreamFn` 实现（M4 阶段无 API Key 也能跑通）。
 *
 * 对应真实源码：apps/agent-gateway/src/agent/config.ts 的 resolveModel + 指南 5.8 的假模型。
 *
 * ---------------------------------------------------------------------------
 * 怎么换成真模型（**不需要改本文件以外的任何逻辑**）
 * ---------------------------------------------------------------------------
 * 1. 改 `.device_agent/config.json`：
 *      "models": { "agent": { "provider": "openai", "baseUrl": "https://api.xxx/v1",
 *                             "apiKey": "sk-...", "model": "gpt-4o-mini" } }
 * 2. `agent/model.ts` 的 `createAgentStreamFn()` 会按 `provider !== "mock"` 走
 *    `@earendil-works/pi-ai/api/openai-completions` 的 `streamSimple`（OpenAI 兼容协议，
 *    豆包/ollama/vLLM 都是同一协议，只换 baseUrl）。
 * 3. `Agent` 拿到的还是同一个 `StreamFn` 形状，工具、事件流、会话落盘、SSE 全部不变。
 *
 * 也就是说：mock 与真模型是**同一接口的两个实现**，切换只发生在 config 里。
 * 唯一不能变的是 `Agent` 期望的事件协议：
 *    start → (text_start → text_delta* → text_end | toolcall_start → toolcall_end) → done
 *    失败/中止必须走 `{ type: "error", reason: "error" | "aborted", error }` 这一帧，
 *    而不是 throw——throw 会让 agent loop 走 handleRunFailure，拿不到增量文本。
 * ---------------------------------------------------------------------------
 *
 * ⚠️ 本文件里的中文只是**假模型生成的对话文本**（用户用中文问，就回中文），
 *    不是服务端对外文案。HTTP 错误体、日志一律英文 code + 英文 message。
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  contentText,
  createAssistantMessageEventStream,
  type Message,
  type Model,
  type TextContent,
  type ToolCall,
  type ToolResultMessage,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";

/** mock 模型在 model descriptor 里使用的 api 名（与 openai-completions 区分开）。 */
export const MOCK_API = "mock";
/** mock 内置的工具调用名：与应用里真实注册的工具同名，工具回灌链路才是真的。 */
export const MOCK_TOOL_NAME = "list_devices";
/** 触发工具调用的意图词。中英文都覆盖，验收 curl 用的是中文。 */
export const DEFAULT_DEVICE_INTENT_PATTERN = /(设备|device|devices|列出|列表|清单|list|inventory)/i;

const CJK_PATTERN = /[\u4e00-\u9fff]/;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

export interface MockStreamFnOptions {
  /** 每个增量之间的人为延迟（毫秒）。>0 才能让 `curl -N` 真的看到逐条 delta。 */
  chunkDelayMs?: number;
  /** 单个增量块的字符数 */
  chunkSize?: number;
  /** 触发工具调用的意图正则 */
  deviceIntentPattern?: RegExp;
  /** 工具名（默认 list_devices） */
  deviceToolName?: string;
  /**
   * 让工具调用回合以 `stopReason: "length"` 结束（模拟 max_tokens 截断）。
   * 只用于测试「半截工具调用不得执行」这条验收项。
   */
  truncateToolCalls?: boolean;
}

interface ResolvedMockOptions {
  chunkDelayMs: number;
  chunkSize: number;
  deviceIntentPattern: RegExp;
  deviceToolName: string;
  truncateToolCalls: boolean;
}

/** 工具输出（list_devices）的结构化形状，仅用于把结果说成人话。 */
interface DeviceListPayload {
  productIds?: string[];
  count?: number;
  devices: Array<{ deviceId: string; productId: string; name?: string; status?: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDeviceListPayload(raw: string): DeviceListPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.devices)) return undefined;
  const devices: DeviceListPayload["devices"] = [];
  for (const item of parsed.devices) {
    if (!isRecord(item)) continue;
    const deviceId = typeof item.deviceId === "string" ? item.deviceId : "";
    const productId = typeof item.productId === "string" ? item.productId : "";
    if (deviceId.length === 0) continue;
    devices.push({
      deviceId,
      productId,
      name: typeof item.name === "string" ? item.name : undefined,
      status: typeof item.status === "string" ? item.status : undefined,
    });
  }
  const productIds = Array.isArray(parsed.productIds)
    ? parsed.productIds.filter((v): v is string => typeof v === "string")
    : [];
  return {
    productIds,
    count: typeof parsed.count === "number" ? parsed.count : devices.length,
    devices,
  };
}

function lastNonSystemMessage(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && message.role !== "system") return message;
  }
  return undefined;
}

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "user") return contentText(message.content);
  }
  return "";
}

/**
 * 从运行时上下文里读出产品作用域，作为 `list_devices` 的入参。
 *
 * 真模型会读到 system prompt 里的 `Product scope: <id> (...)` 并把它填进工具参数；
 * mock 想证明「模型 → 工具参数」这一段真的通了，就必须做同一件事。
 * 解析不出来（全产品作用域）就返回 undefined，工具自己列出全部产品。
 */
function productIdFromContext(messages: Message[]): string | undefined {
  for (const message of messages) {
    if (message.role !== "system") continue;
    const match = /Product scope: (\S+) \(/.exec(contentText(message.content));
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function estimateUsage(promptText: string, outputText: string): Usage {
  // 粗估：4 字符 ≈ 1 token；mock 不烧 token，这里只是让 usage 事件不为 0 假象
  const input = Math.max(1, Math.round(promptText.length / 4));
  const output = Math.max(0, Math.round(outputText.length / 4));
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: ZERO_COST,
  };
}

function chunkText(text: string, size: number): string[] {
  const chars = Array.from(text);
  if (chars.length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += size) {
    chunks.push(chars.slice(i, i + size).join(""));
  }
  return chunks;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 一次 mock 响应的写入器：把"模型吐字"翻译成 pi 的事件协议。
 *
 * 注意每个事件的 `partial` 必须是**快照**：agent loop 会把 partial 直接放进
 * context.messages，若与内部对象共用引用，历史消息会被后续 delta 改写。
 */
class MockResponse {
  private readonly stream: AssistantMessageEventStream;
  private readonly message: AssistantMessage;
  private readonly options: ResolvedMockOptions;
  private readonly signal?: AbortSignal;
  private readonly promptText: string;
  private ended = false;

  constructor(args: {
    stream: AssistantMessageEventStream;
    model: Model<Api>;
    options: ResolvedMockOptions;
    signal?: AbortSignal;
    promptText: string;
  }) {
    this.stream = args.stream;
    this.options = args.options;
    this.signal = args.signal;
    this.promptText = args.promptText;
    this.message = {
      role: "assistant",
      content: [],
      api: args.model.api,
      provider: args.model.provider,
      model: args.model.id,
      usage: emptyUsage(),
      stopReason: "pending",
      timestamp: Date.now(),
    };
  }

  start(): void {
    this.stream.push({ type: "start", partial: this.snapshot() });
  }

  /** 逐块吐文本；返回 false 表示中途被中止（已写入 error 帧）。 */
  async writeText(text: string): Promise<boolean> {
    if (this.ended) return false;
    const block: TextContent = { type: "text", text: "" };
    this.message.content.push(block);
    const contentIndex = this.message.content.length - 1;
    this.stream.push({ type: "text_start", contentIndex, partial: this.snapshot() });

    for (const chunk of chunkText(text, this.options.chunkSize)) {
      if (this.signal?.aborted) {
        this.finishAborted();
        return false;
      }
      if (this.options.chunkDelayMs > 0) await delay(this.options.chunkDelayMs);
      block.text += chunk;
      this.stream.push({
        type: "text_delta",
        contentIndex,
        delta: chunk,
        partial: this.snapshot(),
      });
    }

    this.stream.push({
      type: "text_end",
      contentIndex,
      content: block.text,
      partial: this.snapshot(),
    });
    return true;
  }

  writeToolCall(toolCall: ToolCall): void {
    if (this.ended) return;
    this.message.content.push(toolCall);
    const contentIndex = this.message.content.length - 1;
    // 工具调用一起手就通知前端（指南 5.5：别等执行完）
    this.stream.push({ type: "toolcall_start", contentIndex, partial: this.snapshot() });
    this.stream.push({
      type: "toolcall_end",
      contentIndex,
      toolCall,
      partial: this.snapshot(),
    });
  }

  finishStop(): void {
    if (this.ended) return;
    this.message.stopReason = "stop";
    this.message.usage = estimateUsage(this.promptText, this.collectedText());
    this.stream.push({ type: "done", reason: "stop", message: this.message });
    this.ended = true;
  }

  finishToolUse(): void {
    if (this.ended) return;
    this.message.stopReason = "toolUse";
    this.message.usage = estimateUsage(this.promptText, "");
    this.stream.push({ type: "done", reason: "toolUse", message: this.message });
    this.ended = true;
  }

  /** 模拟被 max_tokens 截断：工具参数可能是半截的，agent loop 必须整体判失败。 */
  finishLength(): void {
    if (this.ended) return;
    this.message.stopReason = "length";
    this.message.usage = estimateUsage(this.promptText, "");
    this.stream.push({ type: "done", reason: "length", message: this.message });
    this.ended = true;
  }

  finishError(message: string): void {
    if (this.ended) return;
    this.message.stopReason = "error";
    this.message.errorMessage = message;
    this.stream.push({ type: "error", reason: "error", error: this.message });
    this.ended = true;
  }

  private finishAborted(): void {
    if (this.ended) return;
    this.message.stopReason = "aborted";
    this.message.errorMessage = "Agent run aborted by client.";
    this.stream.push({ type: "error", reason: "aborted", error: this.message });
    this.ended = true;
  }

  private collectedText(): string {
    return contentText(this.message.content);
  }

  private snapshot(): AssistantMessage {
    return {
      ...this.message,
      content: this.message.content.map((block) => ({ ...block })),
    };
  }
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { ...ZERO_COST },
  };
}

/** 把工具结果说成人话；解析不出来就原样回显（模型看到的就是工具返回的 JSON 字符串）。 */
function summarizeToolResult(message: ToolResultMessage, lang: "zh" | "en"): string {
  const raw = contentText(message.content);
  if (message.isError) {
    return lang === "zh" ? `工具执行失败：${raw}` : `Tool execution failed: ${raw}`;
  }
  const payload = parseDeviceListPayload(raw);
  if (!payload) return raw;

  if (payload.devices.length === 0) {
    return lang === "zh" ? "当前没有已注册的设备。" : "No device is currently registered.";
  }

  const heading =
    lang === "zh"
      ? `当前共 ${payload.count ?? payload.devices.length} 台设备：`
      : `Found ${payload.count ?? payload.devices.length} device(s):`;
  const lines = payload.devices.map((device) => {
    const status = device.status ?? "unknown";
    return `- ${device.deviceId} (${device.productId}, ${status})`;
  });
  return [heading, ...lines].join("\n");
}

function echoReply(userText: string, lang: "zh" | "en", toolName: string): string {
  const trimmed = userText.trim();
  if (lang === "zh") {
    return `收到：「${trimmed}」。我是 mock 模型，当前只装配了 ${toolName} 工具，可以让我列出已注册设备。`;
  }
  return `Received: "${trimmed}". This is the mock model; it only ships the ${toolName} tool for now.`;
}

/** 把整份 transcript 压成一段文本，用于估算 usage（system 段也计入输入侧）。 */
function renderPrompt(context: TranscriptContext): string {
  return context.messages.map((message) => contentText(message.content)).join("\n");
}

/**
 * 创建 mock `StreamFn`。
 *
 * 决定回复内容的规则（确定性，便于测试断言）：
 *   - 最后一条是 toolResult → 把工具结果说成人话（工具回合的收尾）
 *   - 最后一条是 user 且命中意图词 → 发起 1 次 `list_devices` 工具调用
 *   - 最后一条是 user 其他内容 → 回声式文本回复
 *   - 用户在中文提问就用中文回答（语言跟随输入）
 */
export function createMockStreamFn(options: MockStreamFnOptions = {}): StreamFn {
  const resolved: ResolvedMockOptions = {
    chunkDelayMs: options.chunkDelayMs ?? 8,
    chunkSize: options.chunkSize ?? 12,
    deviceIntentPattern: options.deviceIntentPattern ?? DEFAULT_DEVICE_INTENT_PATTERN,
    deviceToolName: options.deviceToolName ?? MOCK_TOOL_NAME,
    truncateToolCalls: options.truncateToolCalls ?? false,
  };
  let toolCallSeq = 0;

  return (model, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();
    const last = lastNonSystemMessage(context.messages);
    const userText = lastUserText(context.messages);
    const lang: "zh" | "en" = CJK_PATTERN.test(userText) ? "zh" : "en";
    const response = new MockResponse({
      stream,
      model,
      options: resolved,
      signal: streamOptions?.signal,
      promptText: renderPrompt(context),
    });

    void (async () => {
      try {
        response.start();

        if (!last) {
          await response.writeText(lang === "zh" ? "没有收到任何输入。" : "No input was provided.");
          response.finishStop();
          return;
        }

        if (last.role === "toolResult") {
          const ok = await response.writeText(summarizeToolResult(last, lang));
          if (ok) response.finishStop();
          return;
        }

        if (last.role === "user" && resolved.deviceIntentPattern.test(userText)) {
          toolCallSeq += 1;
          const productId = productIdFromContext(context.messages);
          response.writeToolCall({
            type: "toolCall",
            id: `mock-call-${toolCallSeq}`,
            name: resolved.deviceToolName,
            // 作用域内就带上 productId，否则空对象表示"全部产品"
            arguments: productId ? { productId } : {},
          });
          if (resolved.truncateToolCalls) {
            response.finishLength();
          } else {
            response.finishToolUse();
          }
          return;
        }

        const ok = await response.writeText(echoReply(userText, lang, resolved.deviceToolName));
        if (ok) response.finishStop();
      } catch (error) {
        // StreamFn 契约：不得 throw，失败必须编码进事件流
        response.finishError(error instanceof Error ? error.message : String(error));
        stream.end();
      }
    })();

    return stream;
  };
}
