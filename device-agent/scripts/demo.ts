/**
 * 一条命令拉起完整演示环境。
 *
 *   bun run demo
 *
 * 做四件事：
 *   1. 若 1884 没 broker，用 scripts/mqtt-broker.ps1 拉起（真实 mosquitto）
 *   2. 启动网关（含 SQLite 迁移、MQTT 链路、本地设备模拟器）
 *   3. 打印可直接复制的 curl 命令
 *   4. Ctrl+C 时按顺序优雅关闭（模拟器 → MQTT → HTTP → DB → broker）
 */
import { connect } from "node:net";
import { join } from "node:path";

import { startGateway } from "../apps/agent-gateway/src/gateway";

const PORT = Number(process.env.PORT ?? 3000);
const BROKER_PORT = Number(process.env.BROKER_PORT ?? 1884);
const PRODUCT = process.env.DEVICE_SIM_PRODUCT ?? "demo-plug";
const DEVICE = process.env.DEVICE_SIM_ID ?? "demo-dev-1";

function portOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host, timeout: 500 });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.once("timeout", () => done(false));
  });
}

async function ensureBroker(): Promise<boolean> {
  if (await portOpen(BROKER_PORT)) return false;
  const script = join(import.meta.dir, "mqtt-broker.ps1");
  const proc = Bun.spawn(
    ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "start"],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
  for (let i = 0; i < 50; i += 1) {
    if (await portOpen(BROKER_PORT)) return true;
    await Bun.sleep(200);
  }
  throw new Error(`broker failed to start on ${BROKER_PORT}`);
}

async function stopBroker(): Promise<void> {
  const script = join(import.meta.dir, "mqtt-broker.ps1");
  const proc = Bun.spawn(
    ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "stop"],
    { stdout: "ignore", stderr: "ignore" },
  );
  await proc.exited;
}

function banner(ownedBroker: boolean): void {
  const base = `http://127.0.0.1:${PORT}`;
  const lines = [
    "",
    "════════════════════════════════════════════════════════════",
    "  Device Agent 演示环境已就绪",
    "════════════════════════════════════════════════════════════",
    `  网关        ${base}   (仅监听 127.0.0.1)`,
    `  MQTT broker mqtt://127.0.0.1:${BROKER_PORT}${ownedBroker ? "  (本次启动)" : "  (复用已有)"}`,
    `  模拟设备    ${PRODUCT} / ${DEVICE}`,
    "",
    "  ── 健康检查 ──",
    `  curl -s ${base}/readyz`,
    "",
    "  ── 版本与配置摘要 ──",
    `  curl -s ${base}/api/version`,
    "",
    "  ── Agent 单轮对话（SSE 流式）──",
    `  curl -N -X POST ${base}/api/chat \\`,
    "    -H 'content-type: application/json' \\",
    '    -d \'{"sessionId":"s1","message":"列出当前产品的设备"}\'',
    "",
    "  ── 设备闭环：看最近事件 ──",
    `  curl -s "${base}/api/products/${PRODUCT}/devices/${DEVICE}/events?limit=5"`,
    "",
    "  Ctrl+C 结束演示（会按序关闭模拟器 → MQTT → HTTP → DB）",
    "════════════════════════════════════════════════════════════",
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  const ownedBroker = await ensureBroker();
  process.stdout.write(`[demo] broker ${ownedBroker ? "started" : "reused"} on ${BROKER_PORT}\n`);

  const gw = await startGateway({ port: PORT, enableSimulator: true });
  banner(ownedBroker);

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    process.stdout.write(`\n[demo] ${signal}, shutting down...\n`);
    try {
      await gw.stop();
      if (ownedBroker) await stopBroker();
    } finally {
      process.stdout.write("[demo] bye\n");
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // 常驻，直到收到信号
  await new Promise<void>(() => {});
}

main().catch((err: unknown) => {
  process.stderr.write(`[demo] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
