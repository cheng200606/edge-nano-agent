/**
 * 会话契约：会话 ID 与流式事件的形状。
 *
 * 对应真实源码：packages/shared/src/session-contract.ts
 *
 * 会话 ID 会被用作文件名（pi-sessions/<scope>.jsonl）与作用域 key，
 * 因此必须拒绝控制字符与路径分隔符，否则会写出越界文件。
 *
 * ⚠️ 评分红线：服务端文案禁止硬编码中文，校验失败返回英文 code + message。
 */

export const SESSION_ID_MAX_LENGTH = 128;

/** 允许：字母、数字、下划线、连字符、点、冒号。其余一律拒绝。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
/** 控制字符（0x00-0x1F）与 DEL（0x7F） */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 显式检测控制字符是这里的职责
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;

export const SESSION_ID_ERRORS = {
  EMPTY: "SESSION_ID_EMPTY",
  CONTROL_CHARS: "SESSION_ID_CONTROL_CHARS",
  TOO_LONG: "SESSION_ID_TOO_LONG",
  ILLEGAL_CHARS: "SESSION_ID_ILLEGAL_CHARS",
  RESERVED: "SESSION_ID_RESERVED",
} as const;

export type SessionIdErrorCode = (typeof SESSION_ID_ERRORS)[keyof typeof SESSION_ID_ERRORS];

export interface SessionIdValidation {
  ok: boolean;
  code?: SessionIdErrorCode;
  message?: string;
}

export function validateSessionId(id: string): SessionIdValidation {
  if (typeof id !== "string" || id.length === 0) {
    return { ok: false, code: SESSION_ID_ERRORS.EMPTY, message: "sessionId must not be empty" };
  }
  if (CONTROL_CHAR_PATTERN.test(id)) {
    return {
      ok: false,
      code: SESSION_ID_ERRORS.CONTROL_CHARS,
      message: "sessionId must not contain control characters",
    };
  }
  if (id.length > SESSION_ID_MAX_LENGTH) {
    return {
      ok: false,
      code: SESSION_ID_ERRORS.TOO_LONG,
      message: `sessionId exceeds ${SESSION_ID_MAX_LENGTH} characters`,
    };
  }
  if (!SESSION_ID_PATTERN.test(id)) {
    return {
      ok: false,
      code: SESSION_ID_ERRORS.ILLEGAL_CHARS,
      message: "sessionId may only contain letters, digits, _ . : -",
    };
  }
  if (id === "." || id === "..") {
    return {
      ok: false,
      code: SESSION_ID_ERRORS.RESERVED,
      message: "sessionId must not be . or ..",
    };
  }
  return { ok: true };
}

/** 把任意外部输入规范成合法会话 ID（不合法时用随机后缀兜底）。 */
export function normalizeSessionId(raw: string | undefined, fallbackPrefix = "session"): string {
  const candidate = (raw ?? "").trim();
  if (validateSessionId(candidate).ok) return candidate;
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${fallbackPrefix}-${suffix}`;
}

/** 一次 Agent 回合的流式事件类型。 */
export const AGENT_REPLY_EVENT_KINDS = [
  "delta",
  "tool_start",
  "tool_result",
  "usage",
  "error",
  "done",
] as const;
export type AgentReplyEventKind = (typeof AGENT_REPLY_EVENT_KINDS)[number];

export interface AgentReplyEvent {
  kind: AgentReplyEventKind;
  sessionId: string;
  /** delta 的增量文本；tool_* 的工具名；error 的错误码 */
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  errorCode?: string;
  seq?: number;
}
