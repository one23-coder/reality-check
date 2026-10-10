/** `reality-check plan "<自然语言描述>"` — 受限规划器入口 (方案 §3.3 规则 9).
 *
 * Loads every saved scenario from scenariosDir (validating each), asks the
 * planner to pick one, and prints the decision. Two-layer exit contract:
 * - NO saved scenario at all is a configuration error (exit 64) — there is
 *   nothing the tool could ever run;
 * - saved scenarios exist but there is no category clue and no usable model:
 *   nothing is chosen (needsModel=true) and the output says so — a default is
 *   never guessed, and an empty selection is not dressed up as an error.
 */
import { planScenario } from "@rc/planner";
import {
  configError,
  flagString,
  loadConfig,
  loadScenarioDir,
  parseArgs,
  type CommandResult,
  toCommandResult,
} from "../config.js";

/** Wrapper: maps any thrown config/internal error onto the exit-code
 * contract (64/70) so the command always resolves to a CommandResult. */
export async function planCommand(args: string[]): Promise<CommandResult> {
  try {
    return await planCommandImpl(args);
  } catch (e) {
    return toCommandResult(e);
  }
}

async function planCommandImpl(args: string[]): Promise<CommandResult> {
  const parsed = parseArgs(args);
  const request = parsed.positionals[0];
  if (request === undefined || parsed.positionals.length !== 1) {
    throw configError('usage: reality-check plan "<自然语言描述>"');
  }
  const config = loadConfig(flagString(parsed, "config"));
  const savedScenarios = loadScenarioDir(config.scenariosDir);
  // Layer 1: an empty scenarios dir is a configuration error (exit 64) — the
  // tool is being asked to plan against a project it has nothing to run on.
  if (savedScenarios.length === 0)
    throw configError(
      `planning failed: no scenario available in ${config.scenariosDir}; add a scenario first`,
    );

  const decision = await planScenario({ request, savedScenarios });

  const stdout = [
    decision.scenario !== undefined
      ? `plan: scenario=${decision.scenario.id}`
      : "plan: no scenario chosen (no category clue and no usable model; a default is never guessed)",
    `params=${JSON.stringify(decision.params)}`,
    `fallback=${decision.fallback}`,
    `needsModel=${decision.needsModel}`,
    `reason=${decision.reason}`,
  ].join("\n");
  return { code: 0, stdout, stderr: "" };
}
