# Device Agent —— 课程实现

按老师《Device-Agent 开发指南》分里程碑重建的、**以设备为中心**的 Agent 运行时。

> 本目录是独立 **Bun workspace**。
> 验收口径：**M0–M8 按 L2 行为一致**（同样的输入产生同样的可观察行为，允许实现差异），
> L3 逐字一致只对 `use_command` / `workflow-runner` / `timer-runner` 三个文件做走查。
> 契约（接口路径、工具名、配置项、表结构）必须与 `device-agent 0.5.1` 保持一致（L1）。

---

## 0. 环境

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Bun | **1.4.5** | 运行时；`bun:sqlite`、`Bun.serve`、`bun test` 都在标准库里 |
| TypeScript | 5.6.3 | 锁定版本，`bun run typecheck` 用 |
| Biome | 2.x | 格式化 + lint + import 排序的唯一真源 |
| zod | 4.6.7 | 注意是 **v4**，与指南示例的 v3 有行为差异，见 §7 |
| drizzle-orm / drizzle-kit | 0.45.4 / 0.31.11 | 24 张表与迁移 |
| mqtt | 5.16.1 | 真实 MQTT 客户端（不走内存假总线） |
| @earendil-works/pi-agent-core | 1.1.0 | **原系统的 Agent 循环**，禁止手写 while |
| @earendil-works/pi-ai | 1.7.0 | mock 流与真模型都依赖它的消息/流类型 |
| Mosquitto | **2.1.4** | 真实 broker，装在 `D:\dsh\bianyuan\mosquitto`，项目托管在 **1884** |

`.npmrc` 已固定 `registry=https://registry.npmmirror.com`（本机官方源不可达）。

---

## 1. 快速开始

```bash
cd device-agent
bun install

# 方式 A：一条命令拉起全套（推荐用于演示）
bun run demo

# 方式 B：分步
bun run mqtt:start        # 起真实 mosquitto（1884）
bun run start             # 起网关（127.0.0.1:3000，含设备模拟器）
```

另开终端：

```bash
curl -s localhost:3000/readyz      # readiness：database + mqtt 都 ready 才 200
curl -s localhost:3000/api/version

# Agent 单轮（SSE 流式）
curl -N -X POST localhost:3000/api/chat \
  -H 'content-type: application/json' \
  -d '{"sessionId":"s1","message":"列出当前产品的设备"}'
```

首次启动会自动：

1. 创建 `.device_agent/config.json`（10 个域的默认配置）
2. 创建 / 迁移 `.device_agent/device_agent.sqlite`（24 张表，WAL 模式）
3. 创建 `.device_agent/logs/<date>.log`（JSONL，单行 ≤ 8 KB）
4. 打印配置摘要与 `Gateway ready`

### 常用脚本

| 命令 | 用途 |
| --- | --- |
| `bun run demo` | 一条命令拉起 broker + 网关 + 模拟器，打印 curl，Ctrl+C 按序关闭 |
| `bun run start` / `dev` | 启动 / 热重载 |
| `bun run typecheck` / `lint` / `format` | 质量门 |
| `bun test` | 全量测试（当前 **123 pass**） |
| `bun run db:check` | 起临时库跑迁移，核对表数 / WAL / FK（不依赖 spawn） |
| `bun run e2e:m3` | 真实 broker 上的设备闭环验收（10 项断言；broker 没起会自启） |
| `bun run verify:m4` | SSE 端到端验收（15 项断言，不依赖 broker） |
| `bun run mqtt:start` / `stop` / `status` | 项目托管 mosquitto |
| `bun run db:generate` | 改 schema 后生成增量迁移 |

---

## 2. 已完成：M0 / LU-01 工程骨架

| 交付项 | 实现 | 验证 |
| --- | --- | --- |
| 配置三层结构 | 代码内置 zod schema + `.device_agent/config.json` + 环境变量覆盖 | 首启播种、坏配置回退默认值并记 issues |
| 10 个配置域 | `version / cloud / mqtt / models / iotPlatform / voice / im / logging / aiCredits / permissions` | `/api/version` 可见 |
| **未知域被拒** | 顶层 schema 加 `.strict()` | `mqqt:` 这类拼写错误直接报错，不再被静默忽略 |
| 结构化日志 | JSONL、按天切分、单行 ≤ 8 KB、写失败降级不抛异常 | `.device_agent/logs/*.log` |
| 运行时路径 | 区分源码运行与 `--compile` 产物；仓库根用 `bun.lock` 判定 | `.device_agent` 落在 workspace 根 |
| 健康检查语义分离 | `/livez` 不查库；`/readyz` 检查依赖；`/health` 保留做兼容 | `/readyz` 依赖未就绪返回 503 |
| 监听地址 | **默认 127.0.0.1**（可用 `HOST` 覆盖） | 写死 `0.0.0.0` 是安全红线 |
| 入口分派 | `--version` / `--help` / `--print-config`；角色 `standalone` | — |

