/** `reality-check run <scenario.json> [--seed N] [--fault <name>]`.
 *
 * Executes the scenario through the core kernel, writes the rerun sidecar
 * (cli.json) and HTML/JSON reports into the run dir, then prints the
 * conclusion line and per-rule verdicts. Exit code = VERDICT_EXIT[verdict];
 * config problems exit 64, kernel/internal faults exit 70.
 */
import path from "node:path";
import { VERDICT_EXIT, type TimelineEvent } from "@rc/protocol";
import { streamEventLine, verdictLines } from "../format.js";
import {
  configError,
  flagInt,
  flagString,
  loadConfig,
  parseArgs,
  type CommandResult,
  toCommandResult,
} from "../config.js";
import { runOnce } from "../runner.js";

/** Wrapper: maps any thrown config/internal error onto the exit-code
 * contract (64/70) so the command always resolves to a CommandResult. */
export async function runCommand(args: string[]): Promise<CommandResult> {
  try {
    return await runCommandImpl(args);
  } catch (e) {
    return toCommandResult(e);
  }
}

async function runCommandImpl(args: string[]): Promise<CommandResult> {
  const parsed = parseArgs(args);
  const scenarioPath = parsed.positionals[0];
  if (scenarioPath === undefined || parsed.positionals.length !== 1) {
    throw configError("usage: reality-check run <scenario.json> [--seed N] [--fault <name>]");
  }
  const config = loadConfig(flagString(parsed, "config"));
  const seed = flagInt(parsed, "seed");
  const fault = flagString(parsed, "fault");
  // Human-facing live stream (方案 §12 运行时可观测性): with --verbose each step
  // is printed as it happens, so "哪一步卡住" is visible while waiting.
  const verbose = parsed.flags.get("verbose") === true || parsed.flags.get("verbose") === "true";

  const { result, warnings } = await runOnce({
    config,
    scenarioPath: path.resolve(scenarioPath),
    ...(seed !== undefined ? { seed } : {}),
    ...(fault !== undefined ? { fault } : {}),
    ...(verbose
      ? {
          onEvent: (event: TimelineEvent) => {
            const line = streamEventLine(event);
            if (line !== null) process.stdout.write(`${line}\n`);
          },
        }
      : {}),
  });

  return {
    code: VERDICT_EXIT[result.verdict],
    stdout: verdictLines(result, {
      verbose,
      runDir: path.join(config.runsDir, result.runId),
    }).join("\n"),
    stderr: warnings.map((w) => `warning: ${w}`).join("\n"),
  };
}
