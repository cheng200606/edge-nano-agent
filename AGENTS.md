# AGENTS.md

边缘计算课程大作业仓库。**方向（2026-11-23 用户确认）：以老师下发的《Device-Agent 开发指南》为准，用 TypeScript/Bun 还原 device-agent 0.5.1，截止 2026-12-05。**
仓库内旧 EdgeGuard 方案（Python 边缘故障关联 Agent）已降级为历史参考，**勿继续施工**。

## 必读：老师指南（本机路径，勿提交到公开仓库）
`D:\ProfessionalSoftware\project\bianyuan\开发指南\`（Teacher's course material，仓库是 PUBLIC 的，课件内容禁止入库）
- `README.md`：五层架构图、一条消息的完整路径、M0~M9 里程碑、三种还原度（课程采用 **M0~M8 按 L2 验收，L3 仅对 use_command / workflow-runner / timer-runner 三个文件走查**）
- `00-实验单元手册.md`：LU-00~LU-16 单元表（A 必修 80% / B 选修 15% / C 挑战 5%）、296 条需求覆盖矩阵、评分 rubric（需求覆盖 30% + 可验收性 25% + 契约一致性 20% + 代码质量 15% + 工程判断 10%）、裁剪方案——**排期与验收口径以此为准，答辩一律用 LU 编号**
- `01~11 章 + 附录A/B`：分层施工详单，每章自带"验收清单 + 常见坑"，**任何阶段不得跳过验收清单**
- ⚠️ 指南上游《需求说明书》1.3 版（35 组/259 条 FR + 37 条 NFR = 296 条）不在本机，需向老师索取；需求条目细节暂以指南引用为准

## 技术栈与命令（老师规定）
- Bun ≥ 1.3.0（**本机已装 1.4.5**）、Node ≥ 22（本机 v24.20.0 ✓）、TypeScript 5.6、Biome 2.4.5（格式化+lint+import 排序唯一真源）、zod 契约校验、Drizzle + `bun:sqlite`（**实际 24 张表**）、agent 循环用 `@earendil-works/pi-agent-core@1.1.0`（**禁止手写 while 循环**）
- 命令：`bun run start` / `bun run typecheck` / `bun run lint` / `bun test` / `bun build apps/agent-gateway/src/main.ts --compile --outfile dist/device-agent.exe`
- 目录约定（指南 README §6）：`apps/agent-gateway/`（唯一可执行应用）+ `packages/{shared,persistence,iot-platform,prompts,skitter}` + `web/`；运行态 `.device_agent/`（config.json / device_agent.sqlite / logs）不提交
- MQTT broker：EMQX 5.x 或 Mosquitto（M3/LU-04 起需要）；**本机用真实 mosquitto 2.1.4，项目托管在 1884**（1883 被安装器服务占用，停止需管理员，故避开）

## 进度（截至 2026-11-28）
代码位于 `device-agent/`，已按里程碑推进：
- **M0 / LU-01 骨架** ✅ 10 域配置（`.strict()` 拒未知域）、JSONL 日志 ≤8KB、`/livez` + `/readyz` 语义分离、默认只监听 127.0.0.1、CLI 分派
- **M1 / LU-02 契约层** ✅ DeviceSpec（7 类型/3 事件类型/telemetry 兼容）、spec→TypeBox、10 个 MQTT 主题模板、工具描述符、会话 ID 校验
- **M2 / LU-03 持久化** ✅ 24 张表 Drizzle schema + drizzle-kit 迁移 + `DeviceService` 门面（幂等注册、游标分页、命令台账四态、事务级联删除）
- **M3 / LU-04 设备闭环** ✅ 真实 mosquitto(1884) + MQTT 入口 + 命令台账回填 + 本地模拟器；`bun run e2e:m3` 十项断言全 PASS
- **M4 / LU-05 Agent 单轮** ✅ `POST /api/chat` SSE 流式；用 pi-agent-core 的 `Agent` 类（**无手写循环**）；mock StreamFn 可一行配置换真模型；会话落 `pi-sessions/<id>.jsonl` 可续聊
- 质量门：`bun test` 123 pass / 0 fail；`tsc --noEmit` 0 error；`biome check` 0 error
- 一键演示：`bun run demo`（自启 broker + 网关 + 模拟器，打印 curl 命令，Ctrl+C 按序关闭）
- 验收脚本：`bun run e2e:m3`（设备闭环）、`bun run verify:m4`（SSE 15 项断言，不依赖 broker）
- 下一步：**M5 / LU-06 工具系统**（use_command 全链路 + capability-policy 越权 403）

## 硬性规则（评分红线，违反即扣分）
- **L1 契约一致**（占 20%）：接口路径、工具名、配置项必须与原系统相同；端口 3000 默认只监听 127.0.0.1（写死 0.0.0.0 是安全事故）；`/livez` 不查库、`/readyz` 语义分离
- Biome 0 error；禁 `console.*`（用 logger）；禁 `any`；错误必带 `code`（不能 `unknown error` 兜底）；服务端文案禁硬编码中文
- JSONL 日志单行 ≤ 8 KB；模块边界：`shared` 不得 import `persistence`（`lint:boundaries` 挡）
- 状态必须落库：先建 5 张核心表（products / product_versions / devices / device_events / device_commands）跑通再扩 22 张；幂等三件套 = 唯一键 + INSERT OR IGNORE + 去重表；SQLite 必须开 WAL
- 命令下发成功 ≠ completed，台账三态 pending / completed|failed / timeout，超时靠台账轮询不是 setTimeout
- 工具数量动态（无设备 22 基线 → 带 DeviceSpec 25 → 叠加扩展），禁止写死数量断言
- 配置校验失败要列出字段路径；恢复出来的原工程源码不要全量 format（行号漂移）

## 12 天冲刺路线（11.24–12.05，按指南 §6.2 裁剪逻辑压缩，保主干 100%）
- **11.24** LU-00 基线（装 Bun、跑原版 exe、抄 config.json、画消息流程图）+ LU-01 骨架（配置校验/JSONL logger/健康检查/CLI）
- **11.25–11.26** LU-02 契约层（zod DeviceSpec → 工具 schema 派生、mqtt-topics 模板渲染，`bun test packages/shared` 全绿）
- **11.27–11.28** LU-03 持久化（5 核心表 → 22 张，WAL + 幂等三件套 + DeviceService 门面）
- **11.29–11.30** LU-04 设备闭环（default provider + 本地模拟器 + 命令台账 + MQTT ingress，降级不阻塞）
- **12.01** LU-05 Agent 单轮（假模型可跑，SSE `/api/chat`，会话 JSONL + 续聊）
- **12.02** LU-06 工具系统（use_command 全链路 + capability-policy 越权 403）
- **12.03** LU-07 HTTP REST（路由 byMethod/prefixHttpRoutes、405+Allow、优雅关闭顺序）
- **12.04** LU-16 e2e.sh 8 场景 + 答辩材料（架构图 / 需求覆盖矩阵三态 / 已知妥协清单）
- **12.05** 交付缓冲补漏
- 降级为设计文档（不实现）：LU-08 语音/视觉/A2A、LU-09 工作流引擎、LU-10 技能记忆、LU-11(B)、LU-12 控制台、LU-13 仅 bun build、LU-15(C)
- ⚠️ 标准工时 122h vs 实际 ~12 天：单元超期立即砍到"验收命令能跑"的最小实现；契约先定死、状态落库、异常分支必写（指南 §7 三件事）

## 遗留内容（EdgeGuard，已归档勿续写）
- 文档：`01-大作业需求文档.md`（自拟 SRS v1.1）、`02-大作业类型推荐.md`、`03-开发迭代方案.md`（I0~I10 已作废）、`多边缘节点协同...全解析.md`
- 代码：`services/`（Python 骨架，11.21 曾端到端验证）、`docker-compose.yml`、`docker/`——保留作参考，新方案不用
- 可借鉴经验：MQTT 通配符层级匹配踩坑、QoS1 幂等去重、状态落库思想（与指南 LU-03/04 呼应）

## 环境事实（2026-11-28 实测）
- Windows + Git Bash；**Bun 1.4.5 已装**（`C:\Users\berdy\AppData\Roaming\npm\node_modules\bun\bin\bun.exe`）；Node v24.20.0
- **npm 官方源不可达，必须走 npmmirror**（仓库已带 `.npmrc` 固定）；Docker Hub 亦不可达
- **MQTT：真实 mosquitto 2.1.4**，装在 `D:\dsh\bianyuan\mosquitto`，项目托管启动在 **1884**
  - 1883 被安装器注册的 Windows 服务占用（SYSTEM 身份），停止需 UAC 管理员权限，故避开而不是复用
  - 启动/停止：`powershell -ExecutionPolicy Bypass -File device-agent/scripts/mqtt-broker.ps1 start|stop|status`
- pip / PyPI 与 Docker Hub 均不可达；Python 依赖只能在已有镜像里用
- 仓库 PUBLIC，老师课件/需求说明书不得入库

## 工程环境坑（已踩，务必沿用）
- **git push 必须 HTTP/1.1**：默认 HTTP/2 传大包会被重置（实测卡 91s 失败）。已在本仓库设 `http.version=HTTP/1.1`；换机器要重设
- **drizzle-kit 需要 spawn esbuild**：沙箱默认禁止管道型子进程，报 `spawn EPERM`，需完整权限运行
- **drizzle-kit 用 tsx 在系统临时目录建 `tsx-<user>`**，本机报 `EPERM: mkdir`；把 `TEMP`/`TMP` 指到工作区即可
- 因此提供 `bun run db:check` 作为**不依赖 spawn 的数据库验收入口**
- **workspace 包必须在 package.json 里声明 `"workspace:*"` 依赖**：Bun 不会为未声明的 workspace 包建链接，
  表现为 `Cannot find module '@device-agent/shared/xxx'`（tsconfig paths 只在部分场景兜住）
- **`strict:false` 下布尔字面量判别式不窄化**：`ok: true | false` 的联合用 `if (!r.ok)` 收不窄，
  解析结果一律用「带可选字段的单一结构」而非 discriminated union

## Git
- 远程 `origin` = github.com/cheng200606/edge-nano-agent，主分支 `main`，conventional commits 直接提交 main
