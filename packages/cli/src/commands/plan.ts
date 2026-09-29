/** `reality-check plan "<自然语言描述>"` — 受限规划器入口 (方案 §3.3 规则 9).
 *
 * Loads every saved scenario from scenariosDir (validating each), asks the
 * planner to pick one, and prints the decision. The planner's single throw
 * (no scenarios available and model required) maps to exit 64; planning
 * itself never guesses a default scenario without a category clue.
 */
import type { PlanDecision } from "@rc/planner";
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

  let decision: PlanDecision;
  try {
    decision = await planScenario({ request, savedScenarios });
  } catch (e) {
    // The planner's ONLY throw: no scenario available and model required.
    throw configError(`planning failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const stdout = [
    `plan: scenario=${decision.scenario.id}`,
    `params=${JSON.stringify(decision.params)}`,
    `fallback=${decision.fallback}`,
    `needsModel=${decision.needsModel}`,
    `reason=${decision.reason}`,
  ].join("\n");
  return { code: 0, stdout, stderr: "" };
}
