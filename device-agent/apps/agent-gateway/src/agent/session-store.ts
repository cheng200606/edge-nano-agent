/**
 * 会话落盘：`<home>/pi-sessions/<sessionId>.jsonl`，一个会话一个文件，可续聊。
 *
 * 对应真实源码：apps/agent-gateway/src/agent/pi/session.ts + paths.ts（教学简化版）
 *
 * 为什么自己写而不是用 pi-coding-agent 的 SessionManager：
 *   1. 本章只需要"一个会话一个 jsonl + 能读回来续聊"，SessionManager 还带来
 *      agentDir/资源加载/settings 一整串依赖；M4 不引额外包。
 *   2. 教学版格式必须可肉眼检查，所以只用两种行：
 *        {"type":"session","v":1,"id":"s1","createdAt":1700000000000}   ← 首行，缺了就是坏文件
 *        {"type":"message","message":{...AgentMessage}}                 ← 之后每行一条消息
 *      首行 header 的 `id` 字段与指南 5.3.3 的 `hasSessionHeader` 判定一致。
 *
 * 三个必须守住的不变量：
 *   a) sessionId 一律先过 validateSessionId，再拼路径；拼完还要做目录包含性检查
 *      （`../` 一旦混进来就能写到任意目录，这是最容易被忽视的路径穿越点）。
 *   b) 坏行（半行 JSON / 未知 type / 不是消息对象）**跳过而不是抛错**：
 *      进程在写一行的中间被杀会留下半行，直接让整个会话不可用代价太大。
 *   c) 任何写入之后，首行必须是合法 header；发现文件存在但 header 坏了就重写修复。
 *
 * 只用同步 fs：
 *   写会话发生在 turn 结束那一刻，一次几十 KB；同步写能保证同会话内的追加顺序，
 *   避免异步 appendFile 交错。日志（每行都写）才需要异步流。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { type SESSION_ID_ERRORS, validateSessionId } from "@device-agent/shared/session-contract";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const SESSION_FILE_EXTENSION = ".jsonl";
export const SESSION_FORMAT_VERSION = 1;

/** 落盘错误码。错误文案一律英文，服务端不得硬编码中文。 */
export const SESSION_STORE_ERRORS = {
  SESSION_ID_INVALID: "SESSION_ID_INVALID",
  PATH_ESCAPE: "SESSION_PATH_ESCAPE",
} as const;

export type SessionStoreErrorCode =
  | (typeof SESSION_STORE_ERRORS)[keyof typeof SESSION_STORE_ERRORS]
  | (typeof SESSION_ID_ERRORS)[keyof typeof SESSION_ID_ERRORS];

export class SessionStoreError extends Error {
  readonly code: SessionStoreErrorCode;

  constructor(code: SessionStoreErrorCode, message: string) {
    super(message);
    this.name = "SessionStoreError";
    this.code = code;
  }
}

/** 会话文件首行。字段名 `id` 与指南中的 header 判定保持一致。 */
export interface SessionHeader {
  type: "session";
  v: number;
  id: string;
  createdAt: number;
}

export interface SessionMessageLine {
  type: "message";
  message: AgentMessage;
}

export type SessionLine = SessionHeader | SessionMessageLine;

export interface LoadedSession {
  sessionId: string;
  /** 会话文件绝对路径（测试与排障要用） */
  file: string;
  exists: boolean;
  header?: SessionHeader;
  /** 只含 user / assistant / toolResult；system 段落按回合重新生成，不落盘 */
  messages: AgentMessage[];
  /** 被跳过的坏行数（半行 JSON、未知 type、缺 role 的对象） */
  skippedLines: number;
}

export interface AppendResult {
  file: string;
  appended: number;
  /** 是否顺手重写了文件（补 header 或清掉坏行） */
  repaired: boolean;
}