---

## 3. 已完成：M1 / LU-02 契约层

`packages/shared/src/` 下的契约与约束：

| 文件 | 契约内容 | 关键约束 |
| --- | --- | --- |
| `device-spec.ts` | 7 种类型、3 种事件类型 | 故意不提供 object/嵌套，结构化数据走 `json` |
| `device-spec-schema.ts` | 结构校验 + 三条跨字段约束 | enum 只能用在 string/int/float/enum；元素类型须一致；defaultValue 须兼容且在枚举内；`telemetry → properties` 旧字段兼容 |
| `device-spec-tools.ts` | DeviceSpec → TypeBox 工具参数 | 命令名是字面量枚举（**模型无法编造命令**）；`additionalProperties: false` |
| `mqtt-topics.ts` | 10 个主题模板 + 渲染 / 反解 / 通配 | 占位符含 `/` 抛错；空产品 ID 兜底为 `_`；`v1/` 与 `device-agent/` 双前缀是**历史兼容，不可统一** |
| `agent-tool-descriptor.ts` | 工具描述符注册表 | 10 个内置工具 / 10 个分组；写文件类 `approval: always` |
| `session-contract.ts` | 会话 ID 与流式事件 `AgentReplyEvent` | 拒绝控制字符、路径分隔符、`..`；长度 ≤ 128 |

> 这些约束都是"看起来能跑、但会静默出错"的地方：拼错的配置域被忽略、含 `/` 的产品 ID 订阅到别人的主题、
> 模型往工具参数里塞多余字段。所以每条都配了断言。

---

## 4. 已完成：M2 / LU-03 持久化

**24 张表** = 指南 22 张 + `product_versions` + `device_commands`
（后两张是 `AGENTS.md` 点名的核心表，指南清单未单列，取并集；总数仍满足 `≥ 22` 的硬指标）。

| 分组 | 表 |
| --- | --- |
| 产品与设备 | `products` / `product_versions` / `devices` / `tags` / `device_tags` |
| 设备数据 | `device_events`（13 种事件类型，只增不改，按天清理） |
| 命令台账 | `device_commands`（pending / completed / failed / timeout 四态） |
| 自动化 | `workflow_rules` / `workflow_runs` / `workflow_run_steps` / `workflow_dedupe_keys` |
| 定时 | `agent_timers` / `agent_timer_runs` |
| 记忆与身份 | `memory_items` / `memory_events` / `principals` |
| 对外集成 | `webhook_endpoints` / `webhook_credentials` / `webhook_credential_key_check` / `marketplace_cards` / `marketplace_apps` / `app_sessions` |
| 语音 | `voice_keyword_terms` / `voice_question_cache` |

**约束写在 schema 里**（绕过 service 直接写 SQL 也造不出非法行）：
状态列全部 `check`；产品 ID 用 `NOT GLOB '*[^A-Za-z0-9_-]*'`
（注意不能写 `GLOB '[A-Za-z0-9_-]*'`——那只约束首字符，`bad/id` 照样能过）。

**`DeviceService` 门面**（方法对齐指南 3.4.2）落地四个易错点：

1. **注册幂等** —— MQTT 每次重连都会"首见"，不幂等会让设备表指数增长
2. **事件游标分页** —— 用 `id < beforeId`，不用 `offset`（持续写入的表会漏行且越翻越慢）
3. **状态更新带 `last_seen_at`** —— 只改 status 会出现"在线但 3 小时前上报"
4. **删除产品事务级联** —— 显式删 6 张表，不依赖 SQLite 的 `ON DELETE CASCADE`

**命令台账三态 + 超时**：`pending → completed | failed | timeout`，超时由 `expireCommands()` **轮询**判定，
**不用 `setTimeout`**（进程重启后定时器会丢，台账才是唯一事实来源）。
幂等由调用方显式 `idempotencyKey` 驱动（可空，唯一索引建在它上面；SQLite 把 NULL 视为互不相同）。

---

## 5. 已完成：M3 / LU-04 设备闭环

真实 broker 上的完整链路，无内存假总线：

```
设备模拟器 ──publish──► v1/{p}/{d}/telemetry ──► MQTT ingress ──► 设备幂等注册 ──► 影子更新 ──► 事件落库
           ◄─subscribe── device-agent/{p}/device/{d}/commands ◄── CommandDispatcher（台账 pending）
           ──publish──► device-agent/{p}/device/{d}/responses ──► 台账回填 completed/failed
```

