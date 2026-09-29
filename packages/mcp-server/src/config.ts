/** MCP server configuration (阶段3 §7: MCP 入口与 CLI 同一配置语义).
 *
 * Defaults come from `.reality-check.json` at the server process cwd when it
 * exists (same file the CLI reads, same BOM-strict parsing); constructor
 * opts override individual fields. Paths are resolved against cwd exactly
 * like packages/cli/src/config.ts does, so the same config file yields the
 * same runsDir/scenariosDir/appEntry through both entrances (方案 §7 审查:
 * 同一配置经 CLI、MCP、CI 三入口运行，结果语义一致).
 */
import fs from "node:fs";
import path from "node:path";
import { parseJsonStrict } from "@rc/protocol";

export interface McpServerOptions {
  /** Where run directories are created (resolved against cwd). */
  runsDir?: string;
  /** Default directory for scenario lookups (resolved against cwd). */
  scenariosDir?: string;
  /** App-under-test entry script (resolved against cwd). */
  appEntry?: string;
  /** RC_FAULT override applied when a tool call does not pass one. */
  faultEnv?: string;
}

export interface McpConfig {
  runsDir: string;
  scenariosDir: string;
  /** Undefined only when neither opts nor the config file provide it. */
  appEntry?: string;
  faultEnv?: string;
}

const CONFIG_FILENAME = ".reality-check.json";

/** Read `.reality-check.json` at cwd if present; tolerate absence (opts-only
 * operation, e.g. rc_check, still works). Invalid JSON/BOM is a hard error —
 * parity with the CLI's exit-64 path. */
function readCwdConfigFile(cwd: string): Partial<McpServerOptions> {
  const file = path.join(cwd, CONFIG_FILENAME);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  let value: unknown;
  try {
    value = parseJsonStrict(text, file);
  } catch (e) {
    throw new Error(`${CONFIG_FILENAME} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${CONFIG_FILENAME} is not a JSON object`);
  }
  const raw = value as {
    app?: { entry?: unknown; faultEnv?: unknown };
    runsDir?: unknown;
    scenariosDir?: unknown;
  };
  const out: Partial<McpServerOptions> = {};
  if (typeof raw.runsDir === "string") out.runsDir = raw.runsDir;
  if (typeof raw.scenariosDir === "string") out.scenariosDir = raw.scenariosDir;
  if (typeof raw.app?.entry === "string") out.appEntry = raw.app.entry;
  if (typeof raw.app?.faultEnv === "string") out.faultEnv = raw.app.faultEnv;
  return out;
}

/** Merge order: opts > config file. Empty-string faultEnv means "no fault" in
 * the CLI; keep that convention and drop it here too. */
export function loadMcpConfig(opts: McpServerOptions = {}, cwd: string = process.cwd()): McpConfig {
  const fileOpts = readCwdConfigFile(cwd);
  const merged: McpServerOptions = { ...fileOpts, ...opts };
  const faultEnv = merged.faultEnv;

  const config: McpConfig = {
    runsDir: path.resolve(cwd, merged.runsDir ?? "runs"),
    scenariosDir: path.resolve(cwd, merged.scenariosDir ?? "scenarios"),
  };
  if (merged.appEntry !== undefined) config.appEntry = path.resolve(cwd, merged.appEntry);
  if (faultEnv !== undefined && faultEnv !== "") config.faultEnv = faultEnv;
  return config;
}
