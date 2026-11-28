# Device Agent —— 课程实现

按《Device-Agent 开发指南》分里程碑重建的、以设备为中心的 Agent 运行时。

> 本目录是**独立 Bun workspace**，与上级目录的文档、教材解耦。
> 验收口径：**L1 契约一致 + L2 行为一致**（接口路径、工具名、配置项、表结构与原系统一致，内部实现自写）。

---

## 0. 环境

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Bun | **1.4.5** | 已安装（`C:\Users\berdy\AppData\Roaming\npm\node_modules\bun\bin\bun.exe`） |
| TypeScript | 5.6.3 | 锁定版本，`bun run typecheck` 用 |
| zod | 4.6.7 | 注意是 **v4**，与指南示例的 v3 有差异，见 §5 |
| mqtt | 5.16.1 | M3 起使用 |
| drizzle-orm | 0.45.4 | M2 起使用 |
| @earendil-works/pi-agent-core | 1.1.0 | **原系统的 Agent 循环**，M4 起使用 |
| Mosquitto | **2.1.4**（真实 broker） | 装在 `D:\dsh\bianyuan\mosquitto`，项目托管启动在 **1884** |

npm 官方源在本机不稳定，`.npmrc` 已固定 `registry=https://registry.npmmirror.com`。

### MQTT Broker

```powershell
# 启动（首次或重启后）
powershell -ExecutionPolicy Bypass -File scripts\mqtt-broker.ps1 start
powershell -ExecutionPolicy Bypass -File scripts\mqtt-broker.ps1 status
powershell -ExecutionPolicy Bypass -File scripts\mqtt-broker.ps1 stop
```

**为什么是 1884 而不是 1883**：mosquitto 安装器会注册一个以 SYSTEM 身份运行的
Windows 服务并占用 `127.0.0.1:1883`，停止它需要 UAC 管理员权限。项目不依赖该服务，
改用独立端口 + 项目自带配置（`config/mosquitto.conf`），换机器也能复现。

**为什么用 WMI 启动**：broker 是长驻进程，若作为普通子进程启动，自动化宿主会
等待整棵进程树退出，表现为命令卡死。脚本用 `Win32_Process.Create` 让 broker
脱离进程树，调用立即返回。

---

## 1. 快速开始

```bash
cd device-agent

bun install          # 已装好，重装用
bun run start        # 启动网关（默认 http://127.0.0.1:3000）

# 另开一个终端
curl -s localhost:3000/health      | jq
curl -s localhost:3000/ready       | jq
curl -s localhost:3000/api/version | jq
```

首次启动会自动：

1. 在仓库根创建 `.device_agent/config.json`（10 个域的默认配置）
2. 创建 `.device_agent/logs/<date>.log`（JSONL，单行 ≤ 8 KB）
3. 打印配置摘要与 `Gateway ready`

常用脚本：

| 命令 | 用途 |
| --- | --- |
| `bun run start` | 启动 |
| `bun run dev` | 热重载启动 |
| `bun run typecheck` | tsc 类型检查（当前 0 error） |
| `bun run lint` | Biome 检查（当前 0 error） |
| `bun run format` | 格式化 |
| `bun test` | 单元测试 |

---

## 2. 已完成：M0 / LU-01 工程骨架

| 交付项 | 实现 | 验证 |
| --- | --- | --- |
| 配置三层结构 | `config` schema（代码内置）+ `.device_agent/config.json`（运行值）+ `process.env` 覆盖 | 首启播种、坏配置回退默认值 |
| 10 个配置域 | `cloud / version / mqtt / models / iotPlatform / voice / im / logging / aiCredits / permissions` | `/api/version` 可见 |
| 结构化日志 | JSONL、按天切分、单行 ≤ 8 KB、写失败降级不抛异常 | `.device_agent/logs/*.log` |
| 运行时路径 | 区分源码运行与 `--compile` 产物；仓库根用 `bun.lock` 标记判定 | `.device_agent` 落在仓库根而非子包 |
| 入口分派 | `--version` / `--help` / `--print-config`；角色 `standalone` | `bun apps/.../main.ts --version` |
| 健康检查 | `/health`（liveness，200）、`/ready`（readiness，未就绪 503）、`/api/version` | curl 200 |
| 代码质量 | tsc 0 error、Biome 0 error | `bun run typecheck && bun run lint` |

实测输出：

```
GET /health       200 {"status":"degraded","checks":{"database":{"ready":false,...},"mqtt":{"ready":false,...}},"uptimeMs":5953,"version":"0.5.1"}
GET /api/version  200 {"name":"device-agent","version":"0.5.1","home":"...\\.device_agent","cloud":"standalone","iotPlatform":"default"}
GET /ready        200 {"ready":true,...}
```

> `/health` 现在是 `degraded`，因为数据库（M2）与 MQTT（M3）尚未接入；这两项接上后会转 `ok`。

---

## 3. 已完成：M1 / LU-02 契约层

`packages/shared/src/` 下 8 个源文件 + 3 个测试文件，**50 个测试全绿**。

