/**
 * M4 的工具装配：只装一个 `list_devices`，但**是真的工具**——参数走 TypeBox schema，
 * 结果由 `DeviceService` 查库得到，执行结果再回灌给模型。
 *
 * 对应真实源码：apps/agent-gateway/src/agent/capabilities.ts（M5/LU-06 会扩到 20+ 个工具）
 *
 * 为什么 M4 只做一个工具：验收要证的是「工具回灌链路真实存在」，
 * 而不是工具数量。工具数量必须动态（AGENTS.md 红线：禁止写死 22/25），
 * 所以这里的 `createAgentTools()` 返回数组，由调用方数出来。
 *
 * 工具名与描述来自 `packages/shared` 的描述符注册表，保证
 * `/api/tool-catalog`（M7）、控制台开关、模型看到的工具名三处一致。
 */

import type { DeviceService } from "@device-agent/persistence/device-service";
import { getAgentToolDescriptor } from "@device-agent/shared/agent-tool-descriptor";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";

import type { Logger } from "../utils/logger";

/** 工具名常量：mock 模型、系统提示词、测试断言都引用这里，避免三处写死字符串。 */
export const LIST_DEVICES_TOOL = "list_devices";

/** 工具成功返回的结构化形状（同时作为 `structuredContent`/`details` 的类型）。 */
export interface ListDevicesDetails {
  productIds: string[];
  count: number;
  devices: Array<{
    deviceId: string;
    productId: string;
    name: string;
    status: string;
    lastSeenAt: number;
  }>;
}

const ListDevicesParameters = Type.Object(
  {
    productId: Type.Optional(
      Type.String({
        description: "Product id to scope the query. Omit to list devices of every product.",
      }),
    ),
  },
  { additionalProperties: false },
);

export interface AgentToolsDeps {
  service: DeviceService;
  logger: Logger;
}

/**
 * 组装本回合可用的工具。
 *
 * 返回的数组长度即"当前工具数量"——上下文提示词必须**基于它**生成，
 * 不能在提示词里写死数字（否则裁剪/扩展后必然对不上）。
 */
export function createAgentTools(deps: AgentToolsDeps): AgentTool[] {
  const descriptor = getAgentToolDescriptor(LIST_DEVICES_TOOL);

  const listDevices: AgentTool<typeof ListDevicesParameters, ListDevicesDetails> = {
    name: LIST_DEVICES_TOOL,
    label: descriptor?.title ?? "List devices",
    description:
      `${descriptor?.description ?? "List registered devices."} ` +
      'Returns JSON: {"productIds":string[],"count":number,"devices":[{"deviceId","productId","name","status","lastSeenAt"}]}.',
    parameters: ListDevicesParameters,
    execute: async (_toolCallId, params, signal) => {
      // 中止必须传到工具内部：否则用户点了停止，查询还在往下走（指南 5.5.3）
      if (signal?.aborted) throw new Error("Operation aborted");

      const productId = params.productId?.trim();
      const productIds: string[] = [];

      if (productId) {
        if (!deps.service.getProduct(productId)) {
          // throw 出去会被 agent loop 转成 isError 的工具结果，模型下一轮能自行纠正
          throw new Error(`product not found: ${productId}`);
        }
        productIds.push(productId);
      } else {
        for (const product of deps.service.listProducts()) productIds.push(product.id);
      }

      const devices: ListDevicesDetails["devices"] = [];
      for (const id of productIds) {
        for (const row of deps.service.listDevices(id)) {
          devices.push({
            deviceId: row.id,
            productId: row.productId,
            name: row.name,
            status: row.status,
            lastSeenAt: row.lastSeenAt,
          });
        }
      }

      const details: ListDevicesDetails = { productIds, count: devices.length, devices };
      deps.logger.debug("list_devices executed", {
        productIds,
        count: details.count,
      });

      return {
        // content 是给模型看的（唯一进入上下文的字段），details 只给 UI/日志
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  };

  return [listDevices];
}

/** 当前工具名列表（系统提示词与工具签名都用它，顺序稳定）。 */
export function toolNamesOf(tools: AgentTool[]): string[] {
  return tools.map((tool) => tool.name);
}
