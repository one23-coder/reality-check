/** Shared run pipeline for `run` and `rerun` (方案 §5 用户路径 3-5).
 *
 * executeScenario() (core) owns the run dir + artifacts; the CLI adds the
 * rerun sidecar `cli.json` ({scenarioPath, seed, previousRunId?}) AFTER the
 * result exists, then renders HTML/JSON reports into the same run dir.
 * Reporter is imported dynamically so report rendering stays an optional
 * concern of the run pipeline.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import {
  VERDICT_EXIT,
  type RunResult,
  type Scenario,
  type TimelineEvent,
} from "@rc/protocol";
import { executeScenario, isRunError } from "@rc/core";
import { createLocalWebAdapter, type LocalWebAdapterOptions } from "@rc/adapter-local-web";
import { CliError, configError, internalError, loadScenarioFile, type RcConfig } from "./config.js";

/** Sidecar the CLI writes for `rerun` — core's run.json intentionally does
 * NOT carry the scenario path, so the CLI records it here. */
export interface CliRunMeta {
  scenarioPath: string;
  seed: number;
  previousRunId?: string;
}

export interface RunOutcome {
  result: RunResult;
  scenario: Scenario;
  runDir: string;
}

export interface RunOnceOptions {
  config: RcConfig;
  /** Absolute path to the scenario JSON. */
  scenarioPath: string;
  seed?: number;
  /** --fault override; falls back to config.app.faultEnv. */
  fault?: string;
  previousRunId?: string;
}

export function cliMetaPath(config: RcConfig, runId: string): string {
  return path.join(config.runsDir, runId, "cli.json");
}

export async function readCliMeta(config: RcConfig, runId: string): Promise<CliRunMeta> {
  let text: string;
  try {
    text = await fsp.readFile(cliMetaPath(config, runId), "utf8");
  } catch {
    throw configError(`run "${runId}" has no cli.json under ${config.runsDir}; nothing to rerun`);
  }
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw configError(`cli.json of run "${runId}" is not an object`);
  }
  const meta = value as { scenarioPath?: unknown; seed?: unknown; previousRunId?: unknown };
  if (typeof meta.scenarioPath !== "string" || typeof meta.seed !== "number") {
    throw configError(`cli.json of run "${runId}" lacks scenarioPath/seed`);
  }
  const out: CliRunMeta = { scenarioPath: meta.scenarioPath, seed: meta.seed };
  if (typeof meta.previousRunId === "string") out.previousRunId = meta.previousRunId;
  return out;
}

export async function readVerdictFromResult(config: RcConfig, runId: string): Promise<string> {
  try {
    const text = await fsp.readFile(path.join(config.runsDir, runId, "result.json"), "utf8");
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const verdict = (value as { verdict?: unknown }).verdict;
      if (typeof verdict === "string") return verdict;
    }
  } catch {
    // result.json unreadable -> reported as "unknown"
  }
  return "unknown";
}

export async function readEvents(runDir: string): Promise<TimelineEvent[]> {
  const text = await fsp.readFile(path.join(runDir, "events.jsonl"), "utf8");
  const events: TimelineEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    events.push(JSON.parse(line) as TimelineEvent);
  }
  return events;
}

/** One full execution: scenario load -> adapter -> kernel -> cli.json sidecar
 * -> reports. Throws CliError (64/70) on config/internal problems; verdicts
 * (0/1/2/3) are returned inside result, never thrown. */
export async function runOnce(opts: RunOnceOptions): Promise<RunOutcome> {
  const { config } = opts;
  const scenario = loadScenarioFile(opts.scenarioPath);

  const adapterOpts: LocalWebAdapterOptions = { appPath: config.app.entry };
  const faultEnv = opts.fault ?? config.app.faultEnv;
  if (faultEnv !== undefined && faultEnv !== "") adapterOpts.faultEnv = faultEnv;
  const adapter = createLocalWebAdapter(adapterOpts);

  const execOpts: { runsRoot: string; seed?: number } = { runsRoot: config.runsDir };
  if (opts.seed !== undefined) execOpts.seed = opts.seed;

  let result: RunResult;
  try {
    result = await executeScenario(scenario, adapter, execOpts);
  } catch (e) {
    // RunError kinds map verbatim onto the exit-code contract:
    // kind "config" -> 64, kind "internal" -> 70.
    if (isRunError(e)) throw new CliError(e.exitCode, e.message);
    throw internalError("executeScenario failed", e);
  }

  const runDir = path.join(config.runsDir, result.runId);
  const meta: CliRunMeta = { scenarioPath: path.resolve(opts.scenarioPath), seed: result.seed };
  if (opts.previousRunId !== undefined) meta.previousRunId = opts.previousRunId;
  await fsp.writeFile(cliMetaPath(config, result.runId), JSON.stringify(meta, null, 2), "utf8");

  const events = await readEvents(runDir);
  const reporter = (await import("@rc/reporter")) as {
    renderJsonReport(result: RunResult, events: TimelineEvent[]): string;
    renderHtmlReport(result: RunResult, events: TimelineEvent[]): string;
  };
  await fsp.writeFile(path.join(runDir, "report.json"), reporter.renderJsonReport(result, events), "utf8");
  await fsp.writeFile(path.join(runDir, "report.html"), reporter.renderHtmlReport(result, events), "utf8");

  return { result, scenario, runDir };
}

export { VERDICT_EXIT };
