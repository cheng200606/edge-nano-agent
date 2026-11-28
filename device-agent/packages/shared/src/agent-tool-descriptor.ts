/**
 * 工具描述符注册表：给前端与语音场景看的元数据。
 *
 * 对应真实源码：apps/agent-gateway/src/tools/tool-descriptor.ts
 *
 * 这张表被三处消费：`/api/tool-catalog`、控制台工具开关页、
 * 语音场景的 voiceToolNames 裁剪。**新增工具时必须同时登记**，
 * 否则前端看不到、也无法按产品禁用。
 */

export const TOOL_GROUPS = [
  "device",
  "workflow",
  "memory",
  "workspace",
  "a2a",
  "timer",
  "mqtt",
  "vision",
  "im",
  "skill",
] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

export type ToolApproval = "never" | "once" | "always";

export interface AgentToolDescriptor {
  name: string;
  /** 人类可读名，如"执行设备命令" */
  title: string;
  /** 与工具自身的 description 保持一致 */
  description: string;
  /** 写文件/执行命令类工具需要审批 */
  approval?: ToolApproval;
  group: ToolGroup;
}

const REGISTRY = new Map<string, AgentToolDescriptor>();

export function registerAgentToolDescriptor(descriptor: AgentToolDescriptor): void {
  REGISTRY.set(descriptor.name, descriptor);
}

export function registerAgentToolDescriptors(descriptors: AgentToolDescriptor[]): void {
  for (const d of descriptors) registerAgentToolDescriptor(d);
}

export function getAgentToolDescriptor(name: string): AgentToolDescriptor | undefined {
  return REGISTRY.get(name);
}

export function listAgentToolDescriptors(group?: ToolGroup): AgentToolDescriptor[] {
  const all = [...REGISTRY.values()];
  return group ? all.filter((d) => d.group === group) : all;
}

export function clearAgentToolDescriptors(): void {
  REGISTRY.clear();
}

/**
 * 内置工具的最小集合。M5 实现工具本体时以这里为准，
 * 保证名称与分组和控制台/语音裁剪一致。
 */
export const BUILTIN_TOOL_DESCRIPTORS: AgentToolDescriptor[] = [
  {
    name: "inspect_device",
    title: "查看设备状态",
    description: "读取设备当前属性、在线状态与最近事件，不产生副作用。",
    approval: "never",
    group: "device",
  },
  {
    name: "use_command",
    title: "执行设备命令",
    description: "向指定设备下发一条命令并等待响应，结果写入命令台账。",
    approval: "never",
    group: "device",
  },
  {
    name: "list_devices",
    title: "列出设备",
    description: "按产品列出设备清单及其在线状态。",
    approval: "never",
    group: "device",
  },
  {
    name: "save_workflow",
    title: "保存工作流",
    description: "创建或更新一条事件触发的自动化工作流。",
    approval: "once",
    group: "workflow",
  },
  {
    name: "run_workflow",
    title: "运行工作流",
    description: "立即执行一条已保存的工作流并返回运行记录。",
    approval: "once",
    group: "workflow",
  },
  {
    name: "set_timer",
    title: "设置定时任务",
    description: "创建 cron / interval / once 定时任务，到点后在独立会话执行。",
    approval: "never",
    group: "timer",
  },
  {
    name: "use_skill",
    title: "调用技能包",
    description: "加载 .agents/skills/<name>/SKILL.md 并把其中的指引注入当前轮次。",
    approval: "never",
    group: "skill",
  },
  {
    name: "publish_mqtt",
    title: "发布 MQTT 消息",
    description: "向指定主题发布一条消息，用于调试设备侧固件。",
    approval: "once",
    group: "mqtt",
  },
  {
    name: "remember",
    title: "写入记忆",
    description: "把一条事实写入当前作用域的长期记忆。",
    approval: "never",
    group: "memory",
  },
  {
    name: "write_workspace_file",
    title: "写工作区文件",
    description: "在 workspace 目录下创建或覆盖文件，需用户确认。",
    approval: "always",
    group: "workspace",
  },
];

// 模块加载即登记内置工具，保证 /api/tool-catalog 不依赖别处初始化
registerAgentToolDescriptors(BUILTIN_TOOL_DESCRIPTORS);
