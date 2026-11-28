/**
 * 运行时路径：解决"源码运行 / 打包后运行"两种形态下资源在哪。
 *
 * 对应真实源码：packages/shared/src/runtime-paths.ts
 * Bun --compile 之后 import.meta.dirname 指向 /$bunfs/root，
 * 因此不能直接用它找配置与资源，必须先判断是否处于编译产物中。
 *
 * 仓库根判定：优先找含 bun.lock / bun.lockb 的目录（monorepo 根），
 * 否则退回第一个含 package.json 的目录。否则子包里的 package.json
 * 会让 .device_agent 被建到 apps/agent-gateway/ 下面。
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const PACKED_DIR_MARKERS = ["$bunfs", "~BUN", "bunfs"];
const ROOT_MARKERS = ["bun.lock", "bun.lockb", "bunfig.toml", "pnpm-workspace.yaml"];

/** 当前是否运行在 Bun 的单文件编译产物里。 */
export function isPackedRuntime(dir: string = import.meta.dirname): boolean {
  return PACKED_DIR_MARKERS.some((m) => dir.includes(m));
}

/**
 * 解析"运行时基准目录"（仓库根）。
 * - 编译产物：退回可执行文件所在目录
 * - 源码运行：向上找 workspace 根标记，找不到再用最近的 package.json
 */
export function resolveRuntimeBaseDir(sourceDir: string = import.meta.dirname): string {
  if (isPackedRuntime(sourceDir)) {
    return dirname(process.execPath);
  }
  const start = resolve(sourceDir);
  let fallback = "";
  let cur = start;
  for (let i = 0; i < 10; i += 1) {
    if (!fallback && existsSync(join(cur, "package.json"))) fallback = cur;
    if (ROOT_MARKERS.some((m) => existsSync(join(cur, m)))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return fallback || start;
}

export function resolveConfigDir(baseDir: string): string {
  return join(baseDir, "config");
}

export function resolveSkillsDir(baseDir: string): string {
  return join(baseDir, ".agents", "skills");
}
