/** `reality-check export [--format json]` — 导出历史运行 + 复跑入口 (方案 §5 第 5 步).
 *
 * Lists every run directory under runsDir that carries a result.json, sorted
 * by startedAt; the text format prints one `reality-check rerun --run-id`
 * line per run so the user can re-execute after a fix.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import {
  configError,
  flagString,
  loadConfig,
  parseArgs,
  type CommandResult,
  toCommandResult,
} from "../config.js";

export interface ExportedRun {
  runId: string;
  scenarioId: string;
  verdict: string;
  startedAt: string;
}

export async function listRuns(runsDir: string): Promise<ExportedRun[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(runsDir);
  } catch {
    return []; // no runs yet — an empty export is not an error
  }
  const runs: ExportedRun[] = [];
  for (const entry of entries) {
    const file = path.join(runsDir, entry, "result.json");
    let value: unknown;
    try {
      value = JSON.parse(await fsp.readFile(file, "utf8"));
    } catch {
      continue; // directory without a readable result.json is not a run
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const r = value as Record<string, unknown>;
    if (typeof r.runId !== "string" || typeof r.verdict !== "string") continue;
    runs.push({
      runId: r.runId,
      scenarioId: typeof r.scenarioId === "string" ? r.scenarioId : "unknown",
      verdict: r.verdict,
      startedAt: typeof r.startedAt === "string" ? r.startedAt : "",
    });
  }
  return runs.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
}

/** Wrapper: maps any thrown config/internal error onto the exit-code
 * contract (64/70) so the command always resolves to a CommandResult. */
export async function exportCommand(args: string[]): Promise<CommandResult> {
  try {
    return await exportCommandImpl(args);
  } catch (e) {
    return toCommandResult(e);
  }
}

async function exportCommandImpl(args: string[]): Promise<CommandResult> {
  const parsed = parseArgs(args);
  if (parsed.positionals.length > 0) {
    throw configError("usage: reality-check export [--format json]");
  }
  const format = flagString(parsed, "format") ?? "text";
  if (format !== "text" && format !== "json") {
    throw configError(`--format must be "text" or "json", got "${format}"`);
  }
  const config = loadConfig(flagString(parsed, "config"));
  const runs = await listRuns(config.runsDir);

  if (format === "json") {
    return { code: 0, stdout: JSON.stringify(runs, null, 2), stderr: "" };
  }

  const lines: string[] = [];
  if (runs.length === 0) {
    lines.push(`no runs found under ${config.runsDir}`);
  } else {
    lines.push("runId\tscenario\tverdict\tstartedAt");
    for (const r of runs) {
      lines.push(`${r.runId}\t${r.scenarioId}\t${r.verdict}\t${r.startedAt}`);
      lines.push(`  reality-check rerun --run-id ${r.runId}`);
    }
  }
  return { code: 0, stdout: lines.join("\n"), stderr: "" };
}
