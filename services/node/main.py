"""edge-node 骨架：信号模拟 + 阈值检测 + 事件上报。

骨架范围（本文件）：
  - 100 Hz 三通道信号模拟（温度/振动/电流），支持 current_surge / overheat 注入
  - 已知基线的 z-score 阈值检测（I2 迭代替换为 numpy 自编码器，FR-02）
  - 告警抑制（FR-03 骨架版：时间窗抑制）
  - 8 维指纹事件发布（FR-04 / §6.2）
迭代占位：模型 checksum（FR-11）、WAL 本地缓存（FR-09）、QoS1 去重（FR-05）
"""
import logging
import random
import time
from collections import deque

from common import config
from common.events import Event
from common.mqtt import connect_with_retry, make_client, publish_json

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger(f"edgeguard.node.{config.DEVICE_ID}")

SAMPLE_HZ = 100          # SRS §7：100 Hz（容器内，不占上行）
CHECK_EVERY = 10         # 每 10 帧检测一次（10 Hz 检查频率）
WINDOW = 100             # 特征窗样本数（1 s）

# 正常基线（物理启发式仿真；I2 迭代改为训练/校准数据驱动）
BASE = {"temp": 45.0, "vib": 2.5, "curr": 10.0}
NOISE = {"temp": 0.3, "vib": 0.1, "curr": 0.2}
FAULT_SIGMA = {"current_surge": ("curr", 2.2), "overheat": ("temp", 1.6)}  # 通道 × 倍率


def sample(rng: random.Random, t_s: float) -> dict[str, float]:
    """生成一帧三通道采样，注入计划内故障。"""
    frame = {k: BASE[k] + rng.gauss(0.0, NOISE[k]) for k in BASE}
    if config.FAULT_AT_S > 0 and config.FAULT_AT_S <= t_s < config.FAULT_AT_S + config.FAULT_DUR_S:
        channel, factor = FAULT_SIGMA.get(config.FAULT_TYPE, ("curr", 2.2))
        frame[channel] = BASE[channel] * factor
    return frame


def features_of(frame: dict[str, float], z: float) -> list[float]:
    """组装 8 维指纹（骨架期由阈值法直接给出；I2 迭代改为 AE 重构误差特征）。"""
    return [
        frame["temp"] - BASE["temp"],
        frame["vib"] - BASE["vib"],
        frame["curr"] - BASE["curr"],
        0.0,                          # vib_kurt_z 占位
        abs(frame["curr"] - BASE["curr"]) / NOISE["curr"],
        z,
        1.0 if frame["curr"] > BASE["curr"] else -1.0,
        max(0.0, 1.0 - abs(z) / 50.0),
    ]


def main() -> None:
    rng = random.Random(1000 + int(config.DEVICE_ID.split("-")[1]))  # 固定种子，NFR-05
    client = make_client(f"node-{config.DEVICE_ID}")
    connect_with_retry(client)

    def on_connect(_c, _u, _flags, reason_code, _props) -> None:
        log.info("broker 已连接 rc=%s，设备 %s（%s）", reason_code, config.DEVICE_ID, config.BUS_ID)
        publish_json(
            client,
            config.TOPIC_STATUS_FMT.format(node=config.DEVICE_ID),
            {"device_id": config.DEVICE_ID, "bus_id": config.BUS_ID, "state": "online"},
            qos=0,
        )

    client.on_connect = on_connect
    client.loop_start()

    buffers: dict[str, deque[float]] = {k: deque(maxlen=WINDOW) for k in BASE}
    last_fire = -1e9
    t0 = time.time()
    frame_no = 0
    log.info("采样启动 %d Hz；故障计划 type=%s at=%.1fs dur=%.1fs",
             SAMPLE_HZ, config.FAULT_TYPE, config.FAULT_AT_S, config.FAULT_DUR_S)

    while True:
        t_s = time.time() - t0
        frame = sample(rng, t_s)
        for key, value in frame.items():
            buffers[key].append(value)
        frame_no += 1

        if frame_no % CHECK_EVERY:
            time.sleep(1.0 / SAMPLE_HZ)
            continue

        # z-score：已知基线阈值法（对持续偏移不会自适应，骨架够用）
        z = abs((frame["curr"] - BASE["curr"]) / NOISE["curr"])
        if z >= config.DETECT_THRESHOLD and (t_s - last_fire) > config.SUPPRESS_S:
            last_fire = t_s
            event = Event(
                device_id=config.DEVICE_ID,
                bus_id=config.BUS_ID,
                score=z,
                threshold=config.DETECT_THRESHOLD,
                fault_type=config.FAULT_TYPE if config.FAULT_AT_S > 0 else "unknown",
                features=features_of(frame, z),
            )
            publish_json(client, event.topic(), event.to_dict(), qos=1)
            log.info("事件发布 %s score=%.1f（%.1fs）", event.event_id, z, t_s)

        time.sleep(1.0 / SAMPLE_HZ)


if __name__ == "__main__":
    main()
