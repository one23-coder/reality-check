/** Scenario validation + adapter capability gate (阶段3 MCP 入口).
 *
 * Reimplements the CLI `check` gate (packages/cli/src/commands/check.ts) on
 * top of @rc/protocol + @rc/adapter-local-web ONLY: validateScenario, then
 * the adapter manifest via createLocalWebAdapter({...}).manifest() — a static
 * metadata read, NO app spawn. Any gap is a config-class tool error BEFORE a
 * run directory or environment exists (方案 §5 第 1 步语义).
 */
import fs from "node:fs";
import {
  SCENARIO_VERSION,
  isSupportedScenarioVersion,
  parseJsonStrict,
  validateScenario,
  type AdapterManifest,
  type Scenario,
} from "@rc/protocol";
import { createLocalWebAdapter } from "@rc/adapter-local-web";

/** Error class for config-class tool failures (scenario invalid, capability
 * gap, missing run). Surfaced as MCP tool result isError:true — never as a
 * crashed server loop. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** fs read + BOM-strict JSON parse + protocol validation. */
export function loadScenarioFile(scenarioPath: string): Scenario {
  let text: string;
  try {
    text = fs.readFileSync(scenarioPath, "utf8");
  } catch {
    throw new ToolError(`scenario file not found: ${scenarioPath}`);
  }
  let value: unknown;
  try {
    value = parseJsonStrict(text, scenarioPath);
  } catch (e) {
    throw new ToolError(e instanceof Error ? e.message : String(e));
  }
  try {
    return validateScenario(value);
  } catch (e) {
    throw new ToolError(
      `invalid scenario ${scenarioPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Same checks as the kernel's pre-run gate and CLI check; kept in sync by
 * construction (both descend from 方案 §9 结构校验 → 适配能力检查). */
export function checkCapabilities(scenario: Scenario, manifest: AdapterManifest): void {
  if (!isSupportedScenarioVersion(String(scenario.protocol.scenario))) {
    throw new ToolError(
      `scenario protocol ${String(scenario.protocol.scenario)} not supported (expected ${SCENARIO_VERSION})`,
    );
  }
  for (const step of scenario.steps) {
    if (!manifest.supportedOps.includes(step.op)) {
      throw new ToolError(
        `adapter "${manifest.adapterId}" does not support step op "${step.op}" (step ${step.id})`,
      );
    }
  }
  for (const a of scenario.assertions) {
    if (!manifest.supportedAssertions.includes(a.op)) {
      throw new ToolError(
        `adapter "${manifest.adapterId}" does not support assertion op "${a.op}" (assertion ${a.id})`,
      );
    }
  }
  const scenarioObservers = new Set(scenario.observers.map((o) => o.id));
  for (const a of scenario.assertions) {
    if (!scenarioObservers.has(a.observer)) {
      throw new ToolError(`assertion "${a.id}" references unknown observer "${a.observer}"`);
    }
    if (manifest.observers[a.observer] === undefined) {
      throw new ToolError(`observer "${a.observer}" is not declared by adapter "${manifest.adapterId}"`);
    }
  }
  for (const o of scenario.observers) {
    for (const table of o.tables) {
      if (!manifest.observedTables.includes(table)) {
        throw new ToolError(`observer "${o.id}" reads table "${table}" outside the adapter whitelist`);
      }
    }
  }
  if (scenario.steps.some((s) => s.barrier === true) && !manifest.barriers) {
    throw new ToolError(`scenario uses barrier steps but adapter "${manifest.adapterId}" cannot`);
  }
}

/** rc_check body: validate + capability-gate WITHOUT spawning the app. */
export function checkScenario(scenarioPath: string, appEntry: string | undefined): {
  valid: true;
  scenarioId: string;
  name: string;
  steps: number;
  observers: number;
  assertions: number;
  adapter: { adapterId: string; adapterVersion: string; scenarioVersion: string };
} {
  const scenario = loadScenarioFile(scenarioPath);
  // appPath is a placeholder until setupEnv; manifest() is static metadata.
  // 观察器口径必须能被读到：能力门禁要核对场景的观察器/表白名单，用 fixture 预设
  // 去替第三方应用"过门"比过不了门更糟——它会放行一份永远跑不起来的场景。
  let manifest: ReturnType<ReturnType<typeof createLocalWebAdapter>["manifest"]>;
  try {
    manifest = createLocalWebAdapter({ appPath: appEntry ?? "unknown" }).manifest();
  } catch (e) {
    throw new ToolError(
      `cannot gate this scenario against the app's observer declarations: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  checkCapabilities(scenario, manifest);
  return {
    valid: true,
    scenarioId: scenario.id,
    name: scenario.name,
    steps: scenario.steps.length,
    observers: scenario.observers.length,
    assertions: scenario.assertions.length,
    adapter: {
      adapterId: manifest.adapterId,
      adapterVersion: manifest.adapterVersion,
      scenarioVersion: manifest.scenarioVersion,
    },
  };
}
