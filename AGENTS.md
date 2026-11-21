# AGENTS.md

EdgeGuard —— 多边缘节点协同的工业设备故障关联 Agent（边缘计算课程大作业，选题 A+）。
当前阶段：**compose 骨架已完成并端到端验证（2026-11-21）**，节点/网关完整功能按迭代方案推进中；动手前先读文档。

## 必读文档（改动前必看）
- `03-开发迭代方案.md`：迭代计划（I0~I10）、当前状态、风险登记册、SRS v1.2 修订清单——**施工顺序以此为准**
- `01-大作业需求文档.md`：SRS v1.1 基线。需求、量化指标（G-1~G-8）、MQTT 协议、实验设计均以它为准
- `多边缘节点协同的工业设备故障关联 Agent 全解析.md`：SRS v1.1 的对齐参考文档

## 关键决策（已确认，不要推翻）
- 消息总线：**emqx 5.10**（本机缓存镜像，2026-11-21 由 amqtt 变更而来，回退只需改 compose broker 段；理由见迭代方案 §7 D-1）
- 模型：纯 numpy 手写自编码器（< 10k 参数，模型文件 ≤ 200 KB），禁用 torch / scikit-learn **进容器镜像**（宿主机实验脚本允许 sklearn 做 E4 对比）
- 网关关联：可解释规则（拓扑树加权 + 根因 Top1），保留 `CorrelationStrategy` 接口
- 架构：8 容器 = 5 边缘节点 + 网关 + 云 + broker，`docker compose up -d` 一键拉起

## 运行命令
```bash
docker compose up -d                    # 拉起 8 容器
docker compose logs -f gateway cloud    # 观察事件链路
docker compose down -v                  # 干净回收
```
演示剧本内置：Bus-A 三设备 t=15s 母线故障 → 1 条 bus_fault 结论；dev-04 t=40s 单设备结论。宿主机调试端口 18830（1883 被本机另一个 EMQX 容器占用）。

## 目录现状（骨架已存在）
- `docker/Dockerfile.base`：基础镜像（FROM python:3.12-slim + iproute2 + numpy/paho）
- `services/common|node|gateway|cloud/`：公共层与三个服务模块（已可运行）
- 规划中：`scenarios/`（场景）、`experiments/`（实验+训练脚本）、`scripts/`（冒烟/断网/演示）、`results/`、`figures/`、`report/`

## 环境事实（2026-11-21 实测，替代 SRS 旧记录）
- Docker Hub 已恢复可达（python:3.12-slim 拉取成功）；SRS C-3/R-04 待 v1.2 修订
- 原记录的 miniob-course / edgeguard-base 镜像已被清理，现基础镜像由 `docker/Dockerfile.base` 重建（~160 MB）
- pip 走 `https://mirrors.aliyun.com/pypi/simple/`（保持确定性）
- 弱网用容器内 `tc netem`，compose 中已预留 `cap_add: [NET_ADMIN]`
- 平台为 Windows + Docker Desktop（WSL2 后端）

## 协议与代码约定
- MQTT 主题（SRS §6.1）：事件主题为 **6 层** `edgeguard/bus/{bus}/dev/{dev}/event`——`dev` 是字面量！订阅过滤器必须写 `edgeguard/bus/+/dev/+/event`（少一层会导致"SUBACK 正常但永不投递"的静默故障，2026-11-21 踩坑已验证）
- paho-mqtt 2.x：回调统一走 `common/mqtt.py` 封装（CallbackAPIVersion.VERSION2）；**必须显式注册 on_message**，否则消息被静默丢弃
- 事件通道 QoS1 + 应用层去重（event_id 幂等），摘要/心跳 QoS0
- 事件载荷 ≤ 400 B，只含 8 维特征指纹，禁止携带原始时序样本（FR-04 可审计）
- 聚类窗 1 s；根因结论时延 ≤ 500 ms；告警收敛 85%~95%
- 断网补传保留原始检测时间戳（误差=0）；WAL 超限「保新弃旧」
- 固定随机种子（NFR-05）；配置外置（`EG_*` 环境变量）、类型标注、logging 禁 print

## Git
- 远程 `origin` = github.com/cheng200606/edge-nano-agent，主分支 `main`，单人课程仓库直接提交 main
