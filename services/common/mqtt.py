"""paho-mqtt 2.x 封装：客户端构造、连接重试、JSON 发布。

paho 2.2.0 需显式指定 CallbackAPIVersion（否则弃用警告）；
broker 为 amqtt 0.12.2，走 MQTT 3.1.1。
"""
from __future__ import annotations

import json
import logging
import time

import paho.mqtt.client as mqtt

from common.config import MQTT_HOST, MQTT_PORT

log = logging.getLogger("edgeguard.mqtt")


def make_client(client_id: str) -> mqtt.Client:
    """创建 MQTT 3.1.1 客户端并设置指数退避重连。"""
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id=client_id,
        protocol=mqtt.MQTTv311,
    )
    client.reconnect_delay_set(min_delay=1, max_delay=30)
    return client


def connect_with_retry(client: mqtt.Client, timeout_s: float = 60.0) -> None:
    """首连阻塞重试，兜底 compose 启动竞序（broker 未就绪时各服务等待）。"""
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            client.connect(MQTT_HOST, MQTT_PORT, keepalive=30)
            return
        except OSError as exc:
            if time.monotonic() > deadline:
                raise
            log.warning("MQTT %s:%s 未就绪（%s），2s 后重试", MQTT_HOST, MQTT_PORT, exc)
            time.sleep(2.0)


def publish_json(client: mqtt.Client, topic: str, payload: dict, qos: int = 1) -> None:
    """序列化并发布；QoS1 的重传由 paho 会话层负责（FR-10 依赖）。"""
    info = client.publish(topic, json.dumps(payload, ensure_ascii=False), qos=qos)
    if info.rc != mqtt.MQTT_ERR_SUCCESS:
        log.error("发布失败 rc=%s topic=%s", info.rc, topic)
