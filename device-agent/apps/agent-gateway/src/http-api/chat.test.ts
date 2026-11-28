/**
 * `POST /api/chat` 的 HTTP 层单测：不启真端口，直接调 handler。
 *
 * 验收口径（任务书原文）：
 *   curl -N -X POST localhost:3000/api/chat -d '{"sessionId":"s1","message":"列出当前产品的设备"}'
 *   → 若干 `event: delta` … 最后 `event: done`
 *
 * 这里断言的就是那条 curl 在协议层会看到的东西，外加 4 条错误分支必须有英文 code。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DatabaseHandle, openDatabase } from "@device-agent/persistence/db/client";
import { ensureSchema } from "@device-agent/persistence/db/schema-lifecycle";
import { DeviceService } from "@device-agent/persistence/device-service";
import { loadDefaultDeviceAgentConfig } from "@device-agent/shared/device-agent-config";
import type { AgentReplyEvent } from "@device-agent/shared/session-contract";
import { SESSION_ID_ERRORS } from "@device-agent/shared/session-contract";

import { createMockStreamFn } from "../agent/model-mock";
import { TurnService } from "../agent/turn";
import { configureLogging, createLogger } from "../utils/logger";
import { CHAT_ERRORS, CHAT_ROUTE, createChatHandler, formatSseFrame } from "./chat";

const migrationsFolder = join(import.meta.dir, "..", "..", "..", "..", "drizzle");

let dir = "";
let handle: DatabaseHandle;
let service: DeviceService;
let turn: TurnService;
let handler: (req: Request) => Promise<Response>;

function post(body: unknown): Request {
  return new Request(`http://127.0.0.1:3000${CHAT_ROUTE}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 把 SSE 文本拆成 [{ event, data }]，断言协议形状而不是整段字符串。 */
function parseFrames(text: string): Array<{ event: string; data: AgentReplyEvent }> {
  const frames: Array<{ event: string; data: AgentReplyEvent }> = [];
  for (const block of text.split("\n\n")) {
    if (block.trim().length === 0) continue;
    const lines = block.split("\n");
    const eventLine = lines.find((line) => line.startsWith("event: "));
    const dataLine = lines.find((line) => line.startsWith("data: "));
    if (!eventLine || !dataLine) continue;
    frames.push({
      event: eventLine.slice("event: ".length),
      data: JSON.parse(dataLine.slice("data: ".length)) as AgentReplyEvent,
    });
  }
  return frames;
}

beforeAll(() => {
  configureLogging({ level: "error", console: false, file: false });
  dir = mkdtempSync(join(tmpdir(), "da-chat-"));
  handle = openDatabase({ path: join(dir, "t.sqlite") });
  ensureSchema(handle, migrationsFolder);
  service = new DeviceService(handle);
  service.upsertProduct({ id: "p1", name: "smart plug" });
  service.registerDevice("dev-1", "p1");
  turn = new TurnService({
    config: loadDefaultDeviceAgentConfig(),
    home: dir,
    service,
    logger: createLogger("TestChat"),
    streamFn: createMockStreamFn({ chunkDelayMs: 0 }),
  });
  handler = createChatHandler({ turn, logger: createLogger("TestChatHttp") });
});

