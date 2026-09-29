/** `reality-check run <scenario.json> [--seed N] [--fault <name>]`.
 *
 * Executes the scenario through the core kernel, writes the rerun sidecar
 * (cli.json) and HTML/JSON reports into the run dir, then prints the
 * conclusion line and per-rule verdicts. Exit code = VERDICT_EXIT[verdict];
 * config problems exit 64, kernel/internal faults exit 70.
 */
import path from "node:path";
import { VERDICT_EXIT } from "@rc/protocol";
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

  const { result } = await runOnce({
    config,
    scenarioPath: path.resolve(scenarioPath),
    ...(seed !== undefined ? { seed } : {}),
    ...(fault !== undefined ? { fault } : {}),
  });

  const exit = VERDICT_EXIT[result.verdict];
  const lines = [`run ${result.runId}: ${result.verdict} (exit ${exit})`];
  for (const ev of result.ruleEvaluations) {
    lines.push(`${ev.verdict} ${ev.ruleId}`);
  }
  return { code: exit, stdout: lines.join("\n"), stderr: "" };
}
