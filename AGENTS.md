# AGENTS.md

EdgeGuard —— 多边缘节点协同的工业设备故障关联 Agent（边缘计算课程大作业，选题 A+）。
仓库当前处于需求基线阶段（SRS v1.1），代码尚未创建；动手前先读文档。

## 必读文档（改动前必看）
- `01-大作业需求文档.md`：SRS v1.1 基线。需求、量化指标（G-1~G-8）、MQTT 协议、实验设计、2 周里程碑均以它为准。
- `02-大作业类型推荐.md`：选题论证与环境可行性实测记录。

## 关键决策（已确认，不要推翻）
- 消息总线：amqtt 0.12.2（MQTT 3.1.1），不用 mosquitto / Redis
- 模型：纯 numpy 手写自编码器（< 10k 参数，模型文件 ≤ 200 KB），禁用 torch / scikit-learn
- 网关关联：可解释规则（拓扑树加权 + 根因 Top1 排序），保留 `CorrelationStrategy` 接口
- 架构：8 容器 = 5 边缘节点 + 网关 + 云 + broker，`docker compose up -d` 一键拉起

## 规划目录（SRS 附录 A，创建代码时遵循）
- `docker/`：基础镜像构建（`Dockerfile.base` FROM 本机 `miniob-course:latest`）
- `services/common|node|gateway|cloud/`：协议、MQTT 封装、指标、四个服务模块
- `scenarios/`：故障注入、断网、弱网场景定义；`experiments/`：实验编排与结果落盘
- `scripts/`：一键启动 / 断网 / 演示；`results/` `figures/` `report/`：产物目录

## 环境硬约束（2026-11-21 实测，违反必失败）
- Docker Hub 不可达：禁止 `FROM` 官方镜像，全部基于本机 `miniob-course:latest`（Ubuntu 24.04 + Python 3.12.3 + tc）自建
- PyPI 官网 / 清华源不可达：pip 必须走 `https://mirrors.aliyun.com/pypi/simple/`
- 底座装包必须加 `--break-system-packages`（PEP 668）和 `--ignore-installed`（Debian 装的 psutil 无 RECORD，否则 amqtt 依赖解析报错）
- 弱网用容器内 `tc netem` 真实注入，compose 中需 `cap_add: [NET_ADMIN]`
- 平台为 Windows + Docker Desktop（WSL2 后端）

## 协议与代码约定
- MQTT 主题前缀 `edgeguard/`，主题表见 SRS §6.1；事件通道 QoS1 + 应用层去重，摘要/心跳 QoS0
- 事件载荷 ≤ 400 B，只含 8 维特征指纹，禁止携带原始时序样本（可审计要求，FR-04）
- 聚类窗 1 s（v1.1 由 15 s 收紧）；首个异常 → 根因结论 ≤ 500 ms；告警收敛 85%~95%
- 断网补传保留原始检测时间戳（误差 = 0）；WAL 超限按「保新弃旧」淘汰
- 固定随机种子，同配置两次实验指标差 < 1%（NFR-05）
- 配置外置、类型标注、结构化日志（NFR-07/08）；文档为中文

## Git
- 远程 `origin` = github.com/cheng200606/edge-nano-agent，主分支 `main`，单人课程仓库直接提交 main
