/**
 * M4 / LU-05 单测：Agent 单轮 + 会话落盘 + mock 模型 + 工具回灌。
 *
 * 覆盖验收口径：
 *   1. mock 能产生 `delta` 事件，且最后一定是 `done`
 *   2. 中文"设备"意图能触发**一次**真实的 `list_devices` 工具调用，结果真的回灌给模型
 *   3. 非法 sessionId 被拒（TurnError 带 code），且不落文件
 *   4. 同一 session 第二次对话能带上历史（续聊）
 *   5. 会话文件首行是合法 header；坏行被跳过而不是整份不可用
 *   6. 中止信号一路传进模型，回合以 cancelled 收尾
 *   7. mock → 真模型只改 config（provider 切换后 StreamFn/模型描述跟着换）
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DatabaseHandle, openDatabase } from "@device-agent/persistence/db/client";
import { ensureSchema } from "@device-agent/persistence/db/schema-lifecycle";
import { DeviceService } from "@device-agent/persistence/device-service";
import { loadDefaultDeviceAgentConfig } from "@device-agent/shared/device-agent-config";
import { SESSION_ID_ERRORS } from "@device-agent/shared/session-contract";

import { configureLogging, createLogger } from "../utils/logger";
import { createAgentStreamFn, resolveAgentModel } from "./model";
import { createMockStreamFn, MOCK_TOOL_NAME } from "./model-mock";
import { SessionStore } from "./session-store";
import { buildSystemPrompt, formatCurrentDateTime } from "./system-prompt";
import { LIST_DEVICES_TOOL } from "./tools";
import { TURN_ERRORS, TurnError, type TurnErrorCode, TurnService } from "./turn";

const migrationsFolder = join(import.meta.dir, "..", "..", "..", "..", "drizzle");

let dir = "";
let handle: DatabaseHandle;
let service: DeviceService;
let turn: TurnService;
let store: SessionStore;

function fastTurnService(extra: { chunkDelayMs?: number } = {}): TurnService {
  return new TurnService({
    config: loadDefaultDeviceAgentConfig(),
    home: dir,
    service,
    logger: createLogger("TestAgent"),
    streamFn: createMockStreamFn({ chunkDelayMs: extra.chunkDelayMs ?? 0 }),
    now: () => new Date("2026-11-28T06:05:01.000Z"),
    timeZone: "Asia/Shanghai",
  });
}

beforeAll(() => {
  configureLogging({ level: "error", console: false, file: false });
  dir = mkdtempSync(join(tmpdir(), "da-agent-"));
  handle = openDatabase({ path: join(dir, "t.sqlite") });
  ensureSchema(handle, migrationsFolder);
  service = new DeviceService(handle);
  service.upsertProduct({
    id: "p1",
    name: "智能插座",
    deviceSpec: {
      name: "plug",
      commands: { turn_on: { description: "power on" }, turn_off: { description: "power off" } },
    },
  });
  service.registerDevice("dev-1", "p1");
  turn = fastTurnService();
  store = turn.sessionStore;
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

describe("mock 模型 + 事件流", () => {
  test("纯文本回合产生多个 delta，并以 done 收尾", async () => {
    const result = await turn.runTurn({ sessionId: "s-text", message: "hello there" });

    expect(result.status).toBe("completed");
    const deltas = result.events.filter((e) => e.kind === "delta");
    expect(deltas.length).toBeGreaterThan(1);
    // 每个 delta 都是非空增量
    expect(deltas.every((e) => typeof e.text === "string" && e.text.length > 0)).toBe(true);
    // delta 拼起来就是最终文本
    expect(deltas.map((e) => e.text).join("")).toBe(result.text);
    // 终止帧唯一且在最后
    expect(result.events.filter((e) => e.kind === "done").length).toBe(1);
    expect(result.events.at(-1)?.kind).toBe("done");
    // seq 单调递增，sessionId 一致
    expect(result.events.map((e) => e.seq)).toEqual(result.events.map((_, i) => i));
    expect(result.events.every((e) => e.sessionId === "s-text")).toBe(true);
  });

  test("中文提示用中文回答（语言跟随输入）", async () => {
    const result = await turn.runTurn({ sessionId: "s-zh", message: "你好" });
    expect(result.text).toContain("收到");
  });

  test("命中设备意图时恰好触发一次 list_devices，工具结果真的回灌", async () => {
    const result = await turn.runTurn({ sessionId: "s-tool", message: "列出当前产品的设备" });

    expect(result.status).toBe("completed");
    const toolStarts = result.events.filter((e) => e.kind === "tool_start");
    expect(toolStarts.length).toBe(1);
    expect(toolStarts[0]?.toolName).toBe(MOCK_TOOL_NAME);
    expect(LIST_DEVICES_TOOL).toBe(MOCK_TOOL_NAME);

    const toolResults = result.events.filter((e) => e.kind === "tool_result");
    expect(toolResults.length).toBe(1);
    // 工具真的查了库：输出里带注册过的设备
    expect(JSON.stringify(toolResults[0]?.toolOutput)).toContain("dev-1");

    // 事件顺序：tool_start → tool_result → delta… → done
    const kinds = result.events.map((e) => e.kind);
    expect(kinds.indexOf("tool_start")).toBeLessThan(kinds.indexOf("tool_result"));
    expect(kinds.indexOf("tool_result")).toBeLessThan(kinds.indexOf("delta"));
    expect(kinds.at(-1)).toBe("done");

    // 模型读到了工具结果：最终回答里含设备 id
    expect(result.text).toContain("dev-1");
  });

  test("被截断的工具调用不执行（stopReason=length → 整批判失败）", async () => {
    const truncating = new TurnService({
      config: loadDefaultDeviceAgentConfig(),
      home: dir,
      service,
      logger: createLogger("TestAgentTruncated"),
      streamFn: createMockStreamFn({ chunkDelayMs: 0, truncateToolCalls: true }),
    });

    const result = await truncating.runTurn({ sessionId: "s-truncated", message: "列出设备" });
    const toolResult = result.events.find((event) => event.kind === "tool_result");
    expect(toolResult).toBeDefined();
    // pi 的循环会把这条调用整体判失败，并明确提到 token 上限
    expect(JSON.stringify(toolResult?.toolOutput)).toContain("output token limit");
    expect(JSON.stringify(toolResult?.toolOutput)).toContain('"isError":true');
    // 工具没有真的查库：输出里不应出现任何设备
    expect(JSON.stringify(toolResult?.toolOutput)).not.toContain("dev-1");
    truncating.dispose();
  });
});

describe("会话落盘与续聊", () => {
  test("首行是合法 session header，一个会话一个文件", async () => {
    const result = await turn.runTurn({ sessionId: "s-header", message: "hi" });
    expect(result.persistedMessages).toBeGreaterThan(0);

    const file = store.pathFor("s-header");
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const header = JSON.parse(lines[0] ?? "{}") as { type?: string; id?: string; v?: number };
    expect(header.type).toBe("session");
    expect(header.id).toBe("s-header");
    expect(header.v).toBe(1);

    const loaded = store.load("s-header");
    expect(loaded.header?.id).toBe("s-header");
    expect(loaded.messages.length).toBe(2); // user + assistant
    expect(loaded.messages[0]?.role).toBe("user");
    expect(loaded.messages[1]?.role).toBe("assistant");
    // system 提示词不落盘：否则时间/工具清单被冻进历史
    expect(loaded.messages.some((m) => m.role === "system")).toBe(false);
  });

  test("同一 session 第二次对话能带上历史", async () => {
    const first = await turn.runTurn({ sessionId: "s-continue", message: "hello" });
    const afterFirst = store.load("s-continue").messages.length;
    expect(afterFirst).toBe(first.persistedMessages);

    const second = await turn.runTurn({ sessionId: "s-continue", message: "列出设备" });
    const loaded = store.load("s-continue");
    expect(loaded.messages.length).toBeGreaterThan(afterFirst);
    // 历史里有两条用户消息，说明第一轮没有被覆盖
    expect(loaded.messages.filter((m) => m.role === "user").length).toBe(2);
    // 第二轮走了工具链路
    expect(second.events.some((e) => e.kind === "tool_start")).toBe(true);
  });

  test("坏行被跳过，整份历史仍可用", async () => {
    await turn.runTurn({ sessionId: "s-corrupt", message: "hello" });
    const file = store.pathFor("s-corrupt");
    appendFileSync(file, '{"type":"message","message":{"ro\n', "utf8"); // 半行 JSON（进程被杀）
    appendFileSync(file, '{"type":"unknown","x":1}\n', "utf8"); // 未知 type
    appendFileSync(file, '{"type":"message","message":{"role":"us', "utf8"); // 末尾没有换行

    const loaded = store.load("s-corrupt");
    expect(loaded.skippedLines).toBeGreaterThanOrEqual(2);
    expect(loaded.messages.length).toBe(2);

    // 追加时会重写修复：坏行清掉、header 仍在首行
    const result = await turn.runTurn({ sessionId: "s-corrupt", message: "again" });
    expect(result.status).toBe("completed");
    const repaired = store.load("s-corrupt");
    expect(repaired.skippedLines).toBe(0);
    expect(repaired.messages.length).toBe(4);
    const firstLine = readFileSync(file, "utf8").trim().split("\n")[0] ?? "{}";
    expect((JSON.parse(firstLine) as { type?: string }).type).toBe("session");
  });
});

describe("校验与中止", () => {
  test("非法 sessionId 被拒且带 code，不落文件", async () => {
    const cases: Array<[string, TurnErrorCode]> = [
      ["../evil", SESSION_ID_ERRORS.ILLEGAL_CHARS],
      ["a/b", SESSION_ID_ERRORS.ILLEGAL_CHARS],
      ["..", SESSION_ID_ERRORS.RESERVED],
      ["", SESSION_ID_ERRORS.EMPTY],
    ];
    for (const [sessionId, code] of cases) {
      let caught: unknown;
      try {
        await turn.runTurn({ sessionId, message: "hello" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TurnError);
      expect((caught as TurnError).code).toBe(code);
    }
    // 目录里没有多出任何越界文件
    expect(existsSync(join(dir, "evil.jsonl"))).toBe(false);
  });

  test("空消息被拒", async () => {
    await expect(turn.runTurn({ sessionId: "s-empty", message: "   " })).rejects.toMatchObject({
      code: TURN_ERRORS.MESSAGE_REQUIRED,
    });
  });

  test("dispose 后拒绝新回合", async () => {
    const disposable = fastTurnService();
    disposable.dispose();
    await expect(
      disposable.runTurn({ sessionId: "s-closed", message: "hello" }),
    ).rejects.toMatchObject({ code: TURN_ERRORS.TURN_SERVICE_CLOSED });
  });

  test("中止信号传进模型，回合以 cancelled 收尾", async () => {
    const abortable = fastTurnService({ chunkDelayMs: 2 });
    const controller = new AbortController();
    let sawDelta = false;

    const result = await abortable.runTurn(
      { sessionId: "s-abort", message: "hello world" },
      {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.kind === "delta" && !sawDelta) {
            sawDelta = true;
            controller.abort();
          }
        },
      },
    );

    expect(sawDelta).toBe(true);
    expect(result.status).toBe("cancelled");
    expect(result.errorCode).toBe(TURN_ERRORS.AGENT_ABORTED);
    expect(result.events.some((e) => e.kind === "error")).toBe(true);
    expect(result.events.at(-1)?.kind).toBe("done");
    abortable.dispose();
  });
});

describe("提示词与模型装配", () => {
  test("系统提示词含时间、允许的命令 ID、设备作用域", () => {
    const prompt = buildSystemPrompt({
      now: new Date("2026-11-28T06:05:01.000Z"),
      timeZone: "Asia/Shanghai",
      productId: "p1",
      devices: [{ deviceId: "dev-1", productId: "p1", name: "plug", status: "online" }],
      commandIds: ["turn_on", "turn_off"],
      toolNames: ["list_devices"],
    });

    expect(prompt).toContain("Current time: 2026-11-28 14:05:01 GMT+08:00 (Asia/Shanghai)");
    expect(prompt).toContain("turn_on");
    expect(prompt).toContain("dev-1");
    expect(prompt).toContain("Product scope: p1");
    // 注入的 JSON 必须被显式声明为数据而非指令
    expect(prompt).toContain("never instructions");
    // 工具清单来自本回合真实装配，不写死数量
    expect(prompt).toContain("list_devices");
    expect(prompt).not.toMatch(/\b25\b/);
  });

  test("无设备时提示词明确禁止编造 deviceId", () => {
    const prompt = buildSystemPrompt({
      now: new Date("2026-11-28T06:05:01.000Z"),
      timeZone: "Asia/Shanghai",
      devices: [],
      commandIds: [],
      toolNames: [],
    });
    expect(prompt).toContain("No device is registered");
  });

  test("非法时区不抛错，回退 UTC", () => {
    const text = formatCurrentDateTime(new Date("2026-11-28T06:05:01.000Z"), "Not/AZone");
    expect(text).toContain("UTC");
  });

  test("provider=mock 用 mock StreamFn；provider=openai 换成 openai-completions", () => {
    const mockConfig = loadDefaultDeviceAgentConfig().models.agent;
    expect(mockConfig.provider).toBe("mock");
    expect(typeof createAgentStreamFn(mockConfig)).toBe("function");

    const openaiConfig = {
      ...mockConfig,
      provider: "openai" as const,
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
    };
    const model = resolveAgentModel(openaiConfig);
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("https://api.example.com/v1");
    expect(model.id).toBe("gpt-4o-mini");
    expect(typeof createAgentStreamFn(openaiConfig)).toBe("function");
    // mock 的模型描述不会被当成 openai 请求发出去
    expect(resolveAgentModel(mockConfig).api).toBe("mock");
  });

  test("SessionStore 直接拒绝路径穿越", () => {
    const isolated = new SessionStore(join(dir, "pi-sessions"));
    expect(() => isolated.pathFor("../escape")).toThrow();
    expect(isolated.list()).not.toContain("../escape");
  });
});
