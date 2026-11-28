/**
 * 配置契约：10 个域的结构、默认值与校验。
 *
 * 对应真实源码：packages/shared/src/device-agent-config-schema.ts
 *
 * ⚠️ zod v4 的 `.default(value)` **不会**把默认值再送进 schema 解析，
 * 因此嵌套对象一律用 `.default(() => SubSchema.parse({}))` 的函数形式，
 * 否则会出现 `models.agent.provider === undefined` 这类"默认值没生效"的问题。
 */
import { z } from "zod";

export const CONFIG_VERSION = 1;

export const CLOUD_ROLES = ["standalone", "cloud-all", "cloud-api", "cloud-worker"] as const;
export type CloudRole = (typeof CLOUD_ROLES)[number];

export const MODEL_PROVIDERS = ["mock", "openai", "volcengine"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// ---------------------------------------------------------------- models
const ModelConfigSchema = z.object({
  provider: z.enum(MODEL_PROVIDERS).default("mock"),
  baseUrl: z.string().default(""),
  apiKey: z.string().default(""),
  model: z.string().default(""),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().positive().max(200_000).default(2048),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
const defaultModelConfig = () => ModelConfigSchema.parse({});

const ModelsSchema = z.object({
  agent: ModelConfigSchema.default(defaultModelConfig),
  vision: ModelConfigSchema.default(defaultModelConfig),
  decision: ModelConfigSchema.default(defaultModelConfig),
});
const defaultModels = () => ModelsSchema.parse({});

// ---------------------------------------------------------------- cloud
const CloudSchema = z.object({
  worker: z.enum(CLOUD_ROLES).default("standalone"),
  instanceId: z.string().default("local"),
});
const defaultCloud = () => CloudSchema.parse({});

// ---------------------------------------------------------------- mqtt
const MqttSchema = z.object({
  // 1884 而非 1883：安装器注册的 mosquitto 服务以 SYSTEM 身份占用了 1883，
  // 停止它需要管理员权限；项目托管 broker 走独立端口，保证换机器可复现。
  brokerUrl: z.string().default("mqtt://127.0.0.1:1884"),
  wsUrl: z.string().default(""),
  clientId: z.string().default("device-agent"),
  keepAliveSeconds: z.number().int().min(5).max(3600).default(60),
  autoReconnect: z.boolean().default(true),
  reconnectPeriodMs: z.number().int().min(500).default(3000),
  cleanStart: z.boolean().default(true),
  username: z.string().default(""),
  password: z.string().default(""),
});
const defaultMqtt = () => MqttSchema.parse({});

// ---------------------------------------------------------------- iotPlatform
const IotPlatformSchema = z.object({
  providerId: z.enum(["default", "fleets", "thingsneural"]).default("default"),
  config: z.record(z.string(), z.unknown()).default({}),
});
const defaultIotPlatform = () => IotPlatformSchema.parse({});

// ---------------------------------------------------------------- voice
const VoiceSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(["volcengine", "aliyun", "aws", "elevenlabs", "none"]).default("none"),
  asrSampleRate: z.number().int().default(16_000),
});
const defaultVoice = () => VoiceSchema.parse({});

// ---------------------------------------------------------------- im
const ImSchema = z.object({
  feishu: z.record(z.string(), z.unknown()).default({}),
  dingtalk: z.record(z.string(), z.unknown()).default({}),
  discord: z.record(z.string(), z.unknown()).default({}),
  telegram: z.record(z.string(), z.unknown()).default({}),
  slack: z.record(z.string(), z.unknown()).default({}),
});
const defaultIm = () => ImSchema.parse({});

// ---------------------------------------------------------------- logging
const LoggingSchema = z.object({
  level: z.enum(LOG_LEVELS).default("info"),
  console: z.boolean().default(true),
  file: z.boolean().default(true),
});
const defaultLogging = () => LoggingSchema.parse({});

// ---------------------------------------------------------------- aiCredits
const AiCreditsSchema = z.object({
  enabled: z.boolean().default(false),
  currency: z.string().default("CNY"),
  defaultLimit: z.number().default(0),
  rates: z.record(z.string(), z.number()).default({}),
  modelMultipliers: z.record(z.string(), z.number()).default({}),
});
const defaultAiCredits = () => AiCreditsSchema.parse({});

// ---------------------------------------------------------------- permissions
const PermissionsSchema = z.object({
  /** 工具白名单；空数组表示"不做裁剪"，放行全部已注册工具 */
  tools: z.array(z.string()).default([]),
});
const defaultPermissions = () => PermissionsSchema.parse({});

// ---------------------------------------------------------------- 顶层
// .strict()：未知配置域必须被拒绝。否则用户写了 `mqqt:` 这种拼写错误时
// 会被静默忽略，出现"改了配置不生效"且极难排查的情况。
export const DeviceAgentConfigSchema = z
  .object({
    version: z.number().int().default(CONFIG_VERSION),
    cloud: CloudSchema.default(defaultCloud),
    mqtt: MqttSchema.default(defaultMqtt),
    models: ModelsSchema.default(defaultModels),
    iotPlatform: IotPlatformSchema.default(defaultIotPlatform),
    voice: VoiceSchema.default(defaultVoice),
    im: ImSchema.default(defaultIm),
    logging: LoggingSchema.default(defaultLogging),
    aiCredits: AiCreditsSchema.default(defaultAiCredits),
    permissions: PermissionsSchema.default(defaultPermissions),
  })
  .strict();

export type DeviceAgentConfig = z.infer<typeof DeviceAgentConfigSchema>;

/** 10 个配置域的名称，用于启动摘要与自检。 */
export const CONFIG_DOMAINS = Object.keys(DeviceAgentConfigSchema.shape) as string[];

export function loadDefaultDeviceAgentConfig(): DeviceAgentConfig {
  return DeviceAgentConfigSchema.parse({});
}

export function formatIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
}
