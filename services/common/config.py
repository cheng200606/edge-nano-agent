"""全局配置：全部环境变量驱动（SRS NFR-08 配置外置）。

主题表严格对齐 SRS §6.1；拓扑对齐 SRS §3.4
（Bus-A = dev-01~03，Bus-B = dev-04~05，均挂 Main-Bus）。
"""
import os

# ---- MQTT 连接 ----
MQTT_HOST = os.getenv("EG_MQTT_HOST", "broker")
MQTT_PORT = int(os.getenv("EG_MQTT_PORT", "1883"))

# ---- 节点身份（edge-* 容器由 compose 注入）----
DEVICE_ID = os.getenv("EG_DEVICE_ID", "dev-01")
BUS_ID = os.getenv("EG_BUS_ID", "Bus-A")

# ---- 故障注入计划（骨架演示用；I2 迭代替换为场景清单驱动，FR-01）----
FAULT_TYPE = os.getenv("EG_FAULT_TYPE", "current_surge")  # 电流冲击
FAULT_AT_S = float(os.getenv("EG_FAULT_AT_S", "0") or 0)  # <=0 表示不注入
FAULT_DUR_S = float(os.getenv("EG_FAULT_DUR_S", "6"))

# ---- 节点检测（骨架为阈值法；I2 迭代替换为 numpy 自编码器，FR-02）----
DETECT_THRESHOLD = float(os.getenv("EG_DETECT_THRESHOLD", "3.5"))
SUPPRESS_S = float(os.getenv("EG_SUPPRESS_S", "20"))  # 告警抑制窗，FR-03

# ---- 网关关联（SRS §3.4：1 s 滑窗，簇阈值 >=3）----
CLUSTER_WINDOW_S = float(os.getenv("EG_CLUSTER_WINDOW_S", "1.0"))
CLUSTER_MIN_DEVICES = int(os.getenv("EG_CLUSTER_MIN", "3"))

# ---- 设备拓扑（网关根因判定依据）----
DEVICE_BUS = {
    "dev-01": "Bus-A",
    "dev-02": "Bus-A",
    "dev-03": "Bus-A",
    "dev-04": "Bus-B",
    "dev-05": "Bus-B",
}

# ---- 主题表（SRS §6.1）----
TOPIC_EVENT_FMT = "edgeguard/bus/{bus}/dev/{dev}/event"      # 节点→网关 QoS1
TOPIC_SUMMARY_FMT = "edgeguard/bus/{bus}/dev/{dev}/summary"  # 节点→网关 QoS0
TOPIC_ROOTCAUSE = "edgeguard/rootcause"                      # 网关→云 QoS1
TOPIC_GW_SUMMARY = "edgeguard/gw/summary"                    # 网关→云 QoS0
TOPIC_CMD_FMT = "edgeguard/cmd/{target}"                     # 云→节点/网关 QoS1
TOPIC_STATUS_FMT = "edgeguard/status/{node}"                 # 节点→云 QoS0
# 网关订阅通配：主题为 6 层 edgeguard/bus/{bus}/dev/{dev}/event（dev 是字面量）
TOPIC_EVENT_SUB = "edgeguard/bus/+/dev/+/event"
TOPIC_STATUS_SUB = "edgeguard/status/+"                      # 云订阅通配