| 模块 | 要点 |
| --- | --- |
| `iot-platform/providers/default` | 主题反解、三类上行报文解析、下行命令构造 |
| `devices/mqtt-link.ts` | mqtt@5 封装；**重连交给库的 `reconnectPeriod`**，不自己写 while 重试 |
| `devices/mqtt-ingress.ts` | 坏报文记 `validation_error` 后返回，**不让链路挂掉**；**不自动创建产品**（仅凭主题建产品是安全漏洞） |
| `devices/command-dispatcher.ts` | 建台账 → 发布下行 → 回执回填 → 轮询收敛 timeout；**下发成功 ≠ completed** |
| `devices/simulator.ts` | 独立 MQTT 连接（独立 clientId），发遥测 + 响应命令，可注入响应延迟 |

**降级不阻塞**：broker 连不上时网关照常启动，`/readyz` 报 `mqtt.ready=false`；
`publish` 失败时台账保持 `pending`，由 timeout 收敛。

验收：`bun run e2e:m3` —— 连 broker / readyz / 遥测落库 / 影子 online / 命令发布 / 台账 pending /
回执后 completed / 事件留痕 / 收发计数，共 10 项。

---

## 6. 已完成：M4 / LU-05 Agent 单轮

`POST /api/chat`，SSE 流式：`tool_start → tool_result → delta* → usage → done`。

### 循环是库的，不是我们的

`agent/turn.ts` 里没有任何 `while` 循环，只有：

```ts
const agent = new Agent({ initialState, streamFn, ... });
agent.subscribe((event) => { /* 转成 AgentReplyEvent */ });
await agent.prompt(message);
```

工具执行、多轮衔接、`stopReason: "length"` 时的半截工具调用判定，全部由
`@earendil-works/pi-agent-core@1.1.0` 负责。**这是评分红线**，也最容易"看起来对但实际自己写了一遍"。

### mock 模型 → 真模型只改配置

`agent/model.ts` 的 `createAgentStreamFn()` 按 `config.models.agent.provider` 分派：

```json
"models": { "agent": { "provider": "openai",
                        "baseUrl": "https://api.openai.com/v1",
                        "apiKey": "sk-...",
                        "model": "gpt-4o-mini" } }
```

`provider !== "mock"` 时走 pi-ai 的 `openai-completions`（**动态 import**，mock 模式下进程完全不加载该 SDK）。
OpenAI 兼容端点（豆包 / ollama / vLLM）只换 `baseUrl`。**工具、事件流、SSE、会话落盘一行不改。**

### 工具回灌是真的

mock 从 system prompt 读产品作用域 → 发起 `list_devices` → 工具用 `DeviceService` **真查库** →
结果以 `toolResult` 回灌 → mock 把 JSON 说成人话。SSE 里能逐帧看到这条链。

### 会话

- `<home>/pi-sessions/<sessionId>.jsonl`：首行 `{"type":"session",...}`，之后每行一条消息
- **system 不落盘**（时间 / 工具清单每回合重建，避免冻结过期上下文）
- 坏行跳过并计数；header 损坏时追加前重写修复
- `sessionId` 先过 `validateSessionId`，`pathFor()` 再做一次目录包含性检查（纵深防御）
- 同 sessionId 串行、不同 session 并行（避免并发写同一 jsonl 交错）

### HTTP 契约

- `content-type: text/event-stream`、`cache-control: no-cache, no-transform`、`x-accel-buffering: no`
- 帧 = `event: <kind>` + `data: <AgentReplyEvent JSON>`（含 `sessionId` / `seq`）
- **`done` 永远是最后一帧**；中途失败先 `error` 再补 `done`
- 客户端断开 → `req.signal` → `agent.abort()` → 透传到工具
- 错误体全部英文 `code` + 英文 message；`GET /api/chat` 返回 405 + `Allow`

验收：`bun run verify:m4` —— 15 项断言（帧序 / 会话落盘 / 非法 sessionId 400 / 405 / `/livez` 未破坏）。

---

## 7. 与指南的已知偏差（答辩要能解释）

1. **zod v4 而非 v3**
   v4 的 `.default(value)` **不会**把默认值再送进 schema 解析，导致嵌套默认值失效
   （实测 `models.agent.provider === undefined`）。本实现统一改为 `.default(() => SubSchema.parse({}))`。

2. **`Bun.serve` 没有 `.listen()`**
   指南 1.8 的示例隐含了一个 `listen` 步骤；实际 `Bun.serve()` 返回时已监听。

3. **仓库根判定**
   指南用 `package.json` 定位仓库根；workspace 布局下会误命中 `apps/agent-gateway/package.json`，
   导致 `.device_agent` 建到子包目录。改用 `bun.lock` / `bunfig.toml` 等 monorepo 根标记。

4. **日志写 stderr 而非 stdout**，避免与 CLI 的 `--print-config` 输出混淆污染管道。

5. **`strict: false` 下布尔字面量判别式不窄化**
   tsconfig 沿用 `strict: false`（避免上万条隐式 any），此时 `{ok:true}|{ok:false}` 的联合
   用 `if (!r.ok)` **收不窄**。解析结果一律用「带可选字段的单一结构」而非 discriminated union。

