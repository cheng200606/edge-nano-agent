/**
 * 模型装配：从 `config.models.agent` 得到一个 `Model` 描述 + 一个 `StreamFn`。
 *
 * 对应真实源码：apps/agent-gateway/src/agent/config.ts（resolveModel / buildPiAuthBundle）
 *
 * 这是 M4「mock 与真模型可互换」的**唯一开关点**：
 *
 *   provider === "mock"            → createMockStreamFn()（纯本地，无网络，无 Key）
 *   provider === "openai"          → pi-ai 的 openai-completions 适配器
 *   provider === "volcengine"      → 同上（豆包/方舟走 OpenAI 兼容协议，只需换 baseUrl）
 *
 * 因此接真模型**不需要改 agent/turn.ts 一行代码**，只改 config.json：
 *
 *   {
 *     "models": {
 *       "agent": {
 *         "provider": "openai",
 *         "baseUrl": "https://api.openai.com/v1",   // 或 https://ark.cn-beijing.volces.com/api/v3
 *         "apiKey": "sk-...",
 *         "model": "gpt-4o-mini",
 *         "maxTokens": 2048
 *       }
 *     }
 *   }
 *
 * 两个刻意的取舍：
 *   1. 真实 provider 用**动态 import**：mock 模式下进程完全不加载 openai SDK（启动快、
 *      也不会因为缺 SDK 直接崩）。`StreamFn` 允许返回 Promise，所以这里可以 await。
 *   2. apiKey 只在这里从 config 取出、作为 `options.apiKey` 交给 pi-ai；
 *      绝不写进 system prompt、工具参数或日志（日志只打 provider/model）。
 */

import type { ModelConfig } from "@device-agent/shared/device-agent-config";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

import { createMockStreamFn, MOCK_API } from "./model-mock";

/** mock 模型的默认 id（config.models.agent.model 为空时使用）。 */
export const MOCK_MODEL_ID = "mock-agent";
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 2048;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** 各 provider 的默认 baseUrl。留空时兜底，避免真模型分支拿到空串。 */
const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  volcengine: "https://ark.cn-beijing.volces.com/api/v3",
};

/**
 * 构造 pi 需要的模型描述。
 *
 * ⚠️ pi 不接受 "gpt-4o-mini" 这种字符串，必须是带 api/cost/contextWindow 的对象。
 * `api` 决定由哪个适配器发请求；mock 用 "mock" 这个自造 api 名，
 * 表示"这张表永远不会被 provider 适配器消费"。
 */
export function resolveAgentModel(cfg: ModelConfig): Model<Api> {
  const isMock = cfg.provider === "mock";
  const id = cfg.model.trim() || (isMock ? MOCK_MODEL_ID : `${cfg.provider}-default`);
  return {
    id,
    name: id,
    api: isMock ? MOCK_API : "openai-completions",
    provider: cfg.provider,
    baseUrl: cfg.baseUrl.trim() || DEFAULT_BASE_URLS[cfg.provider] || "",
    reasoning: false,
    input: ["text"],
    cost: { ...ZERO_COST },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
}

/**
 * 按配置选出 `StreamFn`。
 *
 * 真实 provider 分支的形状与 `StreamFunction<"openai-completions", SimpleStreamOptions>`
 * 完全一致，只是 `Agent` 持有的是 `Model<Api>`（可能是 mock），所以这里做一次
 * **可证明安全**的收窄：能走到这一行的 model 都由 `resolveAgentModel()` 用
 * `api: "openai-completions"` 造出来。
 */
export function createAgentStreamFn(cfg: ModelConfig): StreamFn {
  if (cfg.provider === "mock") return createMockStreamFn();

  const realStreamFn: StreamFn = async (model, context, options) => {
    const { streamSimple } = await import("@earendil-works/pi-ai/api/openai-completions");
    return streamSimple(model as Model<"openai-completions">, context, options);
  };
  return realStreamFn;
}

/** 供日志与 /api/version 使用：只露 provider/model，绝不露 apiKey。 */
export function describeModel(cfg: ModelConfig): { provider: string; model: string } {
  return {
    provider: cfg.provider,
    model: cfg.model.trim() || (cfg.provider === "mock" ? MOCK_MODEL_ID : "<unset>"),
  };
}
