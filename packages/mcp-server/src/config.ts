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
import { checkToolsConfig, parseJsonStrict } from "@rc/protocol";

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
 * operation, e.g. rc_check, still works). Invalid JSON/BOM, a wrong tools
 * version or an unknown adapter.module are hard errors — parity with the CLI's
 * exit-64 path (the file's absence is tolerated only here, because the MCP
 * server can be driven by constructor opts alone). */
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
  // 版本与适配器白名单的判定与 CLI 共用同一份实现（@rc/protocol/tools-config）。
  // 此前这里整段忽略 `tools`/`adapter.module`：同一份配置 CLI 判 exit 64、
  // MCP 照跑不误，与「三入口一致」直接矛盾。
  const problems = checkToolsConfig(value, file, { requireTools: true });
  if (problems.length > 0) throw new Error(problems.join("; "));
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