6. **workspace 包必须在各自 `package.json` 声明 `"workspace:*"`**
   Bun 不会为未声明的 workspace 包建链接，表现为 `Cannot find module '@device-agent/shared/xxx'`
   （tsconfig paths 只在部分场景兜住）。

7. **显式声明 `@earendil-works/pi-ai`**
   它只是 pi-agent-core 的传递依赖，Bun 不会提升到顶层。mock 必须用它的
   `createAssistantMessageEventStream()`（`AssistantMessageEventStream` 带私有字段，结构伪造过不了类型）。

8. **命令幂等由显式 `idempotencyKey` 驱动**
   初版唯一键是 `(product, device, command, sentAt)`，`sentAt` 只有毫秒精度——
   同毫秒内两条同名命令会被 `INSERT OR IGNORE` 静默吞掉，表现为"用户连点两次，第二次凭空消失"。
   已改为可空幂等键 + 唯一索引（NULL 不参与唯一性）。

---

## 8. 目录结构

```
device-agent/
├─ apps/agent-gateway/src/
│  ├─ main.ts                    入口：env → 日志 → CLI → 角色分派 → 优雅关闭
│  ├─ gateway.ts                 生命周期聚合：配置 → DB → MQTT → 健康检查 → 超时轮询 → 模拟器 → HTTP
│  ├─ cli/index.ts               commander：--version / --help / --print-config
│  ├─ standalone/
│  │  ├─ health.ts               健康检查注册表（critical 语义）
│  │  └─ http-server.ts          Bun.serve：/livez /readyz /health /api/version /api/chat
│  ├─ devices/
│  │  ├─ mqtt-link.ts            MQTT 封装（重连交给库，降级不阻塞）
│  │  ├─ mqtt-ingress.ts         三类上行 → 注册 / 入库
│  │  ├─ command-dispatcher.ts   命令台账 + 回执回填 + timeout 收敛
│  │  └─ simulator.ts            本地设备模拟器
│  ├─ agent/
│  │  ├─ model.ts                mock ↔ 真模型的唯一开关点
│  │  ├─ model-mock.ts           mock StreamFn（事件协议：text / toolcall）
│  │  ├─ session-store.ts        pi-sessions/*.jsonl 读写
│  │  ├─ system-prompt.ts        提示词拼装（时间 / 作用域 / 设备 / 工具清单）
│  │  ├─ tools.ts                list_devices（TypeBox + DeviceService）
│  │  └─ turn.ts                 用 Agent 类跑回合，事件 → AgentReplyEvent
│  └─ utils/logger.ts            JSONL 结构化日志
├─ packages/
│  ├─ shared/src/                契约（配置 / DeviceSpec / 主题 / 工具描述符 / 会话）
│  ├─ persistence/src/           Drizzle schema + 迁移 + DeviceService
│  └─ iot-platform/src/          default provider（主题与报文翻译）
├─ drizzle/                      drizzle-kit 生成的迁移（0000 建表、0001 幂等键）
├─ config/mosquitto.conf         项目托管 broker 配置（1884）
├─ scripts/                      demo / e2e / verify / broker / db 自检
└─ .device_agent/                运行态（config.json 含密钥、sqlite、logs、pi-sessions）— 不要提交
```

---

## 9. 里程碑进度

| 里程碑 | 对应单元 | 状态 |
| --- | --- | --- |
| M0 工程骨架 | LU-00 / LU-01 | ✅ |
| M1 契约层 | LU-02 | ✅ |
| M2 持久化（24 表） | LU-03 | ✅ |
| M3 设备闭环 | LU-04 | ✅ |
| M4 Agent 单轮 | LU-05 | ✅ |
| M5 工具系统 | LU-06 | ⏳ 下一步 |
| M6 通道与 API | LU-07 | ⏳ |
| M7 工作流 | LU-09 | ⏳ 降级为设计文档 |
| M8 定时 + 技能 | LU-10 | ⏳ 降级为设计文档 |
| M9 控制台 + 发布 | LU-12 / LU-13 | ⏳ 仅 bun build |

质量门当前：`bun test` **123 pass / 0 fail**、`tsc` 0 error、`biome` 0 error。

---

## 10. 下一步（M5 / LU-06 工具系统）

1. `use_command` 全链路：工具 → `CommandDispatcher.send` → 台账 → 等回执 → 结果回灌给模型
2. 工具集补齐（`inspect_device` / `list_devices` / `save_workflow` / `set_timer` …）
3. `capability-policy`：按作用域裁剪可见工具，越权返回 403
4. 工具数量**动态**（无设备基线 → 带 DeviceSpec 增加 → 叠加扩展），**禁止写死数量断言**
