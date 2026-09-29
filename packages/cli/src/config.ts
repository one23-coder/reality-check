/** CLI configuration + shared loading helpers (方案 §5 用户路径第 1 步).
 *
 * `.reality-check.json` (cwd or --config) declares the app under test, the
 * adapter module, and where runs/scenarios live. Every problem here is a
 * CONFIG error (exit 64): missing file, BOM'd JSON (parseJsonStrict rejects
 * it — docs §0), schema violation, version mismatch, wrong adapter module.
 */
import fs from "node:fs";
import path from "node:path";
import {
  TOOLS_VERSION,
  VError,
  parseJsonStrict,
  validateScenario,
  vLiteral,
  vObject,
  vString,
  type Scenario,
} from "@rc/protocol";

/** Commands are pure: they take argv and return a result object; main.ts
 * maps it onto process streams + process.exit, tests call them directly. */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** CLI-level error with a known exit code (64 config / 70 internal). */
export class CliError extends Error {
  readonly code: 64 | 70;
  constructor(code: 64 | 70, message: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

export function configError(message: string): CliError {
  return new CliError(64, message);
}

export function internalError(message: string, cause?: unknown): CliError {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return new CliError(70, `${message}${detail}`);
}

/** Map any thrown value onto the exit-code contract (0/1/2/3 verdicts never
 * come through here — this is the 64/70 path). */
export function toCommandResult(e: unknown): CommandResult {
  if (e instanceof CliError) return { code: e.code, stdout: "", stderr: e.message };
  if (e instanceof VError) return { code: 64, stdout: "", stderr: e.message };
  const message = e instanceof Error ? e.message : String(e);
  return { code: 70, stdout: "", stderr: `internal error: ${message}` };
}

// ------------------------------------------------------------------ args

export interface ParsedArgs {
  flags: Map<string, string | true>;
  positionals: string[];
}

/** `--key value`, `--key=value`, bare `--flag` (true). */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(arg.slice(2), next);
          i++;
        } else {
          flags.set(arg.slice(2), true);
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

export function flagInt(args: ParsedArgs, name: string): number | undefined {
  const v = flagString(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || String(n) !== v) {
    throw configError(`--${name} must be a non-negative integer, got "${v}"`);
  }
  return n;
}

// ------------------------------------------------------------------ config

/** The `@reality-check/adapter-local-web` workspace package has historically
 * also been referenced as `@rc/adapter-local-web` in docs; both are accepted. */
export const ADAPTER_MODULES = ["@reality-check/adapter-local-web", "@rc/adapter-local-web"] as const;

export interface RcConfig {
  tools: typeof TOOLS_VERSION;
  app: { kind: "local-web"; entry: string; faultEnv?: string };
  adapter: { module: string };
  runsDir: string;
  scenariosDir: string;
}

const configV = vObject<RcConfig>({
  required: {
    tools: vLiteral(TOOLS_VERSION),
    app: vObject<RcConfig["app"]>({
      required: { kind: vLiteral("local-web"), entry: vString },
      optional: { faultEnv: vString },
    }),
    adapter: vObject<RcConfig["adapter"]>({
      required: { module: vString },
    }),
    runsDir: vString,
    scenariosDir: vString,
  },
});

export function configPathFromCwd(): string {
  return path.join(process.cwd(), ".reality-check.json");
}

export function loadConfig(explicitPath?: string): RcConfig {
  const file = explicitPath ?? configPathFromCwd();
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw configError(`config file not found: ${file} (pass --config or create .reality-check.json)`);
  }
  let value: unknown;
  try {
    value = parseJsonStrict(text, file);
  } catch (e) {
    throw configError(e instanceof Error ? e.message : String(e));
  }
  let cfg: RcConfig;
  try {
    cfg = configV(value, file);
  } catch (e) {
    throw configError(e instanceof Error ? e.message : String(e));
  }
  if (!(ADAPTER_MODULES as readonly string[]).includes(cfg.adapter.module)) {
    throw configError(
      `${file}: adapter.module must be one of [${ADAPTER_MODULES.join("|")}], got "${cfg.adapter.module}"`,
    );
  }
  const cwd = process.cwd();
  return {
    ...cfg,
    app: { ...cfg.app, entry: path.resolve(cwd, cfg.app.entry) },
    runsDir: path.resolve(cwd, cfg.runsDir),
    scenariosDir: path.resolve(cwd, cfg.scenariosDir),
  };
}

// ------------------------------------------------------------------ scenarios

export function loadScenarioFile(scenarioPath: string): Scenario {
  let text: string;
  try {
    text = fs.readFileSync(scenarioPath, "utf8");
  } catch {
    throw configError(`scenario file not found: ${scenarioPath}`);
  }
  let value: unknown;
  try {
    value = parseJsonStrict(text, scenarioPath);
  } catch (e) {
    throw configError(e instanceof Error ? e.message : String(e));
  }
  try {
    return validateScenario(value);
  } catch (e) {
    throw configError(`invalid scenario ${scenarioPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Every *.json directly under scenariosDir, validated (a bad scenario file
 * is a config error — exit 64 — never silently skipped). */
export function loadScenarioDir(scenariosDir: string): Scenario[] {
  let names: string[];
  try {
    names = fs.readdirSync(scenariosDir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    throw configError(`scenarios directory not found: ${scenariosDir}`);
  }
  return names.map((n) => loadScenarioFile(path.join(scenariosDir, n)));
}
