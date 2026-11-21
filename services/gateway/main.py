"""edge-gateway 骨架：事件接入 + 1s 滑窗聚类 + 简化根因判定。

骨架实现 SRS §3.4 五步法中的 ①事件接入 + ②时间窗聚类，
③拓扑加权 ④特征校验 ⑤根因 Top1 在 I4 迭代补全（CorrelationStrategy 接口届时引入）。
判定规则（骨架版）：
  - 同一 bus 在 1s 窗内 >= 3 台设备异常 → bus_fault（告警收敛：多条事件 → 1 条结论，G-8）
  - 孤立事件（窗龄超窗）→ single_device 透传
"""
import json
import logging
import queue
import time
from collections import defaultdict

from common import config
from common.events import Event, Conclusion
from common.mqtt import connect_with_retry, make_client, publish_json

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("edgeguard.gateway")

_events: queue.Queue[Event] = queue.Queue()
_client = None
_counter = 0


def _next_id() -> str:
    global _counter
    _counter += 1
    return f"rc-{_counter:06d}"


def _emit(conc: Conclusion) -> None:
    conc.conclusion_id = _next_id()
    publish_json(_client, config.TOPIC_ROOTCAUSE, conc.to_dict(), qos=1)
    log.info("根因结论 %s: %s bus=%s devices=%s conf=%.2f | %s",
             conc.conclusion_id, conc.root_cause, conc.bus_id,
             conc.affected_devices, conc.confidence, "; ".join(conc.evidence))


def on_message(_client, _userdata, msg) -> None:
    try:
        d = json.loads(msg.payload)
        _events.put(Event(
            device_id=d["device_id"],
            bus_id=d["bus_id"],
            score=d["score"],
            threshold=d["threshold"],
            fault_type=d["fault_type"],
            features=d["features"],
            event_id=d["event_id"],
            detected_at=d["detected_at"],
        ))
        log.info("收到事件 %s dev=%s bus=%s score=%.1f type=%s",
                 d["event_id"], d["device_id"], d["bus_id"], d["score"], d["fault_type"])
    except (KeyError, ValueError, json.JSONDecodeError) as exc:
        log.error("事件解析失败 topic=%s err=%s", msg.topic, exc)


def correlate_once(pending: list[Event]) -> list[Event]:
    """一轮 1s 滑窗关联，返回尚未结案的事件。"""
    now = time.time()
    concluded_ids: set[str] = set()

    in_window = [e for e in pending if now - e.detected_at <= config.CLUSTER_WINDOW_S]
    by_bus: dict[str, list[Event]] = defaultdict(list)
    for ev in in_window:
        by_bus[ev.bus_id].append(ev)

    # ② 时间窗聚类：同 bus 窗内 >= 簇阈值台设备 → 母线故障（规则可解释，R-07 对策）
    for bus, evs in by_bus.items():
        devices = sorted({e.device_id for e in evs})
        if len(devices) >= config.CLUSTER_MIN_DEVICES:
            scores = [e.score for e in evs]
            _emit(Conclusion(
                root_cause="bus_fault",
                bus_id=bus,
                affected_devices=devices,
                confidence=min(0.95, 0.6 + 0.1 * len(devices)),  # SRS 附录 C 置信度公式
                evidence=[f"{len(devices)} devices in {bus} within {config.CLUSTER_WINDOW_S}s",
                          f"score range [{min(scores):.1f}, {max(scores):.1f}]"],
                window=[min(e.detected_at for e in evs), max(e.detected_at for e in evs)],
            ))
            concluded_ids.update(e.event_id for e in evs)

    # 孤立事件：窗龄已超窗 → 单设备故障透传
    for ev in pending:
        if ev.event_id in concluded_ids:
            continue
        if now - ev.detected_at > config.CLUSTER_WINDOW_S:
            _emit(Conclusion(
                root_cause="single_device",
                bus_id=ev.bus_id,
                affected_devices=[ev.device_id],
                confidence=min(0.95, 0.5 + 0.05 * ev.score),
                evidence=[f"isolated event {ev.event_id} (type={ev.fault_type}, score={ev.score:.1f})"],
                window=[ev.detected_at, ev.detected_at],
            ))
            concluded_ids.add(ev.event_id)

    # 清理已结案与过期事件
    return [e for e in pending
            if e.event_id not in concluded_ids
            and now - e.detected_at <= config.CLUSTER_WINDOW_S + 5.0]


def main() -> None:
    global _client
    _client = make_client("edge-gateway")
    connect_with_retry(_client)

    def on_connect(_c, _u, _flags, reason_code, _props) -> None:
        log.info("broker 已连接 rc=%s，订阅 %s", reason_code, config.TOPIC_EVENT_SUB)
        _client.subscribe(config.TOPIC_EVENT_SUB, qos=1)

    _client.on_connect = on_connect
    _client.on_message = on_message
    _client.loop_start()

    pending: list[Event] = []
    log.info("网关启动：滑窗 %.1fs，簇阈值 >= %d 台设备",
             config.CLUSTER_WINDOW_S, config.CLUSTER_MIN_DEVICES)
    while True:
        time.sleep(0.5)
        while not _events.empty():
            pending.append(_events.get())
        pending = correlate_once(pending)


if __name__ == "__main__":
    main()
