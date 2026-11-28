/**
 * `POST /api/chat` —— 一句话进、SSE 流式文本出。
 *
 * 对应真实源码：apps/agent-gateway/src/channels/http/chat.ts
 *
 * 契约（验收命令）：
 *   curl -N -X POST localhost:3000/api/chat \
 *     -H 'content-type: application/json' \
 *     -d '{"sessionId":"s1","message":"列出当前产品的设备"}'
 *   → 若干 `event: delta` … 最后 `event: done`
 *
 * 为什么用 SSE 而不是 WebSocket：单向流、可直接 curl、断线由浏览器 EventSource 自动重连。
 * 事件名就是 `AgentReplyEvent.kind`（delta / tool_start / tool_result / usage / error / done），
 * `data:` 里是完整事件对象（含 sessionId 与 seq），前端只认事件名也能只认 data。
 *
 * 四条硬性行为：
 *   1. `sessionId` 必须先过 `validateSessionId`；非法直接 400，body 带英文 `code`。
 *   2. **`done` 永远是最后一帧**：中途失败也要在 `error` 之后补一帧 `done`，
 *      否则客户端会一直等（指南「常见坑」第 4 条：前端永远等不到 complete）。
 *   3. 客户端断开（curl 被 Ctrl+C）时 `req.signal` 触发 → 中止回合，
 *      中止信号会一路传进工具（指南 5.5.3）。
 *   4. 只有开始流式之前的错误才用 JSON 错误体；一旦进入 SSE 域，错误走 `error` 事件。
 */
import type { AgentReplyEvent } from "@device-agent/shared/session-contract";
import { validateSessionId } from "@device-agent/shared/session-contract";

import { SessionStoreError } from "../agent/session-store";
import { TurnError, type TurnRequest, type TurnService } from "../agent/turn";
import type { Logger } from "../utils/logger";

export const CHAT_ROUTE = "/api/chat";

export const CHAT_ERRORS = {
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  INVALID_JSON: "CHAT_INVALID_JSON",
  BODY_NOT_OBJECT: "CHAT_BODY_NOT_OBJECT",
  MESSAGE_REQUIRED: "CHAT_MESSAGE_REQUIRED",
  MESSAGE_NOT_STRING: "CHAT_MESSAGE_NOT_STRING",
  MESSAGE_TOO_LONG: "CHAT_MESSAGE_TOO_LONG",
  PRODUCT_ID_INVALID: "CHAT_PRODUCT_ID_INVALID",
  TURN_FAILED: "CHAT_TURN_FAILED",
} as const;

const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  // 关掉所有缓存/缓冲层，否则 curl -N 看到的是一坨而不是流
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

/** 单条消息长度上限的兜底值（TurnService 自身也有一份，二者默认一致）。 */
const DEFAULT_MAX_MESSAGE_CHARS = 16_000;

export interface ChatHandlerOptions {
  turn: TurnService;
  logger: Logger;
  /** 单条消息最大字符数；超限在流式开始前就 400，避免把整本书塞进上下文 */
  maxMessageChars?: number;
}

export type ChatHandler = (req: Request) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonError(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** 一帧 SSE。事件名与 data.kind 保持同一个值，人读和机器读都顺。 */
export function formatSseFrame(event: AgentReplyEvent): string {
  return `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** 把任意异常收敛成英文 code + message；未知异常不吞成 "unknown error"。 */
function classifyFailure(error: unknown): { code: string; message: string } {
  if (error instanceof TurnError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof SessionStoreError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: CHAT_ERRORS.TURN_FAILED,
    message: error instanceof Error ? error.message : String(error),
  };
}

export function createChatHandler(options: ChatHandlerOptions): ChatHandler {
  const { turn, logger } = options;
  const maxMessageChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (url.pathname !== CHAT_ROUTE) {
      return jsonError(404, "NOT_FOUND", `no route for ${req.method} ${url.pathname}`);
    }
    if (req.method !== "POST") {
      return jsonError(405, CHAT_ERRORS.METHOD_NOT_ALLOWED, "use POST for this endpoint", {
        allow: "POST",
      });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonError(400, CHAT_ERRORS.INVALID_JSON, "request body must be valid JSON");
    }
    if (!isRecord(body)) {
      return jsonError(400, CHAT_ERRORS.BODY_NOT_OBJECT, "request body must be a JSON object");
    }

    const rawSessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const sessionValidation = validateSessionId(rawSessionId);
    if (!sessionValidation.ok) {
      return jsonError(
        400,
        sessionValidation.code ?? "SESSION_ID_INVALID",
        sessionValidation.message ?? "invalid sessionId",
      );
    }

    if (typeof body.message !== "string") {
      return jsonError(400, CHAT_ERRORS.MESSAGE_NOT_STRING, "message must be a string");
    }
    const message = body.message.trim();
    if (message.length === 0) {
      return jsonError(400, CHAT_ERRORS.MESSAGE_REQUIRED, "message must not be empty");
    }
    if (message.length > maxMessageChars) {
      return jsonError(
        400,
        CHAT_ERRORS.MESSAGE_TOO_LONG,
        `message exceeds ${maxMessageChars} characters`,
      );
    }

    let productId: string | undefined;
    if (body.productId !== undefined) {
      if (typeof body.productId !== "string") {
        return jsonError(400, CHAT_ERRORS.PRODUCT_ID_INVALID, "productId must be a string");
      }
      const trimmed = body.productId.trim();
      productId = trimmed.length > 0 ? trimmed : undefined;
    }

    const request: TurnRequest = { sessionId: rawSessionId, message, productId };

    // 客户端断开 → 中止本回合（工具内部也能收到 signal）
    const controller = new AbortController();
    const onClientAbort = () => controller.abort();
    req.signal.addEventListener("abort", onClientAbort, { once: true });

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(streamController) {
        let sawDone = false;

        const write = (event: AgentReplyEvent): void => {
          if (event.kind === "done") sawDone = true;
          try {
            streamController.enqueue(encoder.encode(formatSseFrame(event)));
          } catch {
            // 客户端已经走了：继续把回合跑完（事件仍在 TurnResult 里），只是不再写流
          }
        };

        try {
          await turn.runTurn(request, {
            signal: controller.signal,
            onEvent: (event) => write(event),
          });
        } catch (error) {
          const failure = classifyFailure(error);
          logger.error("chat turn failed", {
            sessionId: request.sessionId,
            code: failure.code,
            error: failure.message,
          });
          write({
            kind: "error",
            sessionId: request.sessionId,
            errorCode: failure.code,
            text: failure.message,
          });
        } finally {
          req.signal.removeEventListener("abort", onClientAbort);
          // 终止帧兜底：任何路径都必须让客户端看到 done
          if (!sawDone) {
            write({ kind: "done", sessionId: request.sessionId, text: "" });
          }
          try {
            streamController.close();
          } catch {
            // 流已因客户端断开被取消，忽略
          }
        }
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  };
}
