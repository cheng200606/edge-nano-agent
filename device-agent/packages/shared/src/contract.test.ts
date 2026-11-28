import { describe, expect, test } from "bun:test";

import {
  BUILTIN_TOOL_DESCRIPTORS,
  getAgentToolDescriptor,
  listAgentToolDescriptors,
} from "./agent-tool-descriptor";
import {
  CONFIG_DOMAINS,
  DeviceAgentConfigSchema,
  loadDefaultDeviceAgentConfig,
} from "./device-agent-config-schema";
import { normalizeSessionId, SESSION_ID_MAX_LENGTH, validateSessionId } from "./session-contract";

describe("配置契约", () => {
  test("10 个配置域齐全", () => {
    expect(CONFIG_DOMAINS).toHaveLength(10);
    expect(CONFIG_DOMAINS).toContain("mqtt");
    expect(CONFIG_DOMAINS).toContain("models");
    expect(CONFIG_DOMAINS).toContain("permissions");
  });

  test("空配置也能解析出带默认值的完整对象", () => {
    const cfg = loadDefaultDeviceAgentConfig();
    expect(cfg.version).toBe(1);
    expect(cfg.cloud.worker).toBe("standalone");
    expect(cfg.mqtt.brokerUrl).toBe("mqtt://127.0.0.1:1884");
    expect(cfg.models.agent.provider).toBe("mock");
    expect(cfg.models.vision.provider).toBe("mock");
    expect(cfg.logging.level).toBe("info");
    expect(cfg.permissions.tools).toEqual([]);
  });

  test("未知配置域被拒绝（防止 mqqt 这类拼写错误被静默忽略）", () => {
    const r = DeviceAgentConfigSchema.safeParse({ mqqt: { brokerUrl: "x" } });
    expect(r.success).toBe(false);
  });

  test("已知域的部分覆盖生效，其余取默认值", () => {
    const r = DeviceAgentConfigSchema.safeParse({ logging: { level: "debug" } });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.logging.level).toBe("debug");
    expect(r.data.logging.console).toBe(true);
    expect(r.data.mqtt.keepAliveSeconds).toBe(60);
  });

  test("越界的 keepAliveSeconds 被拒绝", () => {
    const r = DeviceAgentConfigSchema.safeParse({ mqtt: { keepAliveSeconds: 99999 } });
    expect(r.success).toBe(false);
  });
});

describe("会话 ID 校验", () => {
  test("正常 ID 通过", () => {
    expect(validateSessionId("s-1").ok).toBe(true);
    expect(validateSessionId("prod:dev-01.abc_1").ok).toBe(true);
  });

  test("控制字符被拒绝", () => {
    const r = validateSessionId(`abc${String.fromCharCode(0)}def`);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("SESSION_ID_CONTROL_CHARS");
  });

  test("含路径分隔符与空格的 ID 被拒绝", () => {
    expect(validateSessionId("a/b").ok).toBe(false);
    expect(validateSessionId("a b").ok).toBe(false);
    expect(validateSessionId("..").ok).toBe(false);
  });

  test("超长 ID 被拒绝", () => {
    expect(validateSessionId("a".repeat(SESSION_ID_MAX_LENGTH + 1)).ok).toBe(false);
  });

  test("非法输入兜底成合法 ID", () => {
    const id = normalizeSessionId("a/b");
    expect(validateSessionId(id).ok).toBe(true);
    expect(id.startsWith("session-")).toBe(true);
  });
});

describe("工具描述符", () => {
  test("内置工具都已登记", () => {
    expect(listAgentToolDescriptors().length).toBe(BUILTIN_TOOL_DESCRIPTORS.length);
  });

  test("按名字查得到，分组正确", () => {
    expect(getAgentToolDescriptor("use_command")?.group).toBe("device");
    expect(getAgentToolDescriptor("save_workflow")?.group).toBe("workflow");
    expect(getAgentToolDescriptor("set_timer")?.group).toBe("timer");
    expect(getAgentToolDescriptor("nope")).toBeUndefined();
  });

  test("按分组过滤", () => {
    const deviceTools = listAgentToolDescriptors("device").map((d) => d.name);
    expect(deviceTools).toContain("use_command");
    expect(deviceTools).toContain("inspect_device");
    expect(deviceTools).not.toContain("save_workflow");
  });

  test("写文件类工具要求审批", () => {
    expect(getAgentToolDescriptor("write_workspace_file")?.approval).toBe("always");
    expect(getAgentToolDescriptor("inspect_device")?.approval).toBe("never");
  });
});
