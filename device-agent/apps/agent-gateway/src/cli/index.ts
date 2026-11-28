/**
 * CLI 入口分派：只处理 --version / --help / --print-config，其余交给网关。
 *
 * 对应真实源码：apps/agent-gateway/src/cli/index.ts
 * 注意：commander 的 --help/--version 默认会 process.exit，这里用 exitOverride 收敛，
 * 保证单元测试里调用不会把测试进程杀掉。
 */
import { Command, CommanderError } from "commander";

import pkg from "../../../../package.json";

export interface CliOutcome {
  /** true 表示 CLI 已处理完（--version / --help / --print-config），调用方应直接退出 */
  handled: boolean;
  printConfig?: boolean;
}

export async function handleCli(argv: string[] = process.argv): Promise<CliOutcome> {
  const program = new Command();
  program
    .name("device-agent")
    .description("Device Agent 网关：以设备为中心的 Agent 运行时")
    .version(pkg.version, "-v, --version", "打印版本号")
    .option("--print-config", "打印配置摘要后退出")
    .allowExcessArguments(true)
    .allowUnknownOption(true)
    .exitOverride();

  try {
    program.parse(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      if (
        err.code === "commander.helpDisplayed" ||
        err.code === "commander.version" ||
        err.code === "commander.help"
      ) {
        return { handled: true };
      }
      // 未知选项不阻断启动，交给网关忽略
      return { handled: false };
    }
    throw err;
  }

  if (program.opts().printConfig) {
    return { handled: true, printConfig: true };
  }
  return { handled: false };
}