| 文件 | 契约内容 | 关键约束 |
| --- | --- | --- |
| `device-spec.ts` | 7 种类型、3 种事件类型 | 故意不提供 object/嵌套，结构化数据走 `json` |
| `device-spec-schema.ts` | 结构校验 + 三条跨字段约束 | enum 只允许在 string/int/float/enum；元素类型须一致；defaultValue 须兼容且在枚举内；`telemetry → properties` 兼容 |
| `device-spec-tools.ts` | DeviceSpec → TypeBox 工具参数 | 命令名是字面量枚举（模型无法编造命令）；`additionalProperties:false` |
| `mqtt-topics.ts` | 10 个主题模板 + 渲染/反解/通配 | 占位符含 `/` 抛错；空产品 ID 兜底为 `_`；`v1/` 与 `device-agent/` 双前缀是历史兼容，不可统一 |
| `agent-tool-descriptor.ts` | 工具描述符注册表 | 10 个内置工具，分 10 组；写文件类 `approval: always` |
| `session-contract.ts` | 会话 ID 与流式事件 | 拒绝控制字符、路径分隔符、`..`；长度 ≤ 128 |

**为什么这些约束值得单独写测试**：它们都是"看起来能跑、但会静默出错"的地方——
拼错的配置域会被忽略、含 `/` 的产品 ID 会订阅到别人的主题、模型会往工具参数里塞多余字段。

---

## 4. 目录结构

```
device-agent/
├─ apps/agent-gateway/
│  ├─ package.json
│  ├─ tsconfig.json
│  └─ src/
│     ├─ main.ts                  # 入口：env → 日志 → CLI → 角色分派 → 优雅关闭
│     ├─ gateway.ts               # 生命周期聚合（config → health → http）
│     ├─ cli/index.ts             # commander，三个命令
│     ├─ standalone/
│     │  ├─ health.ts             # 健康检查注册表
│     │  └─ http-server.ts        # Bun.serve：/health /ready /api/version
│     └─ utils/logger.ts          # JSONL 结构化日志
├─ packages/shared/src/
│  ├─ device-agent-config-schema.ts   # 10 域 zod schema + 默认值
│  ├─ device-agent-config.ts          # 播种 / 加载 / 回退 / 摘要
│  ├─ workspace-env.ts                # DEVICE_AGENT_HOME 与 .env
│  ├─ runtime-paths.ts                # 源码 vs 编译产物路径
│  └─ index.ts
├─ config/                        # 预留：随包分发的 config.schema.json
├─ .agents/skills/                # 预留：技能包（M8）
├─ scripts/                        # 预留：构建脚本（M9）
├─ biome.json / tsconfig.base.json / package.json
└─ .device_agent/                  # 运行态（不要提交）
```

---

## 4. 里程碑进度

| 里程碑 | 对应单元 | 状态 |
| --- | --- | --- |
| M0 工程骨架 | LU-00 / LU-01 | ✅ 完成 |
| M1 契约层 | LU-02 | ✅ 完成（50 测试全绿） |
| M2 持久化（22 表） | LU-03 | ⏳ 下一步 |
| M3 设备闭环 | LU-04 | ⏳ |
| M4 Agent 单轮 | LU-05 | ⏳ |
| M5 工具系统 | LU-06 | ⏳ |
| M6 通道与 API | LU-07 | ⏳ |
| M7 工作流 | LU-09 | ⏳ |
| M8 定时 + 技能 | LU-10 | ⏳ |
| M9 控制台 + 发布 | LU-12 / LU-13 | ⏳ |

---

## 5. 与指南的已知偏差（答辩要能解释）

1. **zod v4 而非 v3**
   指南示例用 `DeviceAgentConfigSchema.safeParse`，v3/v4 都支持；但 v4 的
   `.default(value)` **不会**把默认值再送进 schema 解析，导致嵌套默认值失效
   （实测 `models.agent.provider === undefined`）。本实现统一改为
   `.default(() => SubSchema.parse({}))` 的函数形式。

2. **`Bun.serve` 没有 `.listen()`**
   指南 1.8 的示例隐含了一个 `listen` 步骤；实际 `Bun.serve()` 返回时已监听。
   本实现直接返回句柄，并保留一个 `listen()` 兼容函数。

3. **仓库根判定**
   指南用 `package.json` 定位仓库根；在 workspace 布局下会误命中
   `apps/agent-gateway/package.json`，导致 `.device_agent` 建到子包目录。
   本实现改用 `bun.lock` / `bunfig.toml` 等 monorepo 根标记。

4. **日志写 stderr 而非 stdout**
   避免与 CLI 的 `--print-config` 输出混在一起污染管道。

---

## 6. 下一步

1. **M1 契约层**：`DeviceSpec` schema、MQTT 主题渲染、会话与事件契约；配 `bun test` 单测
2. **M2 持久化**：22 张表 + 建表生命周期 + `DeviceService` 聚合
3. **M3 设备闭环**：MQTT 模拟器 → 遥测入库 → `use_command` 下发 → 响应回填
