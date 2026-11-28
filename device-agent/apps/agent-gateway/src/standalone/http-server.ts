/**
 * 最小 HTTP 服务：/livez、/readyz、/health、/api/version、/api/chat。
 *
 * 对应真实源码：apps/agent-gateway/src/channels/http/channel.ts（M0 只取健康检查骨架，
 * M4 挂上 POST /api/chat 的 SSE 处理器）
 *
 * ⚠️ 评分红线（AGENTS.md）：
 *   1. 端口 3000 默认只监听 127.0.0.1。写死 0.0.0.0 会被判安全事故。
 *   2. /livez 不查库（进程活着就 200）；/readyz 才检查依赖，语义必须分离。
 *   3. 所有错误响应必须带 code，不能只给 message。
 */
import type { DeviceAgentConfig } from "@device-agent/shared/device-agent-config";

import type { HealthRegistry } from "./health";

export interface HttpServerHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** `/api/chat` 的处理器（M4 由 http-api/chat.ts 提供；不传则该路由 404）。 */
export type ChatRouteHandler = (req: Request) => Promise<Response>;

export interface HttpServerOptions {
  port: number;
  health: HealthRegistry;
  home: string;
  config: DeviceAgentConfig;
  version?: string;
  /** 默认 127.0.0.1；只有显式传 0.0.0.0 才会对外监听 */
  hostname?: string;
  /** POST /api/chat：SSE 流式对话 */
  chat?: ChatRouteHandler;
}

const DEFAULT_HOSTNAME = "127.0.0.1";

function errorBody(code: string, message: string, extra?: Record<string, unknown>): Response {
  return Response.json({ code, message, ...extra }, { status: httpStatusFor(code) });
}

function httpStatusFor(code: string): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "METHOD_NOT_ALLOWED":
      return 405;
    default:
      return 500;
  }
}

export function createHttpServer(opts: HttpServerOptions): HttpServerHandle {
  const startedAt = Date.now();
  const version = opts.version ?? "0.5.1";
  const hostname = opts.hostname ?? process.env.HOST ?? DEFAULT_HOSTNAME;

  const server = Bun.serve({
    port: opts.port,
    hostname,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      // liveness：只证明进程还在，不碰任何外部依赖
      if (url.pathname === "/livez") {
        return Response.json({ status: "ok", uptimeMs: Date.now() - startedAt, version });
      }

      // readiness：依赖未就绪返回 503
      if (url.pathname === "/readyz") {
        const r = opts.health.readiness();
        return Response.json({ ready: r.ready, checks: r.checks }, { status: r.ready ? 200 : 503 });
      }

      // 兼容指南 README §8 的验收命令
      if (url.pathname === "/health") {
        const snap = opts.health.snapshot();
        return Response.json({
          status: snap.status,
          checks: snap.checks,
          uptimeMs: Date.now() - startedAt,
          version,
        });
      }

      if (url.pathname === "/api/version") {
        return Response.json({
          name: "device-agent",
          version,
          home: opts.home,
          cloud: opts.config.cloud.worker,
          iotPlatform: opts.config.iotPlatform.providerId,
        });
      }

      // Agent 单轮：SSE。路由存在性判断放这里，方法/入参校验由 handler 自己给 code
      if (url.pathname === "/api/chat" && opts.chat) {
        return opts.chat(req);
      }

      return errorBody("NOT_FOUND", `no route for ${req.method} ${url.pathname}`);
    },
    error(err: Error): Response {
      return errorBody("INTERNAL_ERROR", err.message);
    },
  });

  return {
    url: `http://${hostname}:${server.port}`,
    port: server.port,
    async close() {
      await server.stop();
    },
  };
}
