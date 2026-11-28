# edge-nano-agent

> 边缘计算课程大作业 · **按老师下发的《Device-Agent 开发指南》用 TypeScript / Bun 还原 `device-agent 0.5.1`** · 截止 2026-12-05
>
> 验收口径：M0–M8 按 **L2 行为一致**（同样的输入产生同样的可观察行为），L3 逐字一致只对
> `use_command` / `workflow-runner` / `timer-runner` 三个文件做走查。

---

## 现在能跑什么

```bash
cd device-agent
bun install

bun run demo     # 一条命令：自启真实 mosquitto + 网关 + 本地设备模拟器
```

`demo` 会打印可直接复制的 curl 命令（健康检查 / 版本 / Agent SSE 对话 / 设备事件），
按 `Ctrl+C` 按序关闭（模拟器 → MQTT → HTTP → DB → broker）。

不想起 MQTT 也能验 Agent 链路：

```bash
bun run verify:m4     # 15 项断言，不依赖 broker
```

---

## 进度

| 里程碑 | 对应单元 | 状态 | 关键产出 |
| --- | --- | --- | --- |
| M0 工程骨架 | LU-00 / LU-01 | ✅ | 10 域配置（`.strict()` 拒未知域）、JSONL 日志 ≤8 KB、`/livez`+`/readyz` 语义分离 |
| M1 契约层 | LU-02 | ✅ | DeviceSpec（7 类型/3 事件类型）、spec→TypeBox、10 个 MQTT 主题模板、工具描述符、会话 ID 校验 |
| M2 持久化 | LU-03 | ✅ | **24 张表** Drizzle schema + drizzle-kit 迁移 + `DeviceService` 门面 |
| M3 设备闭环 | LU-04 | ✅ | 真实 mosquitto + MQTT 入口 + 命令台账四态 + 本地模拟器 |
| M4 Agent 单轮 | LU-05 | ✅ | `POST /api/chat` SSE、pi-agent-core 的 `Agent` 类、mock↔真模型一行配置切换 |
| M5 工具系统 | LU-06 | ⏳ | 下一步 |
| M6 通道与 API | LU-07 | ⏳ | |
| M7 工作流 | LU-09 | ⏳ | 降级为设计文档 |
| M8 定时 + 技能 | LU-10 | ⏳ | 降级为设计文档 |
| M9 控制台 + 发布 | LU-12 / LU-13 | ⏳ | 仅 `bun build` |

排期与验收口径以 [`AGENTS.md`](AGENTS.md) 为准，答辩一律用 **LU 编号**。

---

## 验收命令

| 命令 | 验证什么 | 当前结果 |
| --- | --- | --- |
| `bun run typecheck` | tsc 类型检查 | 0 error |
| `bun run lint` | Biome（格式化 + lint + import 排序） | 0 error |
| `bun test` | 单元测试 + 集成测试 | **123 pass / 0 fail** |
| `bun run db:check` | 起临时库跑完迁移，核对表数与 PRAGMA | 24 表 / WAL / FK on |
| `bun run e2e:m3` | 真实 broker 上的设备闭环（10 项断言） | 全 PASS |
| `bun run verify:m4` | SSE 端到端（15 项断言，不依赖 broker） | 全 PASS |
| `bun run demo` | 答辩现场演示 | 可用 |

---

## 仓库结构

```
edge-nano-agent/
├─ AGENTS.md                    项目规约、进度、环境事实、踩过的坑（改代码前先读）
├─ device-agent/                ★ 本次实现（独立 Bun workspace）
│  ├─ apps/agent-gateway/       唯一可执行应用
│  ├─ packages/                 shared / persistence / iot-platform / prompts / skitter
│  ├─ config/                   mosquitto.conf
│  ├─ drizzle/                  drizzle-kit 生成的迁移
│  ├─ scripts/                  demo / e2e / verify / broker / db 自检
│  └─ README.md                 实现细节与已知偏差
└─ （归档）EdgeGuard 旧方案      01-*.md / 02-*.md / 03-*.md / services/ / docker/ 等
```

`device-agent/` 是**唯一在写的目录**，其余为历史材料。

---

## 环境要求

| 项 | 要求 | 本机实测 |
| --- | --- | --- |
| Bun | ≥ 1.3.0 | 1.4.5 |
| Node | ≥ 22（仅 tsc / 工具链用） | v24.20.0 |
| MQTT broker | mosquitto 2.x（真实 broker） | 2.1.4，项目托管在 **1884** |
| 操作系统 | Windows / macOS / Linux | Windows |

- **1884 而非 1883**：mosquitto 安装器会注册一个 SYSTEM 身份的 Windows 服务占着 `127.0.0.1:1883`，
  停止它需要 UAC 管理员权限。项目不依赖该服务，用独立端口 + 自带配置，换机器可复现。
- npm 官方源在本机不可达，`device-agent/.npmrc` 已固定 `registry=https://registry.npmmirror.com`。

---

## 归档：EdgeGuard（勿继续施工）

仓库里 `01-大作业需求文档.md`、`02-大作业类型推荐.md`、`03-开发迭代方案.md`、
`多边缘节点协同的工业设备故障关联 Agent 全解析.md`、`services/`、`docker/`、`docker-compose.yml`
属于 **2026-11-23 之前的方向**（Python 边缘故障关联 Agent），已降级为历史参考。

方向已于 2026-11-23 转为老师下发的《Device-Agent 开发指南》（TypeScript / Bun），
不要再往 EdgeGuard 里加功能。其中可借鉴的经验（MQTT 通配符层级匹配、QoS1 幂等去重、
状态落库思想）已吸收进 `device-agent/` 的 LU-03 / LU-04。

---

## 注意

- 仓库是 **PUBLIC** 的。老师下发的课件、《需求说明书》禁止入库。
- `device-agent/.device_agent/`（config.json 含密钥、sqlite、日志）与 `node_modules/` 已 gitignore。
