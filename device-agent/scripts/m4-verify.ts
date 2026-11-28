/**
 * M4 验收：自己起网关 + 打一次真实 SSE，确认帧序列不是伪造的。
 *
 *   bun run verify:m4
 *
 * 不依赖 MQTT（disableMqtt），也不依赖外部 broker，因此可在任何机器上跑。
 * 断言：至少一个 tool_start、至少一个 delta、最后一帧必须是 done、
 *       会话文件已落盘且首行是 header。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../apps/agent-gateway/src/gateway";

const PORT = 3102;
const SESSION = `verify-${Date.now().toString(36)}`;

function parseFrame(chunk: string): { kind: string; data: string } | null {
  let kind = "";
  let data = "";
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event: ")) kind = line.slice(7).trim();
    else if (line.startsWith("data: ")) data = line.slice(6);
  }
  return kind ? { kind, data } : null;
}

const dir = mkdtempSync(join(tmpdir(), "da-m4-"));
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}\n`);
  if (!ok) failures += 1;
}

let gw: Awaited<ReturnType<typeof startGateway>> | null = null;
try {
  gw = await startGateway({
    port: PORT,
    databasePath: join(dir, "m4.sqlite"),
    disableMqtt: true,
  });

  const res = await fetch(`http://127.0.0.1:${PORT}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: SESSION, message: "列出当前产品的设备" }),
  });

  check("HTTP 200", res.status === 200, `status=${res.status}`);
  check(
    "content-type 是 text/event-stream",
    (res.headers.get("content-type") ?? "").includes("text/event-stream"),
  );

  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  const kinds: string[] = [];
  let buffer = "";
  let lastData = "";

  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf("\n\n");
    while (idx >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const frame = parseFrame(chunk);
      if (frame) {
        kinds.push(frame.kind);
        lastData = frame.data;
        process.stdout.write(
          `  frame#${kinds.length - 1}  ${frame.kind}  ${frame.data.slice(0, 90)}\n`,
        );
      }
      idx = buffer.indexOf("\n\n");
    }
  }

  check("有 tool_start 帧（证明工具链路真实存在）", kinds.includes("tool_start"));
  check("有 tool_result 帧", kinds.includes("tool_result"));
  check("有 delta 帧（流式输出）", kinds.filter((k) => k === "delta").length > 0);
  check("最后一帧是 done", kinds.at(-1) === "done", `last=${kinds.at(-1)}`);
  check("done 带完整文本", lastData.includes("text"));

  const sessionFile = join(gw.home, "pi-sessions", `${SESSION}.jsonl`);
  check("会话文件已落盘", existsSync(sessionFile), sessionFile);
  if (existsSync(sessionFile)) {
    const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
    check("首行是 session header", lines[0].includes('"type":"session"'));
    check("会话含 user + assistant", lines.length >= 3, `lines=${lines.length}`);
  }

  // 错误分支
  const bad = await fetch(`http://127.0.0.1:${PORT}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "../etc/passwd", message: "x" }),
  });
  check("非法 sessionId 返回 400", bad.status === 400, `status=${bad.status}`);
  const badBody = (await bad.json()) as { code?: string };
  check(
    "错误体带英文 code",
    typeof badBody.code === "string" && /^[A-Z_]+$/.test(badBody.code),
    badBody.code ?? "",
  );

  const getRes = await fetch(`http://127.0.0.1:${PORT}/api/chat`);
  check("GET /api/chat 返回 405", getRes.status === 405, `status=${getRes.status}`);

  const livez = await fetch(`http://127.0.0.1:${PORT}/livez`);
  check("/livez 未被破坏", livez.status === 200);
} catch (err) {
  process.stderr.write(`FATAL ${(err as Error).message}\n`);
  failures += 1;
} finally {
  if (gw) await gw.stop();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

process.stdout.write(failures === 0 ? "\nM4 VERIFY OK\n" : `\nM4 VERIFY FAILED (${failures})\n`);
process.exit(failures === 0 ? 0 : 1);
