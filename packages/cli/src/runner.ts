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

/** Adapter construction is a CONFIG concern: a missing/malformed observers file
 * must surface as a configuration error (exit 64), not an opaque tool failure. */
export function buildAdapter(opts: LocalWebAdapterOptions): ReturnType<typeof createLocalWebAdapter> {
  try {
    return createLocalWebAdapter(opts);
  } catch (e) {
    throw configError(e instanceof Error ? e.message : String(e));
  }
}

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
  /** Non-fatal problems from sidecar/report post-processing. Printed on stderr;
   * they must never replace the verdict's exit code (see `runOnce`). */
  warnings: string[];
}

export interface RunOnceOptions {
  config: RcConfig;
  /** Absolute path to the scenario JSON. */
  scenarioPath: string;
  seed?: number;
  /** --fault override; falls back to config.app.faultEnv. */
  fault?: string;
  previousRunId?: string;
  /** Live progress hook, forwarded to the kernel (CLI `--verbose`). */
  onEvent?: (event: TimelineEvent) => void;
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

export async function readEvents(
  runDir: string,
): Promise<{ events: TimelineEvent[]; warnings: string[] }> {
  let text: string;
  try {
    text = await fsp.readFile(path.join(runDir, "events.jsonl"), "utf8");
  } catch (e) {
    throw new Error(
      `events.jsonl unreadable under ${runDir}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const events: TimelineEvent[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as TimelineEvent);
    } catch {
      // 单行损坏不足以否掉整次运行的结论，但必须在 stderr 上说出来。
      skipped++;
    }
  }
  const warnings: string[] = [];
  if (skipped > 0)
    warnings.push(`events.jsonl 有 ${skipped} 行无法解析，已跳过（报告里会少这 ${skipped} 个事件）`);
  return { events, warnings };
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
  // 观察器属于**应用**（规则 2「单一口径」的提供者是适配器/应用配置）。路径来自
  // 配置即配置错误（exit 64），而不是当作工具异常。
  if (config.adapter.observers !== undefined) adapterOpts.observersFile = config.adapter.observers;
  const adapter = buildAdapter(adapterOpts);

  const execOpts: {
    runsRoot: string;
    seed?: number;
    onEvent?: (event: TimelineEvent) => void;
  } = { runsRoot: config.runsDir };
  if (opts.seed !== undefined) execOpts.seed = opts.seed;
  if (opts.onEvent !== undefined) execOpts.onEvent = opts.onEvent;

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
  const warnings = await writeRunArtifacts({
    config,
    runId: result.runId,
    result,
    scenarioPath: opts.scenarioPath,
    ...(opts.previousRunId !== undefined ? { previousRunId: opts.previousRunId } : {}),
  });

  return { result, scenario, runDir, warnings };
}

/** 侧车 + 报告：把一次运行的**呈现**写进 run 目录。
 *
 * 结论与呈现分离：内核已经把结论写进 result.json 了，所以这里失败**不能**把一次真实
 * 结论（尤其 failed / exit 1）变成 exit 70 的工具错误——那会让 CI 把真实回归当成环境
 * 抖动。这类失败以 warning 返回，不抛、不改退出码，但必须在 stderr 上说出来。
 */
export async function writeRunArtifacts(opts: {
  config: RcConfig;
  runId: string;
  result: RunResult;
  scenarioPath: string;
  previousRunId?: string;
}): Promise<string[]> {
  const runDir = path.join(opts.config.runsDir, opts.runId);
  const warnings: string[] = [];
  try {
    const meta: CliRunMeta = { scenarioPath: path.resolve(opts.scenarioPath), seed: opts.result.seed };
    if (opts.previousRunId !== undefined) meta.previousRunId = opts.previousRunId;
    await fsp.writeFile(
      cliMetaPath(opts.config, opts.runId),
      JSON.stringify(meta, null, 2),
      "utf8",
    );

    const { events, warnings: eventWarnings } = await readEvents(runDir);
    warnings.push(...eventWarnings);
    const reporter = (await import("@rc/reporter")) as {
      renderJsonReport(result: RunResult, events: TimelineEvent[]): string;
      renderHtmlReport(result: RunResult, events: TimelineEvent[]): string;
    };
    await fsp.writeFile(
      path.join(runDir, "report.json"),
      reporter.renderJsonReport(opts.result, events),
      "utf8",
    );
    await fsp.writeFile(
      path.join(runDir, "report.html"),
      reporter.renderHtmlReport(opts.result, events),
      "utf8",
    );
  } catch (e) {
    warnings.push(
      `结论已落盘（${path.join(runDir, "result.json")}），但侧车/报告写入失败：${e instanceof Error ? e.message : String(e)}；该运行的 rerun 与 export --pack 可能不可用`,
    );
  }
  return warnings;
}

export { VERDICT_EXIT };
