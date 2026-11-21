"""事件与根因结论报文结构（SRS §6.2 / §6.3，字段名与协议一一对应）。"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

# 8 维特征指纹（FR-04：维度固定为 8，字段含义见 SRS §6.2）
FEATURE_NAMES = [
    "d_temp", "d_vib", "d_curr", "vib_kurt_z",
    "curr_std_z", "score", "trend_sign", "health",
]


@dataclass
class Event:
    """节点判定的一次异常（低维指纹，不含原始时序，FR-04）。"""

    device_id: str
    bus_id: str
    score: float
    threshold: float
    fault_type: str
    features: list[float]
    event_id: str = ""
    detected_at: float = field(default_factory=time.time)
    model_version: str = "rule-threshold-v0"  # I2 迭代切换为 ae-21-24-8-v*

    def __post_init__(self) -> None:
        if not self.event_id:
            self.event_id = f"{self.device_id}-{int(self.detected_at * 1000) % 10_000_000_000:010d}"
        if len(self.features) != len(FEATURE_NAMES):
            raise ValueError(f"特征必须为 {len(FEATURE_NAMES)} 维（FR-04），收到 {len(self.features)} 维")

    def to_dict(self) -> dict:
        return {
            "event_id": self.event_id,
            "device_id": self.device_id,
            "bus_id": self.bus_id,
            "detected_at": self.detected_at,
            "score": round(self.score, 3),
            "threshold": self.threshold,
            "fault_type": self.fault_type,
            "features": [round(v, 3) for v in self.features],
            "feature_names": FEATURE_NAMES,
            "model_version": self.model_version,
        }

    def topic(self) -> str:
        return f"edgeguard/bus/{self.bus_id}/dev/{self.device_id}/event"


@dataclass
class Conclusion:
    """网关根因结论（SRS §6.3）。"""

    root_cause: str  # single_device / bus_fault / regional_disturbance
    bus_id: str | None
    affected_devices: list[str]
    confidence: float
    evidence: list[str]
    conclusion_id: str = ""
    window: list[float] = field(default_factory=lambda: [0.0, 0.0])
    partial: bool = False  # FR-09：段 1 断网期间网关结论必须带 partial=true
    t_conclusion: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "conclusion_id": self.conclusion_id,
            "root_cause": self.root_cause,
            "bus_id": self.bus_id,
            "affected_devices": self.affected_devices,
            "confidence": round(self.confidence, 2),
            "window": [round(v, 3) for v in self.window],
            "partial": self.partial,
            "t_conclusion": self.t_conclusion,
            "evidence": self.evidence,
        }
