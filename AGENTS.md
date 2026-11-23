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
- Bun ≥ 1.3.0（**本机未装，LU-00 首项**）、Node ≥ 22（本机 v24.18.0 ✓）、TypeScript 5.6、Biome 2.4.5（格式化+lint+import 排序唯一真源）、zod 契约校验、Drizzle + `bun:sqlite`（22 张表）、agent 循环用 `@earendil-works/pi-agent-core@1.1.0`（**禁止手写 while 循环**）
- 命令：`bun run start` / `bun run typecheck` / `bun run lint` / `bun test` / `bun build apps/agent-gateway/src/main.ts --compile --outfile dist/device-agent.exe`
- 目录约定（指南 README §6）：`apps/agent-gateway/`（唯一可执行应用）+ `packages/{shared,persistence,iot-platform,prompts,skitter}` + `web/`；运行态 `.device_agent/`（config.json / device_agent.sqlite / logs）不提交
- MQTT broker：EMQX 5.x 或 Mosquitto（M3/LU-04 起需要）；本机 1883 被已有 EMQX 容器占用，需复用或避开

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

## 环境事实（2026-11-23 实测）
- Windows + Git Bash；Bun 未装；Node v24.18.0；原版 device-agent.exe 未在本机找到（LU-00 需要原版发行包，待用户提供）
- 仓库 PUBLIC，老师课件/需求说明书不得入库

## Git
- 远程 `origin` = github.com/cheng200606/edge-nano-agent，主分支 `main`，conventional commits 直接提交 main