/** 落盘的角色白名单：system 不落盘，避免把过期的工具清单/时间固化进历史。 */
const PERSISTED_ROLES = ["user", "assistant", "toolResult"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionHeader(value: unknown): value is SessionHeader {
  if (!isRecord(value)) return false;
  return (
    value.type === "session" &&
    typeof value.v === "number" &&
    typeof value.id === "string" &&
    typeof value.createdAt === "number"
  );
}

/** 只接受能安全回灌给模型的三种消息；其余一律视为坏行。 */
function isPersistedMessage(value: unknown): value is AgentMessage {
  if (!isRecord(value)) return false;
  const role = value.role;
  if (typeof role !== "string") return false;
  if (!(PERSISTED_ROLES as readonly string[]).includes(role)) return false;
  return typeof value.content === "string" || Array.isArray(value.content);
}

function isMessageLine(value: unknown): value is SessionMessageLine {
  if (!isRecord(value)) return false;
  return value.type === "message" && isPersistedMessage(value.message);
}

export class SessionStore {
  readonly dir: string;
  private readonly rootDir: string;

  constructor(dir: string) {
    this.rootDir = resolve(dir);
    this.dir = this.rootDir;
  }

  /**
   * 会话文件路径。**所有**对文件的访问都必须经过这里，
   * 这样 sessionId 校验不可能被绕过。
   */
  pathFor(sessionId: string): string {
    const validation = validateSessionId(sessionId);
    if (!validation.ok) {
      throw new SessionStoreError(
        validation.code ?? SESSION_STORE_ERRORS.SESSION_ID_INVALID,
        validation.message ?? "invalid sessionId",
      );
    }
    const file = resolve(join(this.rootDir, `${sessionId}${SESSION_FILE_EXTENSION}`));
    // 纵深防御：即使上层校验被改坏，也不允许写到 pi-sessions 目录之外
    if (!file.startsWith(`${this.rootDir}${sep}`)) {
      throw new SessionStoreError(
        SESSION_STORE_ERRORS.PATH_ESCAPE,
        "resolved session file escapes the session directory",
      );
    }
    return file;
  }

  has(sessionId: string): boolean {
    return existsSync(this.pathFor(sessionId));
  }

  /** 读回会话：坏行跳过并计数，不因一个字节损坏丢掉整段历史。 */
  load(sessionId: string): LoadedSession {
    const file = this.pathFor(sessionId);
    if (!existsSync(file)) {
      return { sessionId, file, exists: false, messages: [], skippedLines: 0 };
    }

    const messages: AgentMessage[] = [];
    let header: SessionHeader | undefined;
    let skippedLines = 0;

    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (line.length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        skippedLines += 1;
        continue;
      }

      if (isSessionHeader(parsed)) {
        // header 必须与文件名一致；不一致说明文件被拷错了，整份历史不可信
        if (parsed.id === sessionId && header === undefined) {
          header = parsed;
        } else {
          skippedLines += 1;
        }
        continue;
      }
      if (isMessageLine(parsed)) {
        messages.push(parsed.message);
        continue;
      }
      skippedLines += 1;
    }

    return { sessionId, file, exists: true, header, messages, skippedLines };
  }

  /**
   * 追加一个回合产生的消息。
   *
   * `messages` 应当是 `message_end` 收集到的完整消息（不含 system）。
   * 文件不存在 → 先写 header；文件存在但首行 header 不可用 → 重写修复后再追加。
   */
  append(sessionId: string, messages: AgentMessage[]): AppendResult {
    const file = this.pathFor(sessionId);
    const pending = messages.filter((m) => isPersistedMessage(m));
    const loaded = this.load(sessionId);
    mkdirSync(this.rootDir, { recursive: true });

    let repaired = false;
    if (!loaded.exists || loaded.header === undefined || loaded.skippedLines > 0) {
      // 重写文件：第一行永远是 header，坏行被清掉，历史消息保持不变
      const header = loaded.header ?? this.newHeader(sessionId);
      const lines = [
        serializeLine(header),
        ...loaded.messages.map((m) => serializeLine({ type: "message", message: m })),
      ];
      writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
      repaired = true;
    }

    if (pending.length === 0) {
      return { file, appended: 0, repaired };
    }

    // statSync 只在 repaired 之后用于确认文件非空，避免把 header 与消息混在一行
    if (!repaired && statSync(file).size === 0) {
      writeFileSync(file, `${serializeLine(this.newHeader(sessionId))}\n`, "utf8");
      repaired = true;
    }

    const payload = pending.map((m) => serializeLine({ type: "message", message: m })).join("\n");
    appendFileSync(file, `${payload}\n`, "utf8");
    return { file, appended: pending.length, repaired };
  }

  /** 列出已落盘的会话 ID（非法文件名直接忽略）。 */
  list(): string[] {
    if (!existsSync(this.rootDir)) return [];
    const ids: string[] = [];
    for (const entry of readdirSync(this.rootDir)) {
      if (!entry.endsWith(SESSION_FILE_EXTENSION)) continue;
      const candidate = entry.slice(0, -SESSION_FILE_EXTENSION.length);
      if (!validateSessionId(candidate).ok) continue;
      ids.push(candidate);
    }
    return ids.sort();
  }

  private newHeader(sessionId: string): SessionHeader {
    return {
      type: "session",
      v: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: Date.now(),
    };
  }
}

function serializeLine(line: SessionLine): string {
  return JSON.stringify(line);
}