afterAll(() => {
  turn.dispose();
  try {
    service.dispose();
  } catch {
    // ignore
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("POST /api/chat（SSE）", () => {
  test("返回 text/event-stream，delta 在前、done 收尾", async () => {
    const res = await handler(post({ sessionId: "http-1", message: "列出当前产品的设备" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");

    const frames = parseFrames(await res.text());
    expect(frames.length).toBeGreaterThan(2);
    // 事件名与 data.kind 必须一致
    expect(frames.every((frame) => frame.event === frame.data.kind)).toBe(true);
    // 最后一定是 done，且唯一
    expect(frames.at(-1)?.event).toBe("done");
    expect(frames.filter((frame) => frame.event === "done").length).toBe(1);
    // 工具调用链路通过 SSE 真的透出去了
    expect(frames.some((frame) => frame.event === "tool_start")).toBe(true);
    expect(frames.some((frame) => frame.event === "tool_result")).toBe(true);
    // 文本增量存在，且 done 里的全文 = 所有 delta 拼接
    const deltas = frames.filter((frame) => frame.event === "delta");
    expect(deltas.length).toBeGreaterThan(1);
    const joined = deltas.map((frame) => frame.data.text ?? "").join("");
    const done = frames.at(-1)?.data;
    expect(done?.text).toBe(joined);
    expect(done?.usage?.totalTokens).toBeGreaterThan(0);
  });

  test("同一 sessionId 第二次请求能续聊（历史来自 jsonl）", async () => {
    await handler(post({ sessionId: "http-2", message: "hello" }));
    const res = await handler(post({ sessionId: "http-2", message: "hello again" }));
    const frames = parseFrames(await res.text());
    expect(frames.at(-1)?.event).toBe("done");
    const loaded = turn.sessionStore.load("http-2");
    expect(loaded.messages.filter((m) => m.role === "user").length).toBe(2);
  });

  test("productId 作用域传进工具参数，未知产品以工具错误回灌给模型", async () => {
    const res = await handler(
      post({ sessionId: "http-3", message: "列出设备", productId: "ghost" }),
    );
    const frames = parseFrames(await res.text());
    const toolStart = frames.find((frame) => frame.event === "tool_start");
    // 模型从 system prompt 读到作用域，并把它填进了工具参数
    expect(toolStart?.data.toolInput).toEqual({ productId: "ghost" });

    const toolResult = frames.find((frame) => frame.event === "tool_result");
    expect(toolResult).toBeDefined();
    // 工具抛错 → agent loop 转成 isError 的工具结果，回合仍正常收尾
    expect(JSON.stringify(toolResult?.data.toolOutput)).toContain("ghost");
    expect(JSON.stringify(toolResult?.data.toolOutput)).toContain('"isError":true');
    expect(frames.at(-1)?.event).toBe("done");
  });
});

describe("错误分支必须带英文 code", () => {
  test("非法 sessionId → 400 + code，且不是 SSE", async () => {
    const res = await handler(post({ sessionId: "../etc/passwd", message: "hi" }));
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe(SESSION_ID_ERRORS.ILLEGAL_CHARS);
    expect(body.message).toMatch(/sessionId/);
  });

  test("缺 sessionId → 400 + SESSION_ID_EMPTY", async () => {
    const res = await handler(post({ message: "hi" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe(SESSION_ID_ERRORS.EMPTY);
  });

  test("空 message → 400 + CHAT_MESSAGE_REQUIRED", async () => {
    const res = await handler(post({ sessionId: "http-4", message: "   " }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe(CHAT_ERRORS.MESSAGE_REQUIRED);
  });

  test("message 不是字符串 → 400 + CHAT_MESSAGE_NOT_STRING", async () => {
    const res = await handler(post({ sessionId: "http-4", message: 42 }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe(CHAT_ERRORS.MESSAGE_NOT_STRING);
  });

  test("坏 JSON → 400 + CHAT_INVALID_JSON", async () => {
    const res = await handler(
      new Request(`http://127.0.0.1:3000${CHAT_ROUTE}`, { method: "POST", body: "{not json" }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe(CHAT_ERRORS.INVALID_JSON);
  });

  test("超长消息 → 400 + CHAT_MESSAGE_TOO_LONG（流式开始前就拒）", async () => {
    const strict = createChatHandler({
      turn,
      logger: createLogger("TestChatStrict"),
      maxMessageChars: 8,
    });
    const res = await strict(post({ sessionId: "http-long", message: "123456789" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe(CHAT_ERRORS.MESSAGE_TOO_LONG);
  });

  test("body 不是对象 → 400 + CHAT_BODY_NOT_OBJECT", async () => {
    const res = await handler(
      new Request(`http://127.0.0.1:3000${CHAT_ROUTE}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([1, 2, 3]),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe(CHAT_ERRORS.BODY_NOT_OBJECT);
  });

  test("GET → 405 + Allow: POST", async () => {
    const res = await handler(new Request(`http://127.0.0.1:3000${CHAT_ROUTE}`));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(((await res.json()) as { code?: string }).code).toBe(CHAT_ERRORS.METHOD_NOT_ALLOWED);
  });

  test("别的路径 → 404 NOT_FOUND", async () => {
    const res = await handler(new Request("http://127.0.0.1:3000/api/other"));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code?: string }).code).toBe("NOT_FOUND");
  });
});

describe("SSE 帧格式", () => {
  test("frame 是 event + data 两行加空行", () => {
    const frame = formatSseFrame({ kind: "delta", sessionId: "s1", text: "你", seq: 0 });
    expect(frame.endsWith("\n\n")).toBe(true);
    expect(frame.split("\n")[0]).toBe("event: delta");
    expect(frame.split("\n")[1]?.startsWith("data: {")).toBe(true);
    const payload = JSON.parse(frame.split("\n")[1]?.slice("data: ".length) ?? "{}") as {
      kind?: string;
      text?: string;
    };
    expect(payload.kind).toBe("delta");
    expect(payload.text).toBe("你");
  });
});
