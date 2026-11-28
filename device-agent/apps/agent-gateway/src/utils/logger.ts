/**
 * 结构化日志：JSONL、按天切分、单行 ≤ 8 KB、不阻塞主流程。
 *
 * 对应真实源码：apps/agent-gateway/src/utils/logger.ts
 * 契约（验收会查）：
 *   - 一行一个 JSON，字段至少含 ts / level / scope / msg
 *   - 单行截断到 8 KB，防止把错误对象整个序列化进日志
 *   - 文件写入走追加流，写失败只降级到 console，不抛异常
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { LOG_LEVELS, type LogLevel } from "@device-agent/shared/device-agent-config";

export const MAX_LOG_LINE_BYTES = 8 * 1024;

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

interface LoggingState {
  level: LogLevel;
  console: boolean;
  file: boolean;
  dir: string;
  ready: boolean;
  pending: string[];
}

const state: LoggingState = {
  level: "info",
  console: true,
  file: true,
  dir: "",
  ready: false,
  pending: [],
};

export function configureLogging(opts: {
  level?: LogLevel;
  console?: boolean;
  file?: boolean;
  dir?: string;
}): void {
  if (opts.level && LOG_LEVELS.includes(opts.level)) state.level = opts.level;
  if (typeof opts.console === "boolean") state.console = opts.console;
  if (typeof opts.file === "boolean") state.file = opts.file;
  if (opts.dir) {
    state.dir = opts.dir;
    state.ready = false;
    state.pending = [];
  }
}

export function getLoggingConfig(): Readonly<typeof state> {
  return state;
}

function todayStamp(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function truncateLine(line: string): string {
  const buf = Buffer.from(line, "utf8");
  if (buf.byteLength <= MAX_LOG_LINE_BYTES) return line;
  // 留出省略号与 JSON 收尾的空间
  const clipped = buf.subarray(0, MAX_LOG_LINE_BYTES - 32).toString("utf8");
  return `${clipped}…[truncated]`;
}

function safeSerialize(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= 3) return "[depth-limit]";
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack?.split("\n")[0] };
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => safeSerialize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
    out[k] = safeSerialize(v, depth + 1);
  }
  return out;
}

// eslint-disable-next-line no-console
function writeConsole(line: string): void {
  // 用 stderr 输出日志，避免与 CLI 的 stdout 结果混在一起
  process.stderr.write(`${line}\n`);
}

async function flush(line: string): Promise<void> {
  if (!state.file || !state.dir) return;
  try {
    if (!state.ready) {
      await mkdir(join(state.dir, "logs"), { recursive: true });
      state.ready = true;
      const queued = state.pending.splice(0);
      for (const q of queued) await persist(q);
    }
    await persist(line);
  } catch {
    // 日志失败不影响主流程
  }
}

async function persist(line: string): Promise<void> {
  const file = join(state.dir, "logs", `${todayStamp()}.log`);
  await appendFile(file, `${line}\n`, "utf8");
}

function emit(level: LogLevel, scope: string, msg: string, extra?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[state.level]) return;

  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(extra ? (safeSerialize(extra) as Record<string, unknown>) : {}),
  };

  let line: string;
  try {
    line = truncateLine(JSON.stringify(record));
  } catch {
    line = JSON.stringify({ ts: record.ts, level, scope, msg: "[unserializable payload]" });
  }

  if (state.console) writeConsole(line);
  if (state.file && state.dir) {
    if (!state.ready) {
      // 首次写入：先入队，避免在 mkdir 完成前丢日志
      state.pending.push(line);
      void flush(state.pending[0]);
      return;
    }
    void flush(line);
  }
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (msg, extra) => emit("debug", scope, msg, extra),
    info: (msg, extra) => emit("info", scope, msg, extra),
    warn: (msg, extra) => emit("warn", scope, msg, extra),
    error: (msg, extra) => emit("error", scope, msg, extra),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
