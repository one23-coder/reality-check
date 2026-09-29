#!/usr/bin/env node
/** CLI dispatcher (方案 §3.1 四命令 + 复跑/规划). Exit code is the contract:
 * 0/1/2/3 verdicts, 64 config, 70 internal — see EXIT_DESCRIPTION.
 *
 * Commands are pure async functions returning {code, stdout, stderr}; this
 * module maps the result onto process streams and process.exit. Tests import
 * the command functions directly instead of spawning a process.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EXIT_DESCRIPTION } from "@rc/protocol";
import { toCommandResult, type CommandResult } from "./config.js";
import { checkCommand } from "./commands/check.js";
import { runCommand } from "./commands/run.js";
import { rerunCommand } from "./commands/rerun.js";
import { exportCommand } from "./commands/export.js";
import { planCommand } from "./commands/plan.js";

export const USAGE = `reality-check — 真实执行 + 证据检查的回归工具 (v0.1)

用法:
  reality-check check <scenario.json>        结构校验 + 适配器能力检查（不启动应用）
  reality-check run <scenario.json> [--seed N] [--fault <name>]
                                             执行场景，产出报告与证据
  reality-check rerun --run-id <id>          同场景同种子复跑，比较前后结论
  reality-check export [--format json]       导出历史运行清单与复跑命令
  reality-check plan "<自然语言描述>"         由受限规划器选择已保存场景
  reality-check help                         本帮助

所有命令支持 --config <path>（默认读取当前目录 .reality-check.json）。

退出码契约:
${Object.entries(EXIT_DESCRIPTION)
  .map(([code, desc]) => `  ${code.padStart(2)}  ${desc}`)
  .join("\n")}`;

type Command = (args: string[]) => Promise<CommandResult>;

export const COMMANDS: Record<string, Command> = {
  check: checkCommand,
  run: runCommand,
  rerun: rerunCommand,
  export: exportCommand,
  plan: planCommand,
};

/** Returns the process exit code. `help`/`--help`/`-h` print usage to stdout
 * with code 0; unknown or missing commands print usage to stderr with 64. */
export async function main(argv: string[]): Promise<number> {
  const name = argv[2] ?? "";
  if (name === "help" || name === "--help" || name === "-h") {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  const command = COMMANDS[name];
  if (command === undefined) {
    process.stderr.write(USAGE + "\n");
    return 64;
  }
  let result: CommandResult;
  try {
    result = await command(argv.slice(3));
  } catch (e) {
    result = toCommandResult(e);
  }
  if (result.stdout !== "") process.stdout.write(result.stdout + "\n");
  if (result.stderr !== "") process.stderr.write(result.stderr + "\n");
  return result.code;
}

const invoked = process.argv[1] !== undefined ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) {
  main(process.argv).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`internal error: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(70);
    },
  );
}
