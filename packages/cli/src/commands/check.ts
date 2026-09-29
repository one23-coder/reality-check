/** `reality-check check <scenario.json>` — 结构校验 + 能力检查 (方案 §5 第 1 步).
 *
 * Validates the scenario against protocol 1.0, then gates it against the
 * adapter manifest WITHOUT spawning the app: manifest() is callable before
 * setupEnv. Any capability gap is a config error (exit 64) BEFORE a run
 * directory or environment ever exists.
 */
import {
  SCENARIO_VERSION,
  type AdapterManifest,
  type Scenario,
} from "@rc/protocol";
import { createLocalWebAdapter } from "@rc/adapter-local-web";
import {
  flagString,
  loadConfig,
  loadScenarioFile,
  parseArgs,
  type CommandResult,
  configError,
  toCommandResult,
} from "../config.js";

export function checkCapabilities(scenario: Scenario, manifest: AdapterManifest): void {
  if (scenario.protocol.scenario !== SCENARIO_VERSION) {
    throw configError(
      `scenario protocol ${String(scenario.protocol.scenario)} not supported (expected ${SCENARIO_VERSION})`,
    );
  }
  for (const step of scenario.steps) {
    if (!manifest.supportedOps.includes(step.op)) {
      throw configError(
        `adapter "${manifest.adapterId}" does not support step op "${step.op}" (step ${step.id})`,
      );
    }
  }
  for (const a of scenario.assertions) {
    if (!manifest.supportedAssertions.includes(a.op)) {
      throw configError(
        `adapter "${manifest.adapterId}" does not support assertion op "${a.op}" (assertion ${a.id})`,
      );
    }
  }
  const scenarioObservers = new Set(scenario.observers.map((o) => o.id));
  for (const a of scenario.assertions) {
    if (!scenarioObservers.has(a.observer)) {
      throw configError(`assertion "${a.id}" references unknown observer "${a.observer}"`);
    }
    if (manifest.observers[a.observer] === undefined) {
      throw configError(
        `observer "${a.observer}" is not declared by adapter "${manifest.adapterId}"`,
      );
    }
  }
  for (const o of scenario.observers) {
    for (const table of o.tables) {
      if (!manifest.observedTables.includes(table)) {
        throw configError(
          `observer "${o.id}" reads table "${table}" outside the adapter whitelist`,
        );
      }
    }
  }
  if (scenario.steps.some((s) => s.barrier === true) && !manifest.barriers) {
    throw configError(`scenario uses barrier steps but adapter "${manifest.adapterId}" cannot`);
  }
}

/** Wrapper: maps any thrown config/internal error onto the exit-code
 * contract (64/70) so the command always resolves to a CommandResult. */
export async function checkCommand(args: string[]): Promise<CommandResult> {
  try {
    return await checkCommandImpl(args);
  } catch (e) {
    return toCommandResult(e);
  }
}

async function checkCommandImpl(args: string[]): Promise<CommandResult> {
  const parsed = parseArgs(args);
  const scenarioPath = parsed.positionals[0];
  if (scenarioPath === undefined || parsed.positionals.length !== 1) {
    throw configError("usage: reality-check check <scenario.json>");
  }
  const scenario = loadScenarioFile(scenarioPath);
  const config = loadConfig(flagString(parsed, "config"));

  // NO spawn: manifest() is static metadata, callable before setupEnv — the
  // app entry path may even be a placeholder here.
  const adapter = createLocalWebAdapter({ appPath: config.app.entry });
  const manifest = adapter.manifest();
  checkCapabilities(scenario, manifest);

  const ops = new Set(scenario.steps.map((s) => s.op)).size;
  const stdout = [
    `check: OK scenario=${scenario.id} app=${scenario.app} ops=${ops} ` +
      `observers=${scenario.observers.length} assertions=${scenario.assertions.length}`,
  ].join("\n");
  return { code: 0, stdout, stderr: "" };
}
