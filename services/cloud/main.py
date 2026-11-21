"""edge-cloud 骨架：订阅根因结论 + JSONL 归档。

看板 / CSV 导出（FR-08）/ 模型阈值下发（FR-11）在 I6 迭代实现。
"""
import json
import logging
import os
import time

from common import config
from common.mqtt import connect_with_retry, make_client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("edgeguard.cloud")

DATA_DIR = os.getenv("EG_DATA_DIR", "/data")


def _archive(payload: dict) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(os.path.join(DATA_DIR, "conclusions.jsonl"), "a", encoding="utf-8") as fh:
        fh.write(json.dumps(payload, ensure_ascii=False) + "\n")


def on_message(_client, _userdata, msg) -> None:
    try:
        payload = json.loads(msg.payload)
    except json.JSONDecodeError as exc:
        log.error("报文解析失败 topic=%s err=%s", msg.topic, exc)
        return

    if msg.topic == config.TOPIC_ROOTCAUSE:
        _archive(payload)
        log.info("【云端可见】%s bus=%s devices=%s conf=%.2f partial=%s",
                 payload.get("root_cause"), payload.get("bus_id"),
                 payload.get("affected_devices"), payload.get("confidence", 0),
                 payload.get("partial"))
    else:  # edgeguard/status/+
        log.info("【节点状态】%s", payload)


def main() -> None:
    client = make_client("edge-cloud")
    connect_with_retry(client)

    def on_connect(_c, _u, _flags, reason_code, _props) -> None:
        log.info("broker 已连接 rc=%s，订阅结论与状态主题", reason_code)
        client.subscribe(config.TOPIC_ROOTCAUSE, qos=1)
        client.subscribe(config.TOPIC_STATUS_SUB, qos=0)

    client.on_connect = on_connect
    client.on_message = on_message
    client.loop_start()
    log.info("云端启动：结论归档至 %s/conclusions.jsonl", DATA_DIR)

    while True:
        time.sleep(5)


if __name__ == "__main__":
    main()
