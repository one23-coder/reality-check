/** `reality-check rerun --run-id <id>` — 同条件复跑 (方案 §5 用户路径第 5 步).
 *
 * Reads the previous run's cli.json sidecar (scenarioPath + seed, recorded by
 * `run`), re-executes the SAME scenario with the SAME seed into a NEW run
 * dir, and prints previous vs. now so a business fix shows up as a verdict
 * change. Exit code = the NEW verdict's code.
 */
import path from "node:path";
import { VERDICT_EXIT, runIdProblem, type TimelineEvent } from "@rc/protocol";
import { streamEventLine, verdictLines } from "../format.js";
import {
  configError,
  flagString,
  loadConfig,
  parseArgs,
  type CommandResult,
  toCommandResult,
} from "../config.js";
import { readCliMeta, readVerdictFromResult, runOnce } from "../runner.js";

/** Wrapper: maps any thrown config/internal error onto the exit-code
 * contract (64/70) so the command always resolves to a CommandResult. */
export async function rerunCommand(args: string[]): Promise<CommandResult> {
  try {
    return await rerunCommandImpl(args);
  } catch (e) {
    return toCommandResult(e);
  }
}

async function rerunCommandImpl(args: string[]): Promise<CommandResult> {
  const parsed = parseArgs(args);
  const runId = flagString(parsed, "run-id");
  if (runId === undefined) {
    throw configError("usage: reality-check rerun --run-id <id>");
  }
  const badRunId = runIdProblem(runId);
  if (badRunId !== null) throw configError(badRunId);
  const config = loadConfig(flagString(parsed, "config"));

  const meta = await readCliMeta(config, runId);
  const previousVerdict = await readVerdictFromResult(config, runId);
  const verbose = parsed.flags.get("verbose") === true || parsed.flags.get("verbose") === "true";

  const { result, warnings } = await runOnce({
    config,
    scenarioPath: meta.scenarioPath,
    seed: meta.seed,
    previousRunId: runId,
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
    stdout: [
      `rerun ${result.runId} (prev ${runId}): previous=${previousVerdict} now=${result.verdict}`,
      ...verdictLines(result, { verbose, runDir: path.join(config.runsDir, result.runId) }).slice(1),
    ].join("\n"),
    stderr: warnings.map((w) => `warning: ${w}`).join("\n"),
  };
}
