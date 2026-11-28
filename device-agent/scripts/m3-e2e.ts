/**
 * M3 端到端验收：真实 mosquitto + 网关 + 模拟器 + 命令闭环。
 *
 * 前置：broker 已启动（bun run mqtt:start 或 scripts/mqtt-broker.ps1 start）
 * 运行：bun scripts/m3-e2e.ts
 *
 * 验收点：
 *   1. 网关能连上真实 broker（/readyz mqtt.ready=true）
 *   2. 模拟器遥测被 MQTT ingress 落库
 *   3. 命令下发后台账 pending，收到回执后变 completed
 *   4. 全过程不依赖 REST，直接驱动 dispatcher
 */
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../apps/agent-gateway/src/gateway";

const PRODUCT = "demo-plug";
const DEVICE = "demo-dev-1";

const BROKER_PORT = 1884;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 端口是否已有人在监听。 */
function portOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host, timeout: 500 });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      sock.destroy();
      resolve(false);
    });
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

async function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs: number,
  stepMs = 200,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined) return v;
    await sleep(stepMs);
  }
  return undefined;
}

/**
 * 若 1884 没有 broker，就用项目脚本拉起一个，结束时再停掉。
 *
 * 为什么不直接 Bun.spawn(mosquitto)：
 *   - mosquitto 是长驻进程，Bun.spawn 的 stderr/stdout 管道在本进程存活期间
 *     不可关闭，任何"等它输出"的写法都会阻塞；
 *   - 项目脚本已经用 WMI 把 broker 脱离进程树，行为更可控。
 */
async function ensureBroker(): Promise<{ owned: boolean }> {
  if (await portOpen(BROKER_PORT)) {
    process.stdout.write(`broker: reuse existing on ${BROKER_PORT}\n`);
    return { owned: false };
  }
  const script = join(import.meta.dir, "mqtt-broker.ps1");
  process.stdout.write(`broker: starting via ${script}\n`);
  const proc = Bun.spawn(
    ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "start"],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
  const up = await waitFor(async () => ((await portOpen(BROKER_PORT)) ? true : undefined), 10_000);
  if (!up) {
    throw new Error(`broker failed to start on ${BROKER_PORT} via ${script}`);
  }
  process.stdout.write(`broker: ready on ${BROKER_PORT}\n`);
  return { owned: true };
}

const dir = mkdtempSync(join(tmpdir(), "da-m3-"));
const dbPath = join(dir, "e2e.sqlite");
let gw: Awaited<ReturnType<typeof startGateway>> | null = null;
let broker: Awaited<ReturnType<typeof ensureBroker>> | null = null;
let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}\n`);
  if (!ok) failures += 1;
}

try {
  process.stdout.write(`db: ${dbPath}\n`);
  broker = await ensureBroker();
  gw = await startGateway({ port: 3101, databasePath: dbPath, enableSimulator: true });

  // 1. MQTT 连上
  const connected = await waitFor(() => (gw?.mqtt.isReady() ? true : undefined), 10_000);
  check("网关连上真实 broker", connected === true, gw.config.mqtt.brokerUrl);

  const ready = gw.health.readiness();
  check("/readyz 报告 ready", ready.ready, JSON.stringify(ready.checks.mqtt));

  // 2. 遥测落库
  const ev = await waitFor(() => {
    const events = gw?.service.listDeviceEventsInProduct(PRODUCT, DEVICE, 50) ?? [];
    return events.find((e) => e.type === "telemetry");
  }, 10_000);
  check("模拟器遥测经 MQTT 落库", ev !== undefined, ev ? `eventId=${ev.id}` : "timeout");

  const device = gw.service.getDeviceInProduct(PRODUCT, DEVICE);
  check(
    "设备影子被更新为 online",
    device?.status === "online",
    JSON.stringify(device?.reportedState),
  );

  // 3. 命令闭环
  const sent = gw.dispatcher.send({
    productId: PRODUCT,
    deviceId: DEVICE,
    command: "set_mode",
    input: { mode: "eco" },
    timeoutMs: 10_000,
  });
  check("命令已发布", sent.published, `commandId=${sent.commandId}`);
  check("下发后台账为 pending", gw.service.getCommand(sent.commandId)?.status === "pending");

  const done = await waitFor(() => {
    const row = gw?.service.getCommand(sent.commandId);
    return row && row.status !== "pending" ? row : undefined;
  }, 10_000);
  check("收到回执后台账变为 completed", done?.status === "completed", `status=${done?.status}`);

  const events = gw.service.listDeviceEventsInProduct(PRODUCT, DEVICE, 100);
  check(
    "台账状态迁移有事件留痕",
    events.some((e) => e.type === "command_response"),
  );
  check(
    "上行事件、下行命令都有记录",
    events.some((e) => e.type === "command_sent"),
  );

  const stats = gw.mqtt.snapshot();
  check("MQTT 收发计数正常", stats.received > 0 && stats.published > 0, JSON.stringify(stats));
} catch (err) {
  process.stderr.write(`FATAL ${(err as Error).message}\n`);
  failures += 1;
} finally {
  if (gw) await gw.stop();
  if (broker?.owned) {
    const script = join(import.meta.dir, "mqtt-broker.ps1");
    try {
      const stop = Bun.spawn(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "stop"],
        { stdout: "ignore", stderr: "ignore" },
      );
      await stop.exited;
    } catch {
      // ignore
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

process.stdout.write(failures === 0 ? "\nM3 E2E OK\n" : `\nM3 E2E FAILED (${failures})\n`);
process.exit(failures === 0 ? 0 : 1);
