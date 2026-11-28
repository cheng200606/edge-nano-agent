/**
 * 打包：把网关编译成单文件可执行程序。
 *
 *   bun run build   →  dist/device-agent.exe (Windows) / dist/device-agent (POSIX)
 *
 * 对应真实源码：scripts/build-agent-gateway.ts
 *
 * 两个容易漏的点：
 *   1. 编译产物里 `import.meta.dirname` 指向 `$bunfs/root`，运行时找不到 drizzle 迁移，
 *      所以必须把 `drizzle/` 一起拷到 dist/ 旁边（schema-lifecycle 会按 exe 目录找）。
 *   2. `bun build --compile` 会内联 JS，但**不会**内联非 JS 资源（迁移 SQL、config 模板）。
 */
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const entry = join(root, "apps", "agent-gateway", "src", "main.ts");
const distDir = join(root, "dist");
const outfile = join(distDir, process.platform === "win32" ? "device-agent.exe" : "device-agent");

if (!existsSync(entry)) {
  process.stderr.write(`entry not found: ${entry}\n`);
  process.exit(1);
}

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

process.stdout.write(`[build] compiling ${entry}\n`);
const result = Bun.spawnSync(
  ["bun", "build", "--compile", "--minify", "--outfile", outfile, entry],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);

if (result.exitCode !== 0) {
  process.stderr.write(`[build] bun build failed with exit ${result.exitCode}\n`);
  process.exit(result.exitCode ?? 1);
}

// 迁移目录随产物一起分发，否则编译后启动会在 ensureSchema 处找不到迁移
const drizzleSrc = join(root, "drizzle");
const drizzleDst = join(distDir, "drizzle");
if (existsSync(drizzleSrc)) {
  cpSync(drizzleSrc, drizzleDst, { recursive: true });
  process.stdout.write("[build] copied drizzle/ next to the binary\n");
}

const size = existsSync(outfile) ? statSync(outfile).size : 0;
process.stdout.write(`[build] done: ${outfile} (${(size / 1024 / 1024).toFixed(1)} MB)\n`);
